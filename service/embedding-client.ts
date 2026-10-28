import {
  EMBEDDING_NODE,
  EMBEDDING_REQUEST_TIMEOUT_MS,
} from '../constant/api.constant';
import { searchSignal, searchTimeout, withSharedSearchBudget } from './search-budget';

type EmbeddingResponse = number[][];

export type EmbeddingCacheStatus = 'hit' | 'miss' | 'shared';

const DEFAULT_CACHE_TTL_MS = 3600000;
const DEFAULT_CACHE_MAX_ENTRIES = 2000;
const embeddingCache = new Map<string, { expiresAt: number; value: number[] }>();
const embeddingFlights = new Map<string, Promise<number[]>>();

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function embeddingCacheKey(text: string): string {
  const modelVersion = process.env.EMBEDDING_MODEL_VERSION?.trim() || 'default';
  const normalized = text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return `${modelVersion}:${normalized}`;
}

function setCachedEmbedding(key: string, value: number[]): void {
  embeddingCache.delete(key);
  embeddingCache.set(key, {
    expiresAt: Date.now() + numberEnv('EMBEDDING_QUERY_CACHE_TTL_MS', DEFAULT_CACHE_TTL_MS, 1000, 86400000),
    value,
  });
  const maxEntries = numberEnv('EMBEDDING_QUERY_CACHE_MAX_ENTRIES', DEFAULT_CACHE_MAX_ENTRIES, 10, 10000);
  while (embeddingCache.size > maxEntries) embeddingCache.delete(embeddingCache.keys().next().value as string);
}

async function createEmbeddings(texts: string[]): Promise<number[][]> {
  const response = await fetch(`${EMBEDDING_NODE}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: texts, normalize: true }),
    signal: AbortSignal.any([AbortSignal.timeout(Math.min(EMBEDDING_REQUEST_TIMEOUT_MS, searchTimeout('SEARCH_EMBEDDING_TIMEOUT_MS', 800, 2000))), ...searchSignal() ? [searchSignal()!] : []]),
  });

  if (!response.ok) {
    throw new Error(`Embedding request failed with status ${response.status}.`);
  }

  return (await response.json()) as EmbeddingResponse;
}

export async function createQueryEmbedding(text: string): Promise<number[]> {
  return (await createCachedQueryEmbedding(text)).embedding;
}

export async function createCachedQueryEmbedding(
  text: string,
): Promise<{ embedding: number[]; cacheStatus: EmbeddingCacheStatus }> {
  const key = embeddingCacheKey(text);
  const cached = embeddingCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    embeddingCache.delete(key);
    embeddingCache.set(key, cached);
    return { embedding: cached.value, cacheStatus: 'hit' };
  }
  if (cached) embeddingCache.delete(key);

  const currentFlight = embeddingFlights.get(key);
  if (currentFlight) return { embedding: await currentFlight, cacheStatus: 'shared' };

  const flight = withSharedSearchBudget(searchTimeout('SEARCH_EMBEDDING_TIMEOUT_MS', 800, 2000), () => createEmbeddings([`query: ${text}`])).then(([embedding]) => {
    if (!Array.isArray(embedding) || embedding.length !== 384 || !embedding.every((value) => Number.isFinite(value)) || !embedding.some((value) => value !== 0)) throw new Error('Embedding response is invalid.');
    setCachedEmbedding(key, embedding);
    return embedding;
  });
  embeddingFlights.set(key, flight);
  try {
    return { embedding: await flight, cacheStatus: 'miss' };
  } finally {
    if (embeddingFlights.get(key) === flight) embeddingFlights.delete(key);
  }
}
