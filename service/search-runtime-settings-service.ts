import { listBusinessRules, type BusinessRule } from './business-rule-service';
import { getSearchRankingConfig, type SearchRankingConfig } from './search-ranking-service';
import { getSynonymConfig, getWordPolicyConfig, getRequestExpressionConfig, type SynonymConfig, type WordPolicyConfig } from './search-dictionary-service';
import { compileRequestExpressions } from './request-expression';
import { getSearchFilterConfig, type SearchFilterConfig } from './search-filter-service';
import { invalidateSearchMorphology } from './search-morphology-cache';
import { searchTimeout, withSharedSearchBudget } from './search-budget';

export type RuntimeCacheStatus = 'hit' | 'miss' | 'shared' | 'bypass';

export interface SearchRuntimeSettings {
  rankingConfig: SearchRankingConfig;
  businessRules: BusinessRule[];
  synonymConfig: SynonymConfig;
  wordPolicyConfig: WordPolicyConfig;
  filterConfig: SearchFilterConfig;
  requestExpressionMatcher: RegExp | null;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 20;
const cache = new Map<string, { expiresAt: number; value: SearchRuntimeSettings }>();
const flights = new Map<string, Promise<SearchRuntimeSettings>>();

function ttlMs(): number {
  const value = Number(process.env.SEARCH_SETTINGS_CACHE_TTL_MS);
  return Number.isFinite(value) && value >= 1000 && value <= 3600000 ? value : DEFAULT_TTL_MS;
}

async function loadSearchRuntimeSettings(targetIndex: string): Promise<SearchRuntimeSettings> {
  const [rankingConfig, businessRules, synonymConfig, wordPolicyConfig, filterConfig, requestExpressions] = await Promise.all([
    getSearchRankingConfig(targetIndex),
    listBusinessRules(targetIndex),
    getSynonymConfig(targetIndex),
    getWordPolicyConfig(targetIndex),
    getSearchFilterConfig(targetIndex),
    getRequestExpressionConfig(targetIndex),
  ]);
  return {
    rankingConfig,
    businessRules,
    synonymConfig,
    wordPolicyConfig,
    filterConfig,
    requestExpressionMatcher: compileRequestExpressions(requestExpressions.phrases),
  };
}

function setCached(targetIndex: string, value: SearchRuntimeSettings): void {
  cache.delete(targetIndex);
  cache.set(targetIndex, { expiresAt: Date.now() + ttlMs(), value });
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
}

export async function getSearchRuntimeSettings(
  targetIndex: string,
  bypassCache = false,
): Promise<{ value: SearchRuntimeSettings; cacheStatus: RuntimeCacheStatus }> {
  if (bypassCache) return { value: await loadSearchRuntimeSettings(targetIndex), cacheStatus: 'bypass' };
  const cached = cache.get(targetIndex);
  if (cached && cached.expiresAt > Date.now()) {
    cache.delete(targetIndex);
    cache.set(targetIndex, cached);
    return { value: cached.value, cacheStatus: 'hit' };
  }
  if (cached) cache.delete(targetIndex);

  const currentFlight = flights.get(targetIndex);
  if (currentFlight) return { value: await currentFlight, cacheStatus: 'shared' };

  const flight = withSharedSearchBudget(searchTimeout('SEARCH_ES_TIMEOUT_MS', 5000, 5000), () => loadSearchRuntimeSettings(targetIndex));
  flights.set(targetIndex, flight);
  try {
    const value = await flight;
    if (flights.get(targetIndex) === flight) setCached(targetIndex, value);
    return { value, cacheStatus: 'miss' };
  } finally {
    if (flights.get(targetIndex) === flight) flights.delete(targetIndex);
  }
}

export function invalidateSearchRuntimeSettings(targetIndex?: string): void {
  invalidateSearchMorphology();
  if (targetIndex) {
    cache.delete(targetIndex);
    flights.delete(targetIndex);
  } else {
    cache.clear();
    flights.clear();
  }
}
