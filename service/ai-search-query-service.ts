import { searchSignal, withSharedSearchBudget } from './search-budget';
export interface AiSearchConfig {
  enabled: boolean;
}

export interface AiSearchAnalysis {
  enabled: boolean;
  used: boolean;
  cached: boolean;
  model: string;
  originalQuery: string;
  keywordQuery: string;
  semanticQuery: string;
  intent: string;
  metadata: {
    categories: string[];
    seasons: string[];
    occasions: string[];
    attributes: string[];
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  };
  durationMs: number;
  error?: string;
  failed?: boolean;
}

interface GeminiPayload {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { message?: string };
}

interface ExpandedQuery {
  keywordQuery?: unknown;
  semanticQuery?: unknown;
  intent?: unknown;
  categories?: unknown;
  seasons?: unknown;
  occasions?: unknown;
  attributes?: unknown;
}

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CACHE_TTL_MS = 21600000;
const DEFAULT_INPUT_COST_PER_MILLION_USD = 0.25;
const DEFAULT_OUTPUT_COST_PER_MILLION_USD = 1.5;
const MAX_QUERY_LENGTH = 200;
const PROMPT_VERSION = 'search-query-v2';
const cache = new Map<string, { expiresAt: number; value: AiSearchAnalysis }>();
const flights = new Map<string, Promise<AiSearchAnalysis>>();

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  required: ['keywordQuery', 'semanticQuery', 'intent', 'categories', 'seasons', 'occasions', 'attributes'],
  properties: {
    keywordQuery: { type: 'STRING' }, semanticQuery: { type: 'STRING' }, intent: { type: 'STRING' },
    categories: { type: 'ARRAY', items: { type: 'STRING' } }, seasons: { type: 'ARRAY', items: { type: 'STRING' } },
    occasions: { type: 'ARRAY', items: { type: 'STRING' } }, attributes: { type: 'ARRAY', items: { type: 'STRING' } },
  },
};

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function modelName(): string {
  const value = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : DEFAULT_MODEL;
}

function generationConfig(model: string) {
  const structuredOutput = {
    responseMimeType: 'application/json',
    responseSchema: RESPONSE_SCHEMA,
  };
  if (model.startsWith('gemini-3.8-')) {
    return {
      ...structuredOutput,
      maxOutputTokens: 1000,
      thinkingConfig: { thinkingLevel: 'low' },
    };
  }
  return {
    ...structuredOutput,
    temperature: 0.1,
    maxOutputTokens: 200,
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].slice(0, 10);
}

function safeText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : fallback;
}

function fallbackAnalysis(query: string, config: AiSearchConfig, startedAt: number, error?: string): AiSearchAnalysis {
  return {
    enabled: config.enabled,
    used: false,
    cached: false,
    model: modelName(),
    originalQuery: query,
    keywordQuery: query,
    semanticQuery: query,
    intent: '',
    metadata: { categories: [], seasons: [], occasions: [], attributes: [] },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
    durationMs: Date.now() - startedAt,
    ...(error ? { error } : {}),
  };
}

/** 적응형 검색이 AI 분석을 생략할 때 원문 기반 진단값을 반환한다. */
export function createSkippedAiSearchAnalysis(query: string, config: AiSearchConfig): AiSearchAnalysis {
  return fallbackAnalysis(query.trim().slice(0, MAX_QUERY_LENGTH), config, Date.now());
}

export function validateAiSearchConfig(value: unknown): AiSearchConfig {
  const input = value && typeof value === 'object' ? value as Partial<AiSearchConfig> : {};
  return { enabled: input.enabled === true };
}

export function getAiSearchRuntime() {
  return { model: modelName(), configured: Boolean(process.env.GEMINI_API_KEY?.trim()) };
}

/** Gemini가 검색 후보를 넓힐 표현만 제안하며 필터나 점수 룰은 기존 검색 설정이 담당한다. */
export async function analyzeSearchQuery(query: string, config: AiSearchConfig): Promise<AiSearchAnalysis> {
  const startedAt = Date.now();
  const originalQuery = query.trim().slice(0, MAX_QUERY_LENGTH);
  if (!config.enabled || !originalQuery) return fallbackAnalysis(originalQuery, config, startedAt);

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return fallbackAnalysis(originalQuery, config, startedAt, 'GEMINI_API_KEY가 설정되지 않아 원문 검색을 사용했습니다.');

  const model = modelName();
  const normalizedQuery = originalQuery.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
  const cacheKey = `${PROMPT_VERSION}:${model}:${normalizedQuery}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return { ...cached.value, cached: true, durationMs: Date.now() - startedAt };
  }
  if (cached) cache.delete(cacheKey);

  const currentFlight = flights.get(cacheKey);
  if (currentFlight) {
    const value = await currentFlight;
    return { ...value, cached: true, durationMs: Date.now() - startedAt };
  }

  const geminiTimeoutMs = numberEnv('GEMINI_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 500, 30000);
  const flight = withSharedSearchBudget(geminiTimeoutMs, async () => {
    let usage = fallbackAnalysis(originalQuery, config, startedAt).usage;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), geminiTimeoutMs);
    try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal: AbortSignal.any([controller.signal, ...searchSignal() ? [searchSignal()!] : []]),
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: '당신은 한국 패션 쇼핑 검색어 분석기입니다. 원문의 의도를 보존하며 실제 상품 검색에 유용한 짧은 표현만 확장하세요. 브랜드, 가격, 성별처럼 사용자가 말하지 않은 사실을 임의로 만들지 마세요. keywordQuery는 Elasticsearch 키워드 검색용 단어 나열, semanticQuery는 의미 검색용 자연스러운 한 문장으로 작성하세요. 답변 문장이나 상품 추천은 만들지 마세요.' }],
        },
        contents: [{ role: 'user', parts: [{ text: originalQuery }] }],
        generationConfig: generationConfig(model),
      }),
    });
    const payload = await response.json() as GeminiPayload;
    const inputTokens = payload.usageMetadata?.promptTokenCount || 0;
    const outputTokens = (payload.usageMetadata?.candidatesTokenCount || 0) + (payload.usageMetadata?.thoughtsTokenCount || 0);
    const totalTokens = payload.usageMetadata?.totalTokenCount || inputTokens + outputTokens;
    // Standard text pricing: https://ai.google.dev/gemini-api/docs/pricing
    const promotional = Date.now() < Date.UTC(2027, 0, 1);
    const inputRate = model === 'gemini-3.8-flash' ? (promotional ? 0.75 : 1.5)
      : numberEnv('GEMINI_INPUT_COST_PER_MILLION_USD', DEFAULT_INPUT_COST_PER_MILLION_USD, 0, 1000);
    const outputRate = model === 'gemini-3.8-flash' ? (promotional ? 3.75 : 7.5)
      : numberEnv('GEMINI_OUTPUT_COST_PER_MILLION_USD', DEFAULT_OUTPUT_COST_PER_MILLION_USD, 0, 1000);
    usage = { inputTokens, outputTokens, totalTokens, estimatedCostUsd: (inputTokens * inputRate + outputTokens * outputRate) / 1000000 };
    if (!response.ok) throw new Error(payload.error?.message || `Gemini API 응답 오류(${response.status})`);
    const text = payload.candidates?.[0]?.content?.parts
      ?.filter((part) => part.thought !== true)
      .map((part) => part.text || '')
      .join('') || '';
    const expanded = JSON.parse(text) as ExpandedQuery;
    const categories = stringArray(expanded.categories);
    const seasons = stringArray(expanded.seasons);
    const occasions = stringArray(expanded.occasions);
    const attributes = stringArray(expanded.attributes);
    const keywordQuery = [...new Set([
      ...safeText(expanded.keywordQuery, originalQuery).split(/\s+/),
      ...categories, ...seasons, ...occasions, ...attributes,
    ])].join(' ').slice(0, 500);
    const result: AiSearchAnalysis = {
      enabled: true,
      used: true,
      cached: false,
      model,
      originalQuery,
      keywordQuery,
      semanticQuery: safeText(expanded.semanticQuery, originalQuery),
      intent: safeText(expanded.intent, ''),
      metadata: {
        categories, seasons, occasions, attributes,
      },
      usage,
      durationMs: Date.now() - startedAt,
    };
      cache.delete(cacheKey);
      cache.set(cacheKey, { expiresAt: Date.now() + numberEnv('GEMINI_CACHE_TTL_MS', DEFAULT_CACHE_TTL_MS, 1000, 86400000), value: result });
      while (cache.size > 500) cache.delete(cache.keys().next().value as string);
      return result;
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError'
        ? 'Gemini 응답 시간이 초과되어 원문 검색을 사용했습니다.'
        : `Gemini 분석에 실패해 원문 검색을 사용했습니다: ${error instanceof Error ? error.message : '알 수 없는 오류'}`;
      return { ...fallbackAnalysis(originalQuery, config, startedAt, message), usage, failed: true };
    } finally {
      clearTimeout(timer);
    }
  }).catch(() => ({ ...fallbackAnalysis(originalQuery, config, startedAt, 'Gemini 응답 시간이 초과되어 원문 검색을 사용했습니다.'), failed: true }));
  flights.set(cacheKey, flight);
  try {
    return await flight;
  } finally {
    if (flights.get(cacheKey) === flight) flights.delete(cacheKey);
  }
}
