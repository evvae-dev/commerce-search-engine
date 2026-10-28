import { elasticClient } from './elastic-client';
import { searchTimeout, withSharedSearchBudget } from './search-budget';

const FAILURE_TTL_MS = 30 * 1000;
const MAX_CACHE_ENTRIES = 10;
const MAX_SOURCE_SCAN = 250_000;
const CATEGORY_FIELDS = ['up_disp_clsf_nm'] as const;

export interface CategoryCatalog {
  categories: string[];
  paths: Array<{ path: string; field: string }>;
  complete: boolean;
  loadMethod: 'aggregation' | 'source_scan' | 'failed';
}

export interface CategoryCatalogResult extends CategoryCatalog {
  cacheStatus: 'hit' | 'miss' | 'shared';
  cacheKey: string;
}

interface CachedCatalog extends CategoryCatalog {
  expiresAt: number;
}

const cache = new Map<string, CachedCatalog>();
const pending = new Map<string, Promise<CategoryCatalog>>();

function addPathSegments(categories: Set<string>, value: unknown): void {
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (typeof item !== 'string') continue;
    for (const segment of item.split('>').map((part) => part.trim()).filter(Boolean)) categories.add(segment);
  }
}

function addPaths(paths: Map<string, { path: string; field: string }>, field: string, value: unknown): void {
  for (const item of Array.isArray(value) ? value : [value]) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const path = item.trim();
    paths.set(`${field}\0${path}`, { path, field });
  }
}

function remember(index: string, value: CategoryCatalog, ttl = Number.POSITIVE_INFINITY): CategoryCatalog {
  cache.delete(index);
  cache.set(index, { ...value, expiresAt: Date.now() + ttl });
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
  return value;
}

async function scanSource(index: string): Promise<CategoryCatalog> {
  const categories = new Set<string>();
  let response = await elasticClient.search<Record<string, unknown>>({
    index,
    size: 1000,
    scroll: '1m',
    sort: ['_doc'],
    query: { match_all: {} },
    _source: [...CATEGORY_FIELDS],
  });
  let scanned = 0;
  let scrollId = response._scroll_id;
  try {
    while (response.hits.hits.length) {
      if (response.timed_out || (response._shards?.failed || 0) > 0) throw new Error('카테고리 목록 조회가 불완전합니다.');
      for (const hit of response.hits.hits) {
        const source = hit._source || {};
        for (const field of CATEGORY_FIELDS) addPathSegments(categories, source[field]);
      }
      scanned += response.hits.hits.length;
      if (!scrollId || scanned >= MAX_SOURCE_SCAN) break;
      response = await elasticClient.scroll({ scroll_id: scrollId, scroll: '1m' }) as typeof response;
      scrollId = response._scroll_id || scrollId;
    }
    if (response.timed_out || (response._shards?.failed || 0) > 0) throw new Error('카테고리 목록 조회가 불완전합니다.');
  } finally {
    if (scrollId) await elasticClient.clearScroll({ scroll_id: scrollId }).catch(() => undefined);
  }
  // _source 필드가 keyword와 같은 정규화 계약인지 보장할 수 없으므로 fallback 결과는 soft 보정에만 사용한다.
  return { categories: [...categories].sort((left, right) => left.localeCompare(right)), paths: [], complete: false, loadMethod: 'source_scan' };
}

async function loadCatalog(index: string): Promise<CategoryCatalog> {
  try {
    const caps = await elasticClient.fieldCaps({
      index,
      fields: CATEGORY_FIELDS.flatMap((field) => [field, `${field}.*`]),
    });
    const aggregateFields = CATEGORY_FIELDS.flatMap((base) => Object.entries(caps.fields || {})
      .filter(([field, types]) => (field === base || field.startsWith(`${base}.`))
        && Object.entries(types).some(([type, capability]) => type === 'keyword' && capability.aggregatable === true))
      .map(([field]) => field));
    if (!aggregateFields.length) return await scanSource(index);

    const aggs = Object.fromEntries(aggregateFields.map((field, position) => [`category_${position}`, { terms: { field, size: 10000 } }]));
    const result = await elasticClient.search({ index, size: 0, track_total_hits: false, query: { match_all: {} }, aggs });
    if (result.timed_out || (result._shards?.failed || 0) > 0 || !result.aggregations) throw new Error('카테고리 목록 조회가 불완전합니다.');
    const categories = new Set<string>();
    const paths = new Map<string, { path: string; field: string }>();
    let complete = true;
    for (const aggregation of Object.values(result.aggregations || {})) {
      const data = aggregation as { buckets?: Array<{ key?: unknown }>; sum_other_doc_count?: number };
      if ((data.sum_other_doc_count || 0) > 0) complete = false;
      const position = Number(String(Object.keys(result.aggregations || {}).find((key) => result.aggregations?.[key] === aggregation) || '').replace('category_', ''));
      const field = aggregateFields[position] || CATEGORY_FIELDS[0];
      for (const bucket of data.buckets || []) {
        addPathSegments(categories, bucket.key);
        addPaths(paths, field, bucket.key);
      }
    }
    return { categories: [...categories].sort((left, right) => left.localeCompare(right)), paths: [...paths.values()], complete, loadMethod: 'aggregation' };
  } catch {
    try {
      return await scanSource(index);
    } catch {
      return { categories: [], paths: [], complete: false, loadMethod: 'failed' };
    }
  }
}

export async function getCategoryCatalog(index: string): Promise<CategoryCatalogResult> {
  const cached = cache.get(index);
  if (cached && cached.expiresAt > Date.now()) {
    cache.delete(index);
    cache.set(index, cached);
    return { ...cached, cacheStatus: 'hit', cacheKey: index };
  }
  if (cached) cache.delete(index);
  const inFlight = pending.get(index);
  if (inFlight) return { ...await inFlight, cacheStatus: 'shared', cacheKey: index };
  const request = withSharedSearchBudget(searchTimeout('SEARCH_ES_TIMEOUT_MS', 5000, 5000), () => loadCatalog(index))
    .then((catalog) => remember(index, catalog, catalog.complete ? Number.POSITIVE_INFINITY : FAILURE_TTL_MS))
    .catch(() => ({ categories: [], paths: [], complete: false, loadMethod: 'failed' as const }))
    .finally(() => pending.delete(index));
  pending.set(index, request);
  return { ...await request, cacheStatus: 'miss', cacheKey: index };
}

export async function getCategoryCatalogForTarget(index: string): Promise<CategoryCatalog> {
  try {
    const resolved = await elasticClient.indices.resolveIndex({ name: index });
    const physicalIndex = resolved.indices?.[0]?.name || resolved.aliases?.[0]?.indices?.[0] || index;
    return getCategoryCatalog(physicalIndex);
  } catch {
    return getCategoryCatalog(index);
  }
}
