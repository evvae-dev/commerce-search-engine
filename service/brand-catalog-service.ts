import { elasticClient } from './elastic-client';
import { searchTimeout, withSharedSearchBudget } from './search-budget';

const FIELDS = ['bnd_nm_ko.keyword', 'bnd_nm_en.keyword'] as const;
const FAILURE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 10;

export interface BrandCatalog {
  entries: Array<{ field: string; value: string }>;
  complete: boolean;
}

export interface BrandCatalogResult extends BrandCatalog {
  cacheStatus: 'hit' | 'miss' | 'shared';
  cacheKey: string;
}

const cache = new Map<string, BrandCatalog & { expiresAt: number }>();
const pending = new Map<string, Promise<BrandCatalog>>();

function remember(index: string, catalog: BrandCatalog): BrandCatalog {
  cache.delete(index);
  cache.set(index, { ...catalog, expiresAt: catalog.complete ? Number.POSITIVE_INFINITY : Date.now() + FAILURE_TTL_MS });
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
  return catalog;
}

async function load(index: string): Promise<BrandCatalog> {
  try {
    const aggs = Object.fromEntries(FIELDS.map((field, position) => [`brand_${position}`, { terms: { field, size: 10_000 } }]));
    const response = await elasticClient.search({ index, size: 0, track_total_hits: false, aggs });
    if (response.timed_out || (response._shards?.failed || 0) > 0 || !response.aggregations) throw new Error('브랜드 목록 조회가 불완전합니다.');
    const entries: BrandCatalog['entries'] = [];
    let complete = true;
    FIELDS.forEach((field, position) => {
      const aggregation = response.aggregations?.[`brand_${position}`] as { buckets?: Array<{ key?: unknown }>; sum_other_doc_count?: number } | undefined;
      if ((aggregation?.sum_other_doc_count || 0) > 0) complete = false;
      for (const bucket of aggregation?.buckets || []) if (typeof bucket.key === 'string' && bucket.key.trim()) entries.push({ field, value: bucket.key });
    });
    return { entries, complete };
  } catch {
    return { entries: [], complete: false };
  }
}

export async function getBrandCatalog(index: string): Promise<BrandCatalogResult> {
  const current = cache.get(index);
  if (current && current.expiresAt > Date.now()) {
    cache.delete(index);
    cache.set(index, current);
    return { ...current, cacheStatus: 'hit', cacheKey: index };
  }
  if (current) cache.delete(index);
  const shared = pending.get(index);
  if (shared) return { ...await shared, cacheStatus: 'shared', cacheKey: index };
  const request = withSharedSearchBudget(searchTimeout('SEARCH_ES_TIMEOUT_MS', 5000, 5000), () => load(index))
    .then((catalog) => remember(index, catalog))
    .catch(() => ({ entries: [], complete: false }))
    .finally(() => pending.delete(index));
  pending.set(index, request);
  return { ...await request, cacheStatus: 'miss', cacheKey: index };
}
