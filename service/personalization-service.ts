import type { Client, estypes } from '@elastic/elasticsearch';
import { elasticClient } from './elastic-client';

import type { PersonalizationConfig } from './personalization-config';
import { withSharedSearchBudget } from './search-budget';

export interface PersonalizationProfile {
  memberNo: string;
  products: Map<string, number>;
  brands: Map<string, number>;
  categories: Map<string, number>;
  sources: Record<SourceName, ProfileMaps>;
  cacheStatus: 'hit' | 'miss' | 'shared' | 'failed';
}

type SourceName = keyof PersonalizationConfig['sources'];
type ProfileMaps = Pick<PersonalizationProfile, 'products' | 'brands' | 'categories'>;
interface SourceDefinition {
  name: SourceName;
  index: string;
  memberField: string;
  dateField: string;
  productField: string;
  brandField: string;
  categoryField: string;
  remainingQuantityField?: string;
}

const DEMO_SOURCES: SourceDefinition[] = (['cart', 'recent', 'wish', 'order'] as const).map((name) => ({
  name, index: `demo-events-${name}`, memberField: 'member_no', dateField: 'occurred_at',
  productField: 'goods_id', brandField: 'bnd_no', categoryField: 'disp_clsf_no',
}));
const cache = new Map<string, { expiresAt: number; profile: PersonalizationProfile }>();
const flights = new Map<string, Promise<PersonalizationProfile | null>>();

function positiveIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function first(source: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function normalizeProductId(value: string): string {
  return value.trim().toUpperCase();
}

function add(map: Map<string, number>, key: string, score: number) {
  if (key) map.set(key, (map.get(key) || 0) + score);
}

function memberQuery(source: SourceDefinition, memberNo: string, days: number): estypes.QueryDslQueryContainer {
  const filter: estypes.QueryDslQueryContainer[] = [
    { term: { [source.memberField]: memberNo } },
    { range: { [source.dateField]: { gte: `now-${days}d/d` } } },
  ];
  if (source.remainingQuantityField) {
    filter.push({ range: { [source.remainingQuantityField]: { gt: 0 } } });
  }
  return { bool: { filter } };
}

function searches(source: SourceDefinition, memberNo: string, days: number): estypes.MsearchRequestItem[] {
  return [
    { index: source.index },
    {
      size: 500,
      track_total_hits: false,
      sort: [{ [source.dateField]: 'desc' }],
      query: memberQuery(source, memberNo, days),
      _source: { includes: [source.productField, source.brandField, source.categoryField] },
    },
  ];
}

function applyHits(maps: ProfileMaps, sourceMaps: ProfileMaps, hits: estypes.SearchHit<Record<string, unknown>>[], sourceWeight: number, sourceDefinition: SourceDefinition) {
  const products = new Set<string>();
  const brands = new Set<string>();
  const categories = new Set<string>();
  for (const hit of hits) {
    const source = hit._source || {};
    products.add(normalizeProductId(first(source, [sourceDefinition.productField])));
    brands.add(first(source, [sourceDefinition.brandField]));
    categories.add(first(source, [sourceDefinition.categoryField]));
  }
  for (const product of products) {
    add(maps.products, product, sourceWeight);
    add(sourceMaps.products, product, sourceWeight);
  }
  for (const brand of brands) {
    add(maps.brands, brand, sourceWeight);
    add(sourceMaps.brands, brand, sourceWeight);
  }
  for (const category of categories) {
    add(maps.categories, category, sourceWeight);
    add(sourceMaps.categories, category, sourceWeight);
  }
}

async function fetchPair(client: Client | null, memberNo: string, entries: SourceDefinition[], config: PersonalizationConfig): Promise<Array<[SourceDefinition, estypes.SearchHit<Record<string, unknown>>[]]> | null> {
  if (!client) return null;
  const result = await client.msearch<Record<string, unknown>>({ searches: entries.flatMap((source) => searches(source, memberNo, config.sources[source.name].days)) });
  return entries.map((source, index) => {
    const response = result.responses[index];
    if (!response || !('hits' in response)) throw new Error(`${source.name} 개인화 인덱스 조회에 실패했습니다.`);
    return [source, response.hits.hits];
  });
}

async function loadProfile(memberNo: string, config: PersonalizationConfig): Promise<PersonalizationProfile | null> {
  const results = await Promise.allSettled([
    fetchPair(elasticClient, memberNo, DEMO_SOURCES, config),
  ]);
  if (results.some((result) => result.status === 'rejected' || result.value === null)) return null;
  const maps: ProfileMaps = { products: new Map(), brands: new Map(), categories: new Map() };
  const sources: Record<SourceName, ProfileMaps> = {
    cart: { products: new Map(), brands: new Map(), categories: new Map() },
    recent: { products: new Map(), brands: new Map(), categories: new Map() },
    wish: { products: new Map(), brands: new Map(), categories: new Map() },
    order: { products: new Map(), brands: new Map(), categories: new Map() },
  };
  for (const result of results) if (result.status === 'fulfilled' && result.value) {
    for (const [source, hits] of result.value) applyHits(maps, sources[source.name], hits, config.sources[source.name].weight, source);
  }
  return { memberNo, ...maps, sources, cacheStatus: 'miss' };
}

export async function getPersonalizationProfile(memberNo: string, targetIndex: string, config: PersonalizationConfig): Promise<PersonalizationProfile | null> {
  const key = `${targetIndex}:${memberNo}:${JSON.stringify(config)}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    cache.delete(key); cache.set(key, cached);
    return { ...cached.profile, cacheStatus: 'hit' };
  }
  const current = flights.get(key);
  if (current) {
    const shared = await current;
    return shared ? { ...shared, cacheStatus: 'shared' } : null;
  }
  const flight = withSharedSearchBudget(800, () => loadProfile(memberNo, config)).catch(() => null);
  flights.set(key, flight);
  try {
    const profile = await flight;
    if (!profile) return null;
    cache.set(key, { profile, expiresAt: Date.now() + config.cacheTtlMs });
    const max = positiveIntegerEnv('PERSONALIZATION_CACHE_MAX_ENTRIES', 5000, 10, 100000);
    while (cache.size > max) cache.delete(cache.keys().next().value as string);
    return profile;
  } finally {
    if (flights.get(key) === flight) flights.delete(key);
  }
}

export function calculatePersonalizationBoost(source: Record<string, unknown>, profile: PersonalizationProfile, config: PersonalizationConfig) {
  const productId = normalizeProductId(first(source, ['goods_id', 'goods_no', 'onl_goods_no']));
  const brandId = first(source, ['bnd_no', 'brd_no', 'brand', 'brand_id']);
  const categoryId = first(source, ['disp_clsf_no', 'up_disp_clsf_no', 'cat', 'category', 'up_disp_clsf_nm', 'disp_clsf_nm']);
  const product = profile.products.get(productId) || 0;
  const brand = profile.brands.get(brandId) || 0;
  const category = profile.categories.get(categoryId) || 0;
  const raw = product * config.dimensions.product + brand * config.dimensions.brand + category * config.dimensions.category;
  const boost = config.maxBoost * Math.min(1, raw);
  const sourceBoosts = Object.fromEntries((Object.keys(profile.sources) as SourceName[]).map((name) => {
    const maps = profile.sources[name];
    const sourceRaw = (maps.products.get(productId) || 0) * config.dimensions.product
      + (maps.brands.get(brandId) || 0) * config.dimensions.brand
      + (maps.categories.get(categoryId) || 0) * config.dimensions.category;
    return [name, config.maxBoost * sourceRaw];
  })) as Record<SourceName, number>;
  return { boost, multiplier: 1 + boost, product, brand, category, sourceBoosts };
}
