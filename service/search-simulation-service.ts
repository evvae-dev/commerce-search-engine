import type { NextApiRequest, NextApiResponse } from 'next';

import { getGoodsIndex, isGoodsIndex } from '../constant/goods-index.constant.mjs';
import { isContentsIndex } from '../constant/contents-index.constant';
import { sendInternalServerError } from './api-error';
import { diagnoseKeywordFields, runGoodsSearch } from './goods-search-service';
import {
  getSearchRankingConfig,
  validateSearchRankingFields,
  listAvailableNumericFields, validatePopularityFields,
} from './search-ranking-service';
import { PopularityConfigValidationError, validatePopularityConfig } from './popularity-formula';
import { getSortConfig } from './sort-config-service';
import { SearchPolicyBlockError } from './search-query-policy';
import { EmptySearchQueryError } from './request-expression';
import { validateAiSearchConfig } from './ai-search-query-service';
import { validateCategoryAdjustment } from './category-adjustment';
import { searchLegacyGoods } from './legacy-search-service';
import { validateAdaptiveSearch } from './adaptive-search';
import { validatePersonalizationConfig } from './personalization-config';

const RESULT_SIZES = new Set([10, 30, 50, 100]);

function readSourcePath(source: Record<string, unknown>, path: string): { found: boolean; value?: unknown; sourcePath?: string } {
  if (Object.prototype.hasOwnProperty.call(source, path)) {
    return { found: true, value: source[path], sourcePath: path };
  }
  const readNested = (candidate: string): { found: boolean; value?: unknown; sourcePath?: string } => {
    let current: unknown = source;
    for (const segment of candidate.split('.')) {
      if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
        return { found: false };
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return { found: true, value: current, sourcePath: candidate };
  };
  const exact = readNested(path);
  if (exact.found) return exact;
  const parentPath = path.replace(/\.(keyword|raw)$/, '');
  return parentPath === path ? { found: false } : readNested(parentPath);
}

function hasScoreSort(sortOptions: unknown[]): boolean {
  return sortOptions.some((item) =>
    item === '_score' || (Boolean(item) && typeof item === 'object' && !Array.isArray(item) && Object.prototype.hasOwnProperty.call(item, '_score')),
  );
}


export async function simulateSearch(req: NextApiRequest, res: NextApiResponse, savedFieldsOnly = false) {
  const simulationStartedAt = performance.now();
  const query = typeof req.body?.q === 'string' ? req.body.q.trim() : '';
  const targetIndex = typeof req.body?.targetIndex === 'string' ? req.body.targetIndex.trim() : getGoodsIndex('prd');
  const sortConfigId = typeof req.body?.sortConfigId === 'string' ? req.body.sortConfigId.trim() : '';
  const page = req.body?.page === undefined ? 1 : Number(req.body.page);
  const size = req.body?.size === undefined ? 10 : Number(req.body.size);
  if (!query || query.length > 200) {
    return res.status(400).json({ success: false, errorCode: 'INVALID_QUERY', errorMessage: '검색어는 1~200자로 입력해 주세요.' });
  }
  if (!Number.isInteger(page) || page < 1) {
    return res.status(400).json({ success: false, errorCode: 'INVALID_PAGE', errorMessage: '페이지는 1 이상이어야 합니다.' });
  }
  if (!Number.isInteger(size) || !RESULT_SIZES.has(size)) {
    return res.status(400).json({ success: false, errorCode: 'INVALID_SIZE', errorMessage: '결과 수는 10, 30, 50, 100 중에서 선택해 주세요.' });
  }
  if (!isGoodsIndex(targetIndex) && !isContentsIndex(targetIndex)) {
    return res.status(400).json({ success: false, errorCode: 'INVALID_TARGET_INDEX', errorMessage: '대상 인덱스는 운영 또는 개발만 선택할 수 있습니다.' });
  }

  try {
    const contents = isContentsIndex(targetIndex);
    const [savedConfig, sortConfig] = await Promise.all([
      getSearchRankingConfig(targetIndex),
      sortConfigId ? getSortConfig(sortConfigId) : Promise.resolve(null),
    ]);
    if (sortConfigId && (!sortConfig || sortConfig.targetIndex !== targetIndex)) {
      return res.status(400).json({ success: false, errorCode: 'INVALID_SORT_CONFIG', errorMessage: '선택한 인덱스에 적용할 수 있는 정렬 설정이 아닙니다.' });
    }
    const fields = await validateSearchRankingFields(savedFieldsOnly ? savedConfig.fields : (req.body?.fields ?? savedConfig.fields));
    const popularity = validatePopularityConfig(req.body?.popularity ?? savedConfig.popularity);
    const ai = validateAiSearchConfig(req.body?.ai ?? savedConfig.ai);
    const categoryAdjustment = validateCategoryAdjustment(req.body?.categoryAdjustment ?? savedConfig.categoryAdjustment);
    const adaptiveSearch = validateAdaptiveSearch(req.body?.adaptiveSearch ?? savedConfig.adaptiveSearch);
    const personalization = validatePersonalizationConfig(req.body?.personalization ?? savedConfig.personalization);
    const testMemberNo = typeof req.body?.testMemberNo === 'string' && /^\d+$/.test(req.body.testMemberNo.trim()) ? req.body.testMemberNo.trim() : null;
    if (!contents) validatePopularityFields(popularity.referencedFields, await listAvailableNumericFields(targetIndex));
    // 화면 초안은 이 요청에서만 사용하며 저장된 공개 검색 설정은 변경하지 않는다.
    const draftConfig = { ...savedConfig, fields, popularity, ai, categoryAdjustment, adaptiveSearch, personalization };
    const preparationFinishedAt = performance.now();
    const simulationPreparationMs = Math.round(preparationFinishedAt - simulationStartedAt);
    const legacyStartedAt = performance.now();
    let legacySearchMs = 0;
    let legacyFinishedAt = legacyStartedAt;
    const legacyPromise = contents ? Promise.resolve({ items: [] }) : searchLegacyGoods({
      query,
      page,
      size,
      environment: targetIndex === getGoodsIndex('dev') ? 'dev' : 'prd',
    }).then((items) => ({ items })).catch((error) => ({
      items: [],
      error: error instanceof Error && error.name === 'TimeoutError'
        ? '기본 키워드 검색 응답 시간이 초과되었습니다.'
        : '기본 키워드 검색 결과를 가져오지 못했습니다.',
    })).finally(() => { legacyFinishedAt = performance.now(); legacySearchMs = legacyFinishedAt - legacyStartedAt; });
    const currentSearchStartedAt = performance.now();
    const result = await runGoodsSearch(query, page, size, targetIndex, draftConfig, sortConfig?.sortOptions, true, testMemberNo);
    const currentSearchFinishedAt = performance.now();
    const currentSearchMs = Math.round(currentSearchFinishedAt - currentSearchStartedAt);
    const ids = result.items.map((item) => item.id).filter((id): id is string => Boolean(id));
    // 실제 키워드 검색과 동일하게 불용어 제거·동의어 확장이 반영된 검색어로 필드별 점수를 진단한다.
    const diagnosticsStartedAt = performance.now();
    const diagnostics = await diagnoseKeywordFields(result.queryAnalysis.effectiveQuery, ids, draftConfig, targetIndex);
    const diagnosticsFinishedAt = performance.now();
    const legacyWaitStartedAt = performance.now();
    const legacy = await legacyPromise;
    const legacyWaitFinishedAt = performance.now();
    const legacyWaitMs = Math.round(legacyWaitFinishedAt - legacyWaitStartedAt);
    const keywordDiagnosticsMs = Math.round(diagnosticsFinishedAt - diagnosticsStartedAt);
    const items = result.items.map((item) => {
      const source = item as Record<string, unknown>;
      const sortExplanation = sortConfig ? {
        sortName: sortConfig.sortName,
        description: sortConfig.description,
        fields: sortConfig.referencedFields.map((field) => {
          const resolved = readSourcePath(source, field);
          return {
            field,
            sourcePath: resolved.sourcePath || null,
            value: resolved.found ? (resolved.value ?? null) : null,
            state: resolved.found ? (resolved.value === null || resolved.value === undefined ? 'null' : 'present') : 'absent',
          };
        }),
        sortValues: item.sortValues || [],
        scoreTiebreaker: hasScoreSort(sortConfig.sortOptions) ? null : item.sortValues?.[sortConfig.sortOptions.length] ?? null,
      } : undefined;
      return {
        ...item,
        ...(sortExplanation ? { sortExplanation } : {}),
        matchedFields: item.id
          ? (diagnostics.get(item.id) || []).map((matched) => {
              const resolved = readSourcePath(source, matched.field);
              return { ...matched, matchedValue: resolved.found ? (resolved.value ?? null) : null };
            })
          : [],
        embeddingSource: source.embedding_source === 'geo' ? 'geo' : 'keywords',
        embeddingText: contents || typeof source.embedding_text !== 'string' ? '' : source.embedding_text,
      };
    });
    const responseAssemblyFinishedAt = performance.now();
    const measuredTotalMs = Math.round(responseAssemblyFinishedAt - simulationStartedAt);
    const knownTotalMs = simulationPreparationMs + currentSearchMs + keywordDiagnosticsMs + legacyWaitMs;
    const simulationOtherMs = Math.max(0, measuredTotalMs - knownTotalMs);
    const simulationTotalMs = knownTotalMs + simulationOtherMs;
    const simulationSpan = (id: string, start: number, end: number, lane?: string) => ({ id, startMs: Math.max(0, start - simulationStartedAt), durationMs: Math.max(0, end - start), ...(lane ? { lane } : {}) });
    return res.status(200).json({
      success: true,
      ...result,
      timings: {
        ...result.timings,
        simulationPreparationMs,
        currentSearchMs,
        keywordDiagnosticsMs,
        legacyWaitMs,
        simulationOtherMs,
        simulationTotalMs,
        legacySearchMs: Math.round(legacySearchMs),
      },
      timingWaterfall: {
        simulation: {
          totalMs: Math.max(0, responseAssemblyFinishedAt - simulationStartedAt),
          spans: [
            simulationSpan('preparation', simulationStartedAt, preparationFinishedAt),
            simulationSpan('dispatch-overhead', preparationFinishedAt, currentSearchStartedAt),
            simulationSpan('current-search', currentSearchStartedAt, currentSearchFinishedAt, 'current'),
            simulationSpan('diagnostic-preparation', currentSearchFinishedAt, diagnosticsStartedAt),
            simulationSpan('keyword-diagnostics', diagnosticsStartedAt, diagnosticsFinishedAt, 'current'),
            simulationSpan('legacy-wait-preparation', diagnosticsFinishedAt, legacyWaitStartedAt),
            simulationSpan('legacy-wait', legacyWaitStartedAt, legacyWaitFinishedAt, 'current'),
            simulationSpan('response-assembly', legacyWaitFinishedAt, responseAssemblyFinishedAt),
            simulationSpan('legacy-search', legacyStartedAt, legacyFinishedAt, 'legacy'),
          ],
        },
        currentSearch: result.timingWaterfall.currentSearch,
      },
      totalPages: Math.max(1, Math.ceil(result.total / size)),
      legacy,
      items,
    });
  } catch (error) {
    if (error instanceof PopularityConfigValidationError) {
      return res.status(400).json({ success: false, errorCode: 'INVALID_POPULARITY_CONFIG', errorMessage: error.message });
    }
    if (error instanceof SearchPolicyBlockError || error instanceof EmptySearchQueryError) {
      return res.status(422).json({ success: false, errorCode: error.code, errorMessage: error.message });
    }
    return sendInternalServerError(res, error);
  }
}
