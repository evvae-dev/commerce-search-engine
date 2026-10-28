import type { NextApiRequest, NextApiResponse } from 'next';

import { getGoodsIndex, isGoodsIndex } from '../../../../../constant/goods-index.constant.mjs';
import { isContentsIndex } from '../../../../../constant/contents-index.constant';
import { requireAdminAuthApi } from '../../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../../service/admin-request-validation';
import { sendInternalServerError } from '../../../../../service/api-error';
import {
  getSearchRankingConfig,
  getSearchRankingErrorStatus,
  listAvailableSearchFields,
  listAvailableNumericFields,
  validatePopularityFields,
  saveSearchRankingConfig,
  validateSearchRankingFields,
  type SearchRankingRevision,
} from '../../../../../service/search-ranking-service';
import { validatePopularityConfig } from '../../../../../service/popularity-formula';
import { getAiSearchRuntime, validateAiSearchConfig } from '../../../../../service/ai-search-query-service';
import { invalidateSearchRuntimeSettings } from '../../../../../service/search-runtime-settings-service';
import { validateCategoryAdjustment } from '../../../../../service/category-adjustment';
import { getCategoryCatalogForTarget } from '../../../../../service/category-catalog-service';
import { validateAdaptiveSearch } from '../../../../../service/adaptive-search';
import { validatePersonalizationConfig } from '../../../../../service/personalization-config';

function getTargetIndex(value: unknown): string | null {
  const normalized = Array.isArray(value) ? value[0] : value;
  const targetIndex = typeof normalized === 'string' ? normalized.trim() : getGoodsIndex('prd');
  return isGoodsIndex(targetIndex) || isContentsIndex(targetIndex) ? targetIndex : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requester = await requireAdminAuthApi(req, res);
  if (!requester) return;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'GET') {
    const targetIndex = getTargetIndex(req.query.targetIndex);
    if (!targetIndex) {
      return res.status(400).json({ success: false, errorCode: 'INVALID_TARGET_INDEX', errorMessage: '대상 인덱스는 운영 또는 개발만 선택할 수 있습니다.' });
    }
    try {
      const contents = isContentsIndex(targetIndex);
      const [config, availableFields, availableNumericFields, categoryCatalog] = await Promise.all([
        getSearchRankingConfig(targetIndex),
        listAvailableSearchFields(targetIndex), contents ? Promise.resolve([]) : listAvailableNumericFields(targetIndex), contents ? Promise.resolve({ categories: [], complete: false }) : getCategoryCatalogForTarget(targetIndex),
      ]);
      return res.status(200).json({ success: true, config, availableFields, availableNumericFields, categoryCatalog, aiRuntime: getAiSearchRuntime() });
    } catch (error) {
      return sendInternalServerError(res, error);
    }
  }

  if (req.method === 'PUT') {
    if (!isSameOriginJsonRequest(req)) {
      return res.status(403).json({ success: false, errorCode: 'FORBIDDEN_REQUEST', errorMessage: '동일 출처의 JSON 요청만 허용됩니다.' });
    }
    try {
      const targetIndex = getTargetIndex(req.body?.targetIndex);
      if (!targetIndex) {
        return res.status(400).json({ success: false, errorCode: 'INVALID_TARGET_INDEX', errorMessage: '대상 인덱스는 운영 또는 개발만 선택할 수 있습니다.' });
      }
      const revision = req.body?.revision as SearchRankingRevision | undefined;
      if (!revision || !Number.isInteger(revision.seqNo) || !Number.isInteger(revision.primaryTerm)) {
        return res.status(400).json({ success: false, errorCode: 'INVALID_REVISION', errorMessage: '설정 revision이 올바르지 않습니다.' });
      }
      const fields = await validateSearchRankingFields(req.body?.fields);
      const current = await getSearchRankingConfig(targetIndex);
      const popularity = validatePopularityConfig(req.body?.popularity ?? current.popularity);
      const ai = validateAiSearchConfig(req.body?.ai ?? current.ai);
      const categoryAdjustment = validateCategoryAdjustment(req.body?.categoryAdjustment ?? current.categoryAdjustment);
      const adaptiveSearch = validateAdaptiveSearch(req.body?.adaptiveSearch ?? current.adaptiveSearch);
      const personalization = validatePersonalizationConfig(req.body?.personalization ?? current.personalization);
      if (!isContentsIndex(targetIndex)) {
        const numericFields = await listAvailableNumericFields(targetIndex);
        validatePopularityFields(popularity.referencedFields, numericFields);
      }
      const config = await saveSearchRankingConfig(targetIndex, fields, current.keywordWeight, current.vectorWeight, requester, revision, popularity, ai, categoryAdjustment, adaptiveSearch, personalization);
      invalidateSearchRuntimeSettings(targetIndex);
      return res.status(200).json({ success: true, config });
    } catch (error) {
      if (getSearchRankingErrorStatus(error) === 409) {
        return res.status(409).json({ success: false, errorCode: 'CONFIG_CONFLICT', errorMessage: '다른 사용자가 먼저 설정을 변경했습니다. 입력값은 유지되므로 최신 설정을 확인한 뒤 다시 저장해 주세요.' });
      }
      return res.status(400).json({ success: false, errorCode: 'INVALID_SEARCH_RANKING', errorMessage: error instanceof Error ? error.message : '검색 가중치 설정이 올바르지 않습니다.' });
    }
  }

  return res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED', errorMessage: '허용되지 않은 HTTP 메서드입니다.' });
}
