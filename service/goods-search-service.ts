import type { estypes } from '@elastic/elasticsearch';

import { GOODS_INDEX, SEMANTIC_SEARCH_ENABLED } from '../constant/api.constant';
import { isContentsIndex } from '../constant/contents-index.constant';
import { getVectorField } from '../constant/vector-field.constant.mjs';
import { createCachedQueryEmbedding } from './embedding-client';
import { analyzeSearchQuery, createSkippedAiSearchAnalysis, type AiSearchAnalysis } from './ai-search-query-service';
import { elasticClient } from './elastic-client';
import { searchTimeout, withSearchBudget } from './search-budget';
import { cachedSearchMorphology } from './search-morphology-cache';
import { type SearchRankingConfig } from './search-ranking-service';
import { applySearchQueryPolicy, buildPolicyKeywordQuery, normalizeSearchQuery, type QueryPolicyAnalysis } from './search-query-policy';
import { competitionRanks } from './competition-rank';
import { compilePopularityFormula, getPopularityNormalizationReference, normalizePopularityScore } from './popularity-formula';
import { diagnosePreparedCategoryAdjustment, prepareCategoryAdjustment } from './category-adjustment';
import { getCategoryCatalog, type CategoryCatalogResult } from './category-catalog-service';
import { getBrandCatalog, type BrandCatalogResult } from './brand-catalog-service';
import { detectStructuredSearchIntent } from './structured-search-intent';
import { decideAdaptiveSearch } from './adaptive-search';
import { isRuleLive, matchesPinRule, matchesScoreRule, type BusinessRule, type PinRule } from './business-rule-service';
import { evaluateSearchFilters } from './search-filter-evaluator';
import { getSearchRuntimeSettings, type RuntimeCacheStatus } from './search-runtime-settings-service';
import { getRuleSourceField, getRuleSourceValue } from './business-rule-evaluator';
import { EmptySearchQueryError, removeRequestExpressions } from './request-expression';
import { calculatePersonalizationBoost, getPersonalizationProfile, type PersonalizationProfile } from './personalization-service';

export type GoodsDocument = Record<string, unknown>;
export interface TimingSpan { id: string; startMs: number; durationMs: number; parentId?: string; lane?: string }
export interface TimingWaterfall { totalMs: number; spans: TimingSpan[]; source: 'own' | 'shared' }

export interface GoodsSearchItem extends GoodsDocument {
  id?: string;
  score: number;
  sortValues?: unknown[];
  scores: {
    keyword: number;
    vector: number;
    total: number;
    keywordRaw: number;
    vectorRaw: number;
    keywordRank: number | null;
    vectorRank: number | null;
    rrfTotal: number;
    popularityRaw: number;
    popularityNormalized: number;
  popularityBoost: number;
    businessRuleBaseScore?: number;
    businessRuleMultiplier?: number;
    categoryAdjustment?: ReturnType<typeof diagnosePreparedCategoryAdjustment>;
    personalization?: { boost: number; multiplier: number; product: number; brand: number; category: number; sourceBoosts?: { cart: number; recent: number; wish: number; order: number } };
    businessRules?: Array<{ id: string; name: string; adjustment: number; field: string; operator: string; expectedValue: number | string; actualValue: unknown }>;
  };
  pinning?: { ruleId: string; query: string; requestedPosition: number; appliedPosition: number };
}

export interface GoodsSearchResult {
  query: string;
  queryAnalysis: {
    cleanedQuery: string;
    removedRequestExpressions: string[];
    field: string;
    tokens: Array<{ token?: string; position?: number; type?: string }>;
    originalTokens: string[];
    effectiveTokens: string[];
    removedShortTokens: string[];
    removedStopwords: string[];
    removedContextTokens: string[];
    synonymExpansions: string[];
    synonymExpansionDetails: Array<{ source: string; target: string }>;
    tokenDiagnostics: Array<{ token: string; used: boolean; reason?: string }>;
    warnings: Array<{ message: string }>;
    effectiveQuery: string;
  };
  page: number;
  size: number;
  total: number;
  searchMode: 'hybrid' | 'lexical';
  searchModeReason: string;
  scoreFusion: { method: 'rrf'; rankConstant: number; rankWindowSize: number; vectorRankWindowSize: number; popularity: SearchRankingConfig['popularity'] };
  items: GoodsSearchItem[];
  policyWarnings: Array<{ message: string }>;
  appliedFilters: Array<{ id: string; name: string; field: string; values: string[]; range?: Record<string, number> }>;
  candidateFallback: { applied: boolean; reason: string | null; abandonedQuery: string | null };
  timingWaterfall: { currentSearch: TimingWaterfall };
  aiAnalysis: AiSearchAnalysis;
  timings: {
    settingsMs: number;
    morphologyAnalysisMs: number;
    initialMorphologyAnalysisMs: number;
    additionalMorphologyAnalysisMs: number;
    initialParallelPreparationMs: number;
    queryAnalysisMs: number;
    aiMs: number;
    embeddingMs: number;
    candidatePreparationMs: number;
    candidateSearchMs: number;
    keywordCandidateSearchMs: number;
    vectorCandidateSearchMs: number;
    fallbackCandidateSearchMs: number;
    candidateResultProcessingMs: number;
    categoryCatalogMs: number;
    categoryCatalogCacheStatus: 'hit' | 'miss' | 'shared' | 'skipped';
    categoryCatalogKey: string;
    categoryCatalogCount: number;
    categoryCatalogLoadMethod: 'aggregation' | 'source_scan' | 'failed' | 'skipped';
    categoryPreparationMs: number;
    personalizationMs: number;
    rankingMs: number;
    documentLoadMs: number;
    totalMs: number;
    settingsCacheStatus: RuntimeCacheStatus;
    aiCacheStatus: 'hit' | 'miss' | 'skipped';
    embeddingCacheStatus: 'hit' | 'miss' | 'shared' | 'skipped';
    personalizationCacheStatus: PersonalizationProfile['cacheStatus'] | 'skipped';
    requestCacheStatus: 'miss' | 'shared';
  };
}

/** 공개 검색 API에는 화면 진단용 점수·형태소 정보를 제외하고 상품과 페이징 정보만 제공한다. */
export interface PublicGoodsSearchResult {
  page: number;
  size: number;
  total: number;
  items: GoodsDocument[];
}

const PUBLIC_RESPONSE_EXCLUDED_FIELDS = new Set(['id', 'score', 'scores', 'sortValues', 'pinning', 'embedding_text', 'embedding_source', 'embedding_geo_fingerprint', 'embedding_context_hash']);

export function toPublicGoodsSearchResult(result: GoodsSearchResult): PublicGoodsSearchResult {
  return {
    page: result.page,
    size: result.size,
    total: result.total,
    items: result.items.map((item) => Object.fromEntries(
      Object.entries(item).filter(([key]) => !PUBLIC_RESPONSE_EXCLUDED_FIELDS.has(key)),
    )),
  };
}

export interface KeywordFieldDiagnostic {
  field: string;
  boost: number;
  diagnosticScore: number | null;
  highlightedValues: string[];
}


function buildEffectiveSort(sortOptions?: unknown[]): { options?: unknown[]; directions: Array<'asc' | 'desc'> } {
  if (!sortOptions?.length) return { directions: [] };
  const hasScore = sortOptions.some((item) =>
    item === '_score' || (Boolean(item) && typeof item === 'object' && !Array.isArray(item) && Object.prototype.hasOwnProperty.call(item, '_score')),
  );
  const options = hasScore ? sortOptions : [...sortOptions, { _score: { order: 'desc' } }];
  const directions = options.map((item) => {
    if (typeof item === 'string') return item === '_score' ? 'desc' : 'asc';
    const value = Object.values(item as Record<string, unknown>)[0];
    if (typeof value === 'string') return value === 'desc' ? 'desc' : 'asc';
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return (value as Record<string, unknown>).order === 'desc' ? 'desc' : 'asc';
    }
    return 'asc';
  });
  return { options, directions };
}

function compareCustomSort(
  left: estypes.SearchHit<GoodsDocument>,
  right: estypes.SearchHit<GoodsDocument>,
  directions: Array<'asc' | 'desc'>,
): number {
  const leftValues = left.sort || [];
  const rightValues = right.sort || [];
  for (let index = 0; index < directions.length; index += 1) {
    const leftValue = leftValues[index] as string | number | null | undefined;
    const rightValue = rightValues[index] as string | number | null | undefined;
    if (leftValue === rightValue) continue;
    if (leftValue === null || leftValue === undefined) return 1;
    if (rightValue === null || rightValue === undefined) return -1;
    const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue));
    if (comparison !== 0) return directions[index] === 'desc' ? -comparison : comparison;
  }
  return 0;
}

const RRF_RANK_CONSTANT = 60;

function reciprocalRank(rank: number | null): number {
  return rank === null ? 0 : 1 / (RRF_RANK_CONSTANT + rank);
}

/** 공개 검색과 관리자 시뮬레이터가 같은 후보군과 RRF 순위 결합을 사용한다. */
async function runGoodsSearchOnce(
  queryText: string,
  page: number,
  size: number,
  targetIndex = GOODS_INDEX,
  rankingConfigOverride?: SearchRankingConfig,
  sortOptions?: unknown[],
  bypassSettingsCache = false,
  memberNo?: string | null,
): Promise<GoodsSearchResult> {
  const totalStartedAt = performance.now();
  const waterfallSpans: TimingSpan[] = [];
  const addSpan = (id: string, start: number, end: number, parentId?: string, lane?: string) => waterfallSpans.push({ id, startMs: Math.max(0, start - totalStartedAt), durationMs: Math.max(0, end - start), ...(parentId ? { parentId } : {}), ...(lane ? { lane } : {}) });
  const contentsSearch = isContentsIndex(targetIndex);
  const settingsStartedAt = performance.now();
  const settingsPromise = getSearchRuntimeSettings(targetIndex, bypassSettingsCache).then((result) => ({ result, elapsedMs: performance.now() - settingsStartedAt }));
  // 형태소 분석이 resolve를 기다리는 동안 설정 실패가 unhandled rejection이 되지 않게 한다.
  void settingsPromise.catch(() => {});
  const resolveIndexStartedAt = performance.now();
  const resolved = await elasticClient.indices.resolveIndex({ name: targetIndex });
  const indices = resolved.aliases?.[0]?.indices || resolved.indices?.map((index) => index.name) || [];
  if (indices.length !== 1) throw new Error('검색 대상 인덱스를 하나로 확인할 수 없습니다.');
  const resolvedIndex = indices[0];
  addSpan('resolve-index', resolveIndexStartedAt, performance.now());
  const vectorField = getVectorField(targetIndex);
  const originalAnalysisText = normalizeSearchQuery(queryText);
  const analysisField = contentsSearch ? 'title' : 'goods_nm';
  const analyze = (text: string) => cachedSearchMorphology(resolvedIndex, analysisField, text,
    () => elasticClient.indices.analyze({ index: resolvedIndex, field: analysisField, text }));
  // 서로 의존하지 않는 설정과 형태소 분석은 동시에 조회해 검색 전 직렬 왕복 시간을 줄인다.
  let additionalMorphologyAnalysisMs = 0;
  const analyzeText = async (text: string, spanId: string) => {
    const startedAt = performance.now();
    const result = await analyze(text);
    const finishedAt = performance.now();
    additionalMorphologyAnalysisMs += finishedAt - startedAt;
    addSpan(spanId, startedAt, finishedAt, undefined, 'morphology');
    return result;
  };
  const initialParallelStartedAt = performance.now();
  let initialMorphologyAnalysisMs = 0;
  const initialAnalysisPromise = queryText ? (async () => {
    const startedAt = performance.now();
    const result = await analyze(originalAnalysisText);
    initialMorphologyAnalysisMs = performance.now() - startedAt;
    addSpan('initial-morphology', startedAt, performance.now(), 'initial-parallel', 'morphology');
    return result;
  })() : Promise.resolve(null);
  const [settingsResult, analyzed] = await Promise.all([
    settingsPromise,
    initialAnalysisPromise,
  ]);
  const initialParallelPreparationMs = performance.now() - initialParallelStartedAt;
  addSpan('settings', settingsStartedAt, settingsStartedAt + settingsResult.elapsedMs, 'initial-parallel', 'settings');
  addSpan('initial-parallel', initialParallelStartedAt, performance.now());
  const runtimeSettings = settingsResult.result;
  const { businessRules: businessRuleConfigs, synonymConfig, wordPolicyConfig, filterConfig, requestExpressionMatcher } = runtimeSettings.value;
  const rankingConfig = rankingConfigOverride || runtimeSettings.value.rankingConfig;
  const personalizationEnabled = Boolean(!contentsSearch && memberNo && rankingConfig.personalization.enabled && !sortOptions?.length);
  const personalizationStartedAt = performance.now();
  const personalizationPromise: Promise<{ profile: PersonalizationProfile | null; elapsedMs: number; cacheStatus: PersonalizationProfile['cacheStatus'] | 'skipped' }> = personalizationEnabled
    ? withSearchBudget(800, () => getPersonalizationProfile(memberNo as string, targetIndex, rankingConfig.personalization))
      .then((profile) => ({ profile, elapsedMs: performance.now() - personalizationStartedAt, cacheStatus: profile?.cacheStatus || 'failed' }))
      .catch(() => ({ profile: null, elapsedMs: performance.now() - personalizationStartedAt, cacheStatus: 'failed' }))
    : Promise.resolve({ profile: null, elapsedMs: 0, cacheStatus: 'skipped' });
  const businessRules = contentsSearch ? [] : businessRuleConfigs.filter((rule) => isRuleLive(rule));
  let queryAnalysisMs = 0;
  let synchronousAnalysisStartedAt = performance.now();
  const policy: QueryPolicyAnalysis = queryText
    ? applySearchQueryPolicy(queryText, synonymConfig, wordPolicyConfig, analyzed?.tokens?.map((token) => ({ token: token.token })) || [])
    : { normalizedQuery: '', originalTokens: [], effectiveTokens: [], removedShortTokens: [], removedStopwords: [], removedContextTokens: [], synonymExpansions: [], synonymExpansionDetails: [], tokenDiagnostics: [], warnings: [], effectiveQuery: '' };
  // 금지어 검사는 원문에서 먼저 끝낸 뒤 요청 표현을 제거하고 검색 필터를 감지한다.
  const requestAnalysis = removeRequestExpressions(queryText, requestExpressionMatcher);
  if (requestAnalysis.removedExpressions.length && !requestAnalysis.cleanedQuery.trim()) throw new EmptySearchQueryError();
  const filterAnalysis = queryText ? evaluateSearchFilters(requestAnalysis.cleanedQuery, contentsSearch ? [] : filterConfig.rules, !contentsSearch) : { remainingQuery: '', filters: [], matchedRules: [] };
  queryAnalysisMs += performance.now() - synchronousAnalysisStartedAt;
  addSpan('initial-policy-filter', synchronousAnalysisStartedAt, performance.now());
  const categoryCatalogStartedAt = performance.now();
  const catalogs: [BrandCatalogResult, CategoryCatalogResult | (Omit<CategoryCatalogResult, 'cacheStatus'> & { cacheStatus: 'skipped' })] = contentsSearch
    ? [{ entries: [], complete: false, cacheStatus: 'hit', cacheKey: resolvedIndex }, { categories: [], paths: [], complete: false, loadMethod: 'failed' as const, cacheStatus: 'skipped' as const, cacheKey: resolvedIndex }]
    : await Promise.all([
      getBrandCatalog(resolvedIndex),
      rankingConfig.categoryAdjustment.enabled
        ? getCategoryCatalog(resolvedIndex)
        : Promise.resolve({ categories: [], paths: [], complete: false, loadMethod: 'failed' as const, cacheStatus: 'skipped' as const, cacheKey: resolvedIndex }),
    ]);
  const brandCatalog = catalogs[0];
  const categoryCatalog = catalogs[1];
  const categoryCatalogFinishedAt = performance.now();
  addSpan('catalog', categoryCatalogStartedAt, categoryCatalogFinishedAt);
  synchronousAnalysisStartedAt = performance.now();
  const structuredIntent = detectStructuredSearchIntent(filterAnalysis.remainingQuery, brandCatalog, categoryCatalog, !contentsSearch && rankingConfig.categoryAdjustment.enabled);
  const remainingQuery = structuredIntent.remainingQuery;
  queryAnalysisMs += performance.now() - synchronousAnalysisStartedAt;
  addSpan('structured-intent', synchronousAnalysisStartedAt, performance.now());
  const remainingAnalysisText = normalizeSearchQuery(remainingQuery);
  const canReuseOriginalAnalysis = Boolean(remainingQuery)
    && remainingAnalysisText === originalAnalysisText
    && requestAnalysis.removedExpressions.length === 0
    && filterAnalysis.filters.length === 0
    && structuredIntent.filters.length === 0;
  const remainingForAnalysis = remainingQuery
    ? canReuseOriginalAnalysis ? analyzed : await analyzeText(remainingAnalysisText, 'remaining-morphology')
    : null;
  synchronousAnalysisStartedAt = performance.now();
  const adaptiveDecision = remainingQuery ? decideAdaptiveSearch(
    remainingQuery,
    remainingForAnalysis?.tokens?.map((token) => token.token) || [],
    requestAnalysis.removedExpressions,
    rankingConfig.adaptiveSearch,
  ) : { useVector: false, reason: '구조화 필터 전용 검색' };
  queryAnalysisMs += performance.now() - synchronousAnalysisStartedAt;
  addSpan('adaptive-decision', synchronousAnalysisStartedAt, performance.now());
  // AI 장애 시 기존 검색을 유지하고, AI가 정상 응답한 경우에만 확장 검색어를 후보 조회에 사용한다.
  const aiStartedAt = performance.now();
  const aiAnalysis = adaptiveDecision.useVector
    ? await analyzeSearchQuery(remainingQuery, rankingConfig.ai)
      .catch(() => ({ ...createSkippedAiSearchAnalysis(remainingQuery, rankingConfig.ai), failed: true, error: 'AI 분석에 실패해 원문 검색을 사용했습니다.' }))
    : createSkippedAiSearchAnalysis(remainingQuery, rankingConfig.ai);
  const aiFinishedAt = performance.now();
  addSpan('ai', aiStartedAt, aiFinishedAt);
  // AI 확장 결과에도 동일한 구문 제거를 적용해 요청 표현이 다시 토큰으로 들어오지 않게 한다.
  const keywordRequestAnalysis = removeRequestExpressions(aiAnalysis.used ? aiAnalysis.keywordQuery : remainingQuery, requestExpressionMatcher);
  const keywordQueryText = keywordRequestAnalysis.cleanedQuery;
  if (!keywordQueryText.trim() && keywordRequestAnalysis.removedExpressions.length && !filterAnalysis.filters.length && !structuredIntent.filters.length) throw new EmptySearchQueryError();
  const remainingAnalyzed = keywordQueryText
    ? keywordQueryText === remainingQuery ? remainingForAnalysis : keywordQueryText === queryText ? analyzed : await analyzeText(keywordQueryText, 'keyword-morphology')
    : null;
  synchronousAnalysisStartedAt = performance.now();
  const effectivePolicy: QueryPolicyAnalysis = keywordQueryText
    ? applySearchQueryPolicy(keywordQueryText, synonymConfig, wordPolicyConfig, remainingAnalyzed?.tokens?.map((token) => ({ token: token.token })) || [])
    : {
      normalizedQuery: '',
      originalTokens: [],
      effectiveTokens: [],
      removedShortTokens: [],
      removedStopwords: [],
      removedContextTokens: [],
      synonymExpansions: [],
      synonymExpansionDetails: [],
      tokenDiagnostics: [],
      warnings: policy.warnings,
      effectiveQuery: '',
    };
  queryAnalysisMs += performance.now() - synchronousAnalysisStartedAt;
  addSpan('effective-policy', synchronousAnalysisStartedAt, performance.now());
  // 금지어 차단은 위 정책 판정 뒤에만 벡터 임베딩을 호출한다.
  const embeddingStartedAt = performance.now();
  let embeddingResult: Awaited<ReturnType<typeof createCachedQueryEmbedding>> | null = null;
  let embeddingFailed = false;
  if (remainingQuery && SEMANTIC_SEARCH_ENABLED && adaptiveDecision.useVector && !aiAnalysis.failed) {
    try {
      embeddingResult = await withSearchBudget(searchTimeout('SEARCH_EMBEDDING_TIMEOUT_MS', 800, 2000), () => createCachedQueryEmbedding(aiAnalysis.semanticQuery));
    } catch {
      embeddingFailed = true;
      console.warn('Search embedding unavailable; continuing with lexical search.');
    }
  }
  const queryVector = embeddingResult?.embedding || null;
  const embeddingFinishedAt = performance.now();
  addSpan('embedding', embeddingStartedAt, embeddingFinishedAt);
  const candidatePreparationStartedAt = performance.now();
  const lexicalQuery: estypes.QueryDslQueryContainer = keywordQueryText ? buildPolicyKeywordQuery(effectivePolicy, rankingConfig) : { match_all: {} };
  const filterQueries = [...filterAnalysis.filters, ...structuredIntent.filters] as estypes.QueryDslQueryContainer[];
  const lexicalWithFilters: estypes.QueryDslQueryContainer = filterQueries.length ? { bool: { must: [lexicalQuery], filter: filterQueries } } : lexicalQuery;
  const effectiveSort = buildEffectiveSort(sortOptions);
  // 후보 순위 계산에는 인기도와 비즈니스 룰 필드만 필요하다. 전체 상품 문서는 최종 페이지에 대해서만 조회한다.
  const candidateSourceFields = [...new Set([
    ...(contentsSearch ? [] : rankingConfig.popularity.referencedFields),
    ...(contentsSearch ? [] : ['up_disp_clsf_nm']),
    ...(contentsSearch ? [] : ['goods_id', 'goods_no', 'onl_goods_no', 'bnd_no', 'brd_no', 'brand', 'brand_id', 'disp_clsf_no', 'up_disp_clsf_no', 'cat', 'category', 'disp_clsf_nm']),
    ...businessRules
      .filter((rule): rule is Extract<BusinessRule, { kind: 'score' }> => rule.kind === 'score')
      .map((rule) => getRuleSourceField(rule.condition.field)),
  ])];
  // 모든 페이지가 동일한 후보군을 정렬해야 페이지 수와 순위가 이동 중 바뀌지 않는다.
  const rankWindowSize = 1000;
  const vectorRankWindowSize = 500;
  const searches: estypes.MsearchRequestItem[] = [
    { index: resolvedIndex },
    {
      size: rankWindowSize,
      track_total_hits: false,
      track_scores: Boolean(effectiveSort.options),
      ...(effectiveSort.options ? { sort: effectiveSort.options as estypes.Sort } : {}),
      query: lexicalWithFilters,
      _source: candidateSourceFields.length ? { includes: candidateSourceFields } : false,
    },
  ];

  if (queryVector) {
    searches.push(
      { index: resolvedIndex },
      {
        size: vectorRankWindowSize,
        track_scores: Boolean(effectiveSort.options),
        ...(effectiveSort.options ? { sort: effectiveSort.options as estypes.Sort } : {}),
        knn: {
          field: vectorField,
          query_vector: queryVector,
          k: vectorRankWindowSize,
          num_candidates: vectorRankWindowSize,
          ...(filterQueries.length ? { filter: filterQueries } : {}),
        },
        _source: candidateSourceFields.length ? { includes: candidateSourceFields } : false,
      },
    );
  }

  const candidateSearchStartedAt = performance.now();
  addSpan('candidate-preparation', candidatePreparationStartedAt, candidateSearchStartedAt);
  const multiResult = await elasticClient.msearch<GoodsDocument>({ searches });
  let lexicalResult = multiResult.responses[0];
  if (!lexicalResult || !('hits' in lexicalResult) || lexicalResult.timed_out || (lexicalResult._shards?.failed || 0) > 0) throw new Error('키워드 검색 결과를 가져오지 못했습니다.');
  let vectorResult: estypes.MsearchResponseItem<GoodsDocument> | undefined = multiResult.responses[1];
  const vectorFailed = Boolean(queryVector && (!vectorResult || !('hits' in vectorResult) || vectorResult.timed_out || (vectorResult._shards?.failed || 0) > 0));
  if (vectorFailed) vectorResult = undefined;
  const initialKeywordTook = lexicalResult.took ?? 0;
  let fallbackCandidateSearchMs = 0;
  let usedStructuredFilterFallback = false;
  const vectorHasHits = Boolean(vectorResult && 'hits' in vectorResult && vectorResult.hits.hits.length);
  if (!aiAnalysis.failed && !embeddingFailed && !vectorFailed && structuredIntent.filters.length && effectivePolicy.effectiveQuery && !lexicalResult.hits.hits.length && !vectorHasHits) {
    const fallbackStartedAt = performance.now();
    lexicalResult = await elasticClient.search<GoodsDocument>({
      index: resolvedIndex,
      size: rankWindowSize,
      track_total_hits: false,
      track_scores: Boolean(effectiveSort.options),
      ...(effectiveSort.options ? { sort: effectiveSort.options as estypes.Sort } : {}),
      query: { bool: { filter: filterQueries } },
      _source: candidateSourceFields.length ? { includes: candidateSourceFields } : false,
    });
    if (lexicalResult.timed_out || (lexicalResult._shards?.failed || 0) > 0) throw new Error('키워드 검색 결과가 불완전합니다.');
    fallbackCandidateSearchMs = performance.now() - fallbackStartedAt;
    addSpan('candidate-fallback', fallbackStartedAt, performance.now(), 'candidate-search');
    usedStructuredFilterFallback = true;
  }
  const candidateSearchFinishedAt = performance.now();
  addSpan('candidate-search', candidateSearchStartedAt, candidateSearchFinishedAt);
  const concreteIndex = lexicalResult.hits.hits[0]?._index
    || (vectorResult && 'hits' in vectorResult ? vectorResult.hits.hits[0]?._index : undefined)
    || resolvedIndex;
  const categoryPreparationStartedAt = performance.now();
  const preparedCategoryAdjustment = prepareCategoryAdjustment(
    [remainingQuery, ...effectivePolicy.synonymExpansions].join(' '),
    rankingConfig.categoryAdjustment,
    categoryCatalog,
    aiAnalysis.used ? aiAnalysis.metadata.categories : [],
  );
  const categoryPreparationFinishedAt = performance.now();
  addSpan('candidate-result-processing', candidateSearchFinishedAt, categoryPreparationStartedAt);
  addSpan('category-preparation', categoryPreparationStartedAt, categoryPreparationFinishedAt);

  const personalizationResult = await personalizationPromise;
  const personalizationProfile = personalizationResult.profile;
  if (personalizationEnabled) {
    addSpan('personalization', personalizationStartedAt, personalizationStartedAt + personalizationResult.elapsedMs, undefined, 'personalization');
  }
  const rankingStartedAt = performance.now();
  const mergedHits = new Map<string, {
    hit: estypes.SearchHit<GoodsDocument>;
    keywordRaw: number;
    vectorRaw: number;
    keywordRank: number | null;
    vectorRank: number | null;
  }>();
  const filterOnly = !effectivePolicy.effectiveQuery || usedStructuredFilterFallback;
  const keywordRanks = competitionRanks(lexicalResult.hits.hits.map((hit) => hit._score ?? 0));
  for (const [index, hit] of lexicalResult.hits.hits.entries()) {
    if (hit._id) mergedHits.set(hit._id, {
      hit,
      keywordRaw: filterOnly ? 0 : hit._score ?? 0,
      vectorRaw: 0,
      keywordRank: filterOnly ? null : keywordRanks[index],
      vectorRank: null,
    });
  }
  if (vectorResult && 'hits' in vectorResult) {
    const vectorRanks = competitionRanks(vectorResult.hits.hits.map((hit) => hit._score ?? 0));
    for (const [index, hit] of vectorResult.hits.hits.entries()) {
      if (!hit._id) continue;
      const existing = mergedHits.get(hit._id);
      if (existing) {
        existing.vectorRaw = hit._score ?? 0;
        existing.vectorRank = vectorRanks[index];
      } else {
        mergedHits.set(hit._id, {
          hit,
          keywordRaw: 0,
          vectorRaw: hit._score ?? 0,
          keywordRank: null,
          vectorRank: vectorRanks[index],
        });
      }
    }
  }

  const popularityScore = contentsSearch ? () => 0 : compilePopularityFormula(rankingConfig.popularity);
  const candidates = Array.from(mergedHits.values()).map(({ hit, keywordRaw, vectorRaw, keywordRank, vectorRank }) => ({
    hit, keywordRaw, vectorRaw, keywordRank, vectorRank,
    popularityRaw: popularityScore((hit._source || {}) as Record<string, unknown>),
  }));
  const popularityReference = getPopularityNormalizationReference(
    candidates.map((item) => item.popularityRaw),
    rankingConfig.popularity,
  );
  const rankedHits = candidates
    .map(({ hit, keywordRaw, vectorRaw, keywordRank, vectorRank, popularityRaw }) => {
      const keyword = reciprocalRank(keywordRank);
      const vector = reciprocalRank(vectorRank);
      const rrfTotal = keyword + vector;
      const popularityNormalized = normalizePopularityScore(
        popularityRaw,
        popularityReference,
        rankingConfig.popularity.normalizationMethod,
      );
      const popularityBoost = !contentsSearch && rankingConfig.popularity.enabled ? rankingConfig.popularity.weight * popularityNormalized : 0;
      const matchedRules = businessRules.filter((rule): rule is Extract<BusinessRule, { kind: 'score' }> => rule.kind === 'score' && matchesScoreRule(rule, (hit._source || {}) as Record<string, unknown>));
      const ruleMultiplier = matchedRules.reduce((multiplier, rule) => multiplier * (1 + rule.adjustment), 1);
      const businessRuleBaseScore = (filterOnly ? 1 : rrfTotal) * (1 + popularityBoost);
      const categoryAdjustment = diagnosePreparedCategoryAdjustment((hit._source || {}) as Record<string, unknown>, rankingConfig.categoryAdjustment, preparedCategoryAdjustment);
      const categoryMultiplier = !contentsSearch && rankingConfig.categoryAdjustment.enabled ? categoryAdjustment.multiplier : 1;
      const personalization = personalizationProfile ? calculatePersonalizationBoost((hit._source || {}) as Record<string, unknown>, personalizationProfile, rankingConfig.personalization) : { boost: 0, multiplier: 1, product: 0, brand: 0, category: 0 };
      return { hit, keyword, vector, keywordRaw, vectorRaw, keywordRank, vectorRank, rrfTotal, popularityRaw, popularityNormalized, popularityBoost, businessRuleBaseScore, ruleMultiplier, matchedRules, categoryAdjustment, categoryMultiplier, personalization, total: businessRuleBaseScore * ruleMultiplier * categoryMultiplier * personalization.multiplier, pinning: undefined as GoodsSearchItem['pinning'] };
    })
    .sort((left, right) => effectiveSort.options
      ? compareCustomSort(left.hit, right.hit, effectiveSort.directions)
      : right.total - left.total);
  // 설정한 검색어 조건과 일치하는 고정 상품은 후보 검색에 없더라도 불러와 지정 순위에 삽입한다.
  let finalHits = rankedHits;
  const pinRules = businessRules.filter((rule): rule is PinRule => rule.kind === 'pin' && matchesPinRule(rule, queryText, effectivePolicy.effectiveTokens));
  if (pinRules.length) {
    // 작은 요청 순위, 같은 순위에서는 rule ID 순서로 상품당 하나의 룰을 선택한다.
    const seenPins = new Set<string>();
    const pins = pinRules.flatMap((rule) => rule.products.map((product) => ({ rule, ...product })))
      .sort((left, right) => left.position - right.position || left.rule.id.localeCompare(right.rule.id) || left.goodsId.localeCompare(right.goodsId))
      .filter((pin) => { if (seenPins.has(pin.goodsId)) return false; seenPins.add(pin.goodsId); return true; });
    const pinnedIds = [...new Set(pins.map((pin) => pin.goodsId))];
    const missingIds = pinnedIds.filter((id) => !finalHits.some((item) => item.hit._id === id));
    if (missingIds.length) {
      const response = filterQueries.length
        ? await elasticClient.search<GoodsDocument>({ index: concreteIndex, size: missingIds.length, query: { bool: { filter: [{ ids: { values: missingIds } }, ...filterQueries] } } })
        : await elasticClient.mget<GoodsDocument>({ index: concreteIndex, ids: missingIds });
      if ('hits' in response && (response.timed_out || (response._shards?.failed || 0) > 0)) throw new Error('고정 상품 검색 결과가 불완전합니다.');
      const docs = 'hits' in response
        ? response.hits.hits.map((hit) => ({ _index: hit._index, _id: hit._id || '', found: Boolean(hit._source), _source: hit._source }))
        : response.docs as Array<{ _index?: string; _id: string; found?: boolean; _source?: GoodsDocument }>;
      for (const doc of docs) if (doc.found && doc._source) {
        const categoryAdjustment = diagnosePreparedCategoryAdjustment(doc._source as Record<string, unknown>, rankingConfig.categoryAdjustment, preparedCategoryAdjustment);
        finalHits.push({ hit: { _index: doc._index || concreteIndex, _id: doc._id, _source: doc._source }, keyword: 0, vector: 0, keywordRaw: 0, vectorRaw: 0, keywordRank: null, vectorRank: null, rrfTotal: 0, popularityRaw: 0, popularityNormalized: 0, popularityBoost: 0, businessRuleBaseScore: 0, ruleMultiplier: 1, matchedRules: [], categoryAdjustment, categoryMultiplier: rankingConfig.categoryAdjustment.enabled ? categoryAdjustment.multiplier : 1, personalization: { boost: 0, multiplier: 1, product: 0, brand: 0, category: 0 }, total: 0, pinning: undefined });
      }
    }
    const pinnedSet = new Set(pinnedIds);
    const unpinned = finalHits.filter((item) => !pinnedSet.has(item.hit._id || ''));
    const pinnedById = new Map(finalHits.filter((item) => pinnedSet.has(item.hit._id || '')).map((item) => [item.hit._id || '', item]));
    finalHits = [...unpinned];
    let previousPosition = 0;
    for (const pin of pins) {
      const item = pinnedById.get(pin.goodsId);
      if (!item) continue;
      const appliedPosition = Math.min(Math.max(pin.position, previousPosition + 1), finalHits.length + 1);
      previousPosition = appliedPosition;
      item.pinning = { ruleId: pin.rule.id, query: pin.rule.query, requestedPosition: pin.position, appliedPosition };
      finalHits.splice(appliedPosition - 1, 0, item);
    }
  }
  const pagedHits = finalHits.slice((page - 1) * size, page * size);
  const rankingFinishedAt = performance.now();
  addSpan('ranking', rankingStartedAt, rankingFinishedAt);
  const pageDocs = pagedHits.filter((item) => Boolean(item.hit._id)).map((item) => ({ _index: item.hit._index || concreteIndex, _id: item.hit._id || '' }));
  const documentLoadStartedAt = performance.now();
  const pageSources = new Map<string, GoodsDocument>();
  if (pageDocs.length) {
    const response = await elasticClient.mget<GoodsDocument>({ docs: pageDocs, _source_excludes: [vectorField] });
    for (const doc of response.docs as Array<{ _index: string; _id: string; found?: boolean; _source?: GoodsDocument }>) {
      if (doc.found && doc._source) pageSources.set(`${doc._index}\0${doc._id}`, doc._source);
    }
  }
  const hydratedPagedHits = pagedHits.filter((item) => pageSources.has(`${item.hit._index || concreteIndex}\0${item.hit._id || ''}`)).map((item) => ({
    ...item,
    hit: { ...item.hit, _source: pageSources.get(`${item.hit._index || concreteIndex}\0${item.hit._id || ''}`) },
  }));
  const documentLoadFinishedAt = performance.now();
  addSpan('document-load', documentLoadStartedAt, documentLoadFinishedAt);

  return {
    query: queryText,
    queryAnalysis: {
      field: contentsSearch ? 'title' : 'goods_nm',
      cleanedQuery: keywordQueryText,
      removedRequestExpressions: [...new Set([...requestAnalysis.removedExpressions, ...keywordRequestAnalysis.removedExpressions])],
      tokens: remainingAnalyzed?.tokens?.map((token) => ({ token: token.token, position: token.position, type: token.type })) ?? [],
      originalTokens: policy.originalTokens,
      effectiveTokens: effectivePolicy.effectiveTokens,
      removedShortTokens: effectivePolicy.removedShortTokens,
      removedStopwords: effectivePolicy.removedStopwords,
      removedContextTokens: effectivePolicy.removedContextTokens,
      synonymExpansions: effectivePolicy.synonymExpansions,
      synonymExpansionDetails: effectivePolicy.synonymExpansionDetails,
      tokenDiagnostics: effectivePolicy.tokenDiagnostics,
      warnings: policy.warnings,
      effectiveQuery: effectivePolicy.effectiveQuery,
    },
    page,
    size,
    total: finalHits.length,
    searchMode: queryVector && !vectorFailed && !usedStructuredFilterFallback ? 'hybrid' : 'lexical',
    searchModeReason: usedStructuredFilterFallback ? '구조화 필터 잔여 검색어 무결과로 필터 전용 후보를 조회했습니다.' : aiAnalysis.failed ? 'ai_unavailable' : vectorFailed ? 'vector_unavailable' : embeddingFailed ? 'embedding_unavailable' : adaptiveDecision.reason,
    scoreFusion: { method: 'rrf', rankConstant: RRF_RANK_CONSTANT, rankWindowSize, vectorRankWindowSize, popularity: rankingConfig.popularity },
      items: hydratedPagedHits.map(({ hit, keyword, vector, keywordRaw, vectorRaw, keywordRank, vectorRank, rrfTotal, popularityRaw, popularityNormalized, popularityBoost, businessRuleBaseScore, ruleMultiplier, matchedRules, categoryAdjustment, categoryMultiplier, personalization, total, pinning }) => ({
      id: hit._id,
      score: total,
      ...(hit.sort ? { sortValues: [...hit.sort] } : {}),
      scores: { keyword, vector, total, rrfTotal, popularityRaw, popularityNormalized, popularityBoost, keywordRaw, vectorRaw, keywordRank, vectorRank, businessRuleBaseScore, businessRuleMultiplier: ruleMultiplier, ...(personalizationProfile ? { personalization } : {}), ...(!contentsSearch && rankingConfig.categoryAdjustment.enabled ? { categoryAdjustment: { ...categoryAdjustment, multiplier: categoryMultiplier } } : {}), businessRules: matchedRules.map((rule) => ({ id: rule.id, name: rule.name, adjustment: rule.adjustment, field: rule.condition.field, operator: rule.condition.operator, expectedValue: rule.condition.value, actualValue: getRuleSourceValue(hit._source || {}, rule.condition.field) })) },
      ...(pinning ? { pinning } : {}),
      ...hit._source,
    })),
    policyWarnings: policy.warnings,
    appliedFilters: [...filterAnalysis.matchedRules.map((rule) => ({ id: rule.id, name: rule.name, field: rule.field, values: rule.values, ...(rule.range ? { range: rule.range } : {}) })), ...structuredIntent.appliedFilters],
    candidateFallback: { applied: usedStructuredFilterFallback, reason: usedStructuredFilterFallback ? 'structured_filter_residual_no_results' : null, abandonedQuery: usedStructuredFilterFallback ? effectivePolicy.effectiveQuery : null },
    timingWaterfall: { currentSearch: { totalMs: Math.max(0, documentLoadFinishedAt - totalStartedAt), spans: waterfallSpans, source: 'own' } },
    aiAnalysis,
    timings: {
      settingsMs: Math.round(settingsResult.elapsedMs),
      morphologyAnalysisMs: Math.round(initialMorphologyAnalysisMs) + Math.round(additionalMorphologyAnalysisMs),
      initialMorphologyAnalysisMs: Math.round(initialMorphologyAnalysisMs),
      additionalMorphologyAnalysisMs: Math.round(additionalMorphologyAnalysisMs),
      initialParallelPreparationMs: Math.round(initialParallelPreparationMs),
      queryAnalysisMs: Math.round(queryAnalysisMs),
      aiMs: Math.round(aiFinishedAt - aiStartedAt),
      embeddingMs: Math.round(embeddingFinishedAt - embeddingStartedAt),
      candidatePreparationMs: Math.round(candidateSearchStartedAt - candidatePreparationStartedAt),
      candidateSearchMs: Math.round(candidateSearchFinishedAt - candidateSearchStartedAt),
      keywordCandidateSearchMs: Math.round(initialKeywordTook + (usedStructuredFilterFallback ? lexicalResult.took ?? 0 : 0)),
      vectorCandidateSearchMs: Math.round(vectorResult && 'hits' in vectorResult ? vectorResult.took ?? 0 : 0),
      fallbackCandidateSearchMs: Math.round(fallbackCandidateSearchMs),
      candidateResultProcessingMs: Math.max(0, Math.round(categoryPreparationStartedAt - candidateSearchFinishedAt)),
      categoryCatalogMs: Math.round(categoryCatalogFinishedAt - categoryCatalogStartedAt),
      categoryCatalogCacheStatus: categoryCatalog.cacheStatus,
      categoryCatalogKey: categoryCatalog.cacheKey,
      categoryCatalogCount: categoryCatalog.categories.length,
      categoryCatalogLoadMethod: categoryCatalog.cacheStatus === 'skipped' ? 'skipped' : categoryCatalog.loadMethod,
      categoryPreparationMs: Math.round(categoryPreparationFinishedAt - categoryPreparationStartedAt),
      personalizationMs: Math.round(personalizationResult.elapsedMs),
      rankingMs: Math.round(rankingFinishedAt - rankingStartedAt),
      documentLoadMs: Math.round(documentLoadFinishedAt - documentLoadStartedAt),
      totalMs: Math.round(documentLoadFinishedAt - totalStartedAt),
      settingsCacheStatus: runtimeSettings.cacheStatus,
      aiCacheStatus: !rankingConfig.ai.enabled || !adaptiveDecision.useVector ? 'skipped' : aiAnalysis.cached ? 'hit' : 'miss',
      embeddingCacheStatus: embeddingResult?.cacheStatus || 'skipped',
      personalizationCacheStatus: personalizationResult.cacheStatus,
      requestCacheStatus: 'miss',
    },
  };
}

const searchFlights = new Map<string, Promise<GoodsSearchResult>>();

/** 같은 프로세스에 동시에 들어온 완전히 동일한 검색은 한 번만 실행하고 결과를 함께 사용한다. */
export async function runGoodsSearch(
  queryText: string,
  page: number,
  size: number,
  targetIndex = GOODS_INDEX,
  rankingConfigOverride?: SearchRankingConfig,
  sortOptions?: unknown[],
  bypassSettingsCache = false,
  memberNo?: string | null,
): Promise<GoodsSearchResult> {
  const key = JSON.stringify([targetIndex, queryText, page, size, rankingConfigOverride || null, sortOptions || null, bypassSettingsCache, memberNo || null]);
  const currentFlight = searchFlights.get(key);
  if (currentFlight) {
    const result = await currentFlight;
    return { ...result, timings: { ...result.timings, requestCacheStatus: 'shared' }, timingWaterfall: { currentSearch: { ...result.timingWaterfall.currentSearch, source: 'shared' } } };
  }

  const flight = withSearchBudget(searchTimeout('SEARCH_TOTAL_TIMEOUT_MS', 15000, 15000), () => runGoodsSearchOnce(queryText, page, size, targetIndex, rankingConfigOverride, sortOptions, bypassSettingsCache, memberNo));
  searchFlights.set(key, flight);
  try {
    return await flight;
  } finally {
    if (searchFlights.get(key) === flight) searchFlights.delete(key);
  }
}

/**
 * 본 검색의 keywordRaw를 분해한 값이 아니라, 같은 검색어를 필드별로 독립 실행한 매칭 진단점수다.
 * 상위 결과 ID만 한 번 더 조회해 N건의 _explain 호출을 피한다.
 */
export async function diagnoseKeywordFields(
  queryText: string,
  ids: string[],
  config: SearchRankingConfig,
  targetIndex = GOODS_INDEX,
): Promise<Map<string, KeywordFieldDiagnostic[]>> {
  const diagnostics = new Map<string, KeywordFieldDiagnostic[]>();
  if (!ids.length || !queryText.trim()) return diagnostics;
  const fields = config.fields.filter((field) => field.enabled);
  const nameMap = new Map(fields.map((field, index) => [`field_${index}`, field]));
  const highlightFields = Object.fromEntries(fields.map((field) => [field.field, {}]));
  const response = await elasticClient.search<GoodsDocument>({
    index: targetIndex,
    size: ids.length,
    query: {
      bool: {
        filter: [{ ids: { values: ids } }],
        should: fields.map((field, index) => ({
          simple_query_string: {
            query: queryText,
            fields: [`${field.field}^${field.boost}`],
            default_operator: 'or',
            _name: `field_${index}`,
          },
        })),
        minimum_should_match: 0,
      },
    },
    include_named_queries_score: true,
    _source: false,
    highlight: {
      pre_tags: ['\uE000'],
      post_tags: ['\uE001'],
      number_of_fragments: 3,
      fragment_size: 300,
      require_field_match: true,
      fields: highlightFields,
    },
  });

  for (const hit of response.hits.hits) {
    if (!hit._id) continue;
    const matched = hit.matched_queries as unknown;
    const highlights = hit.highlight || {};
    const rows: KeywordFieldDiagnostic[] = [];
    if (matched && !Array.isArray(matched) && typeof matched === 'object') {
      for (const [name, rawScore] of Object.entries(matched as Record<string, unknown>)) {
        const field = nameMap.get(name);
        if (!field) continue;
        const score = Number(rawScore);
        rows.push({
          field: field.field,
          boost: field.boost,
          diagnosticScore: Number.isFinite(score) ? score : null,
          highlightedValues: highlights[field.field]?.map(String) || [],
        });
      }
    } else if (Array.isArray(matched)) {
      for (const name of matched) {
        const field = nameMap.get(String(name));
        if (field) rows.push({
          field: field.field,
          boost: field.boost,
          diagnosticScore: null,
          highlightedValues: highlights[field.field]?.map(String) || [],
        });
      }
    }
    diagnostics.set(hit._id, rows.sort((left, right) => (right.diagnosticScore ?? -1) - (left.diagnosticScore ?? -1)));
  }
  return diagnostics;
}
