import type { estypes } from '@elastic/elasticsearch';
import { searchTimeout, withSharedSearchBudget } from './search-budget';

const cache = new Map<string, { expiresAt: number; value: estypes.IndicesAnalyzeResponse }>();
const flights = new Map<string, Promise<estypes.IndicesAnalyzeResponse>>();
let generation = 0;

export function invalidateSearchMorphology(): void {
  generation += 1;
  cache.clear();
  flights.clear();
}

export async function cachedSearchMorphology(index: string, field: string, text: string, load: () => Promise<estypes.IndicesAnalyzeResponse>): Promise<estypes.IndicesAnalyzeResponse> {
  const key = JSON.stringify([index, field, text.normalize('NFKC').trim().replace(/\s+/g, ' ')]);
  const current = cache.get(key);
  if (current && current.expiresAt > Date.now()) {
    cache.delete(key);
    cache.set(key, current);
    return current.value;
  }
  if (current) cache.delete(key);
  const shared = flights.get(key);
  if (shared) return shared;
  const version = generation;
  const flight = withSharedSearchBudget(searchTimeout('SEARCH_ES_TIMEOUT_MS', 5000, 5000), load).then((value) => {
    if (generation === version) {
      cache.set(key, { expiresAt: Date.now() + 30_000, value });
      while (cache.size > 2000) cache.delete(cache.keys().next().value as string);
    }
    return value;
  });
  flights.set(key, flight);
  try { return await flight; }
  finally { if (flights.get(key) === flight) flights.delete(key); }
}
