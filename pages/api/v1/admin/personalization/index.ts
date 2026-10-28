import type { NextApiRequest, NextApiResponse } from 'next';

import { getGoodsIndex, isGoodsIndex } from '../../../../../constant/goods-index.constant.mjs';
import { requireAdminAuthApi } from '../../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../../service/admin-request-validation';
import { validatePersonalizationConfig } from '../../../../../service/personalization-config';
import { getSearchRankingConfig, getSearchRankingErrorStatus, saveSearchRankingConfig, type SearchRankingRevision } from '../../../../../service/search-ranking-service';
import { invalidateSearchRuntimeSettings } from '../../../../../service/search-runtime-settings-service';

function target(value: unknown): string | null {
  const index = typeof value === 'string' ? value.trim() : getGoodsIndex('prd');
  return isGoodsIndex(index) ? index : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requester = await requireAdminAuthApi(req, res);
  if (!requester) return;
  res.setHeader('Cache-Control', 'no-store');
  const targetIndex = target(req.method === 'GET' ? req.query.targetIndex : req.body?.targetIndex);
  if (!targetIndex) return res.status(400).json({ success: false, errorMessage: '대상 인덱스가 올바르지 않습니다.' });
  try {
    if (req.method === 'GET') {
      const config = await getSearchRankingConfig(targetIndex);
      return res.status(200).json({ success: true, config: config.personalization, revision: config.revision, updatedAt: config.updatedAt, updatedBy: config.updatedBy });
    }
    if (req.method === 'PUT') {
      if (!isSameOriginJsonRequest(req)) return res.status(403).json({ success: false, errorMessage: '동일 출처의 JSON 요청만 허용됩니다.' });
      const revision = req.body?.revision as SearchRankingRevision;
      if (!revision || !Number.isInteger(revision.seqNo) || !Number.isInteger(revision.primaryTerm)) return res.status(400).json({ success: false, errorMessage: '설정 revision이 올바르지 않습니다.' });
      const current = await getSearchRankingConfig(targetIndex);
      const personalization = validatePersonalizationConfig(req.body?.config);
      const saved = await saveSearchRankingConfig(targetIndex, current.fields, current.keywordWeight, current.vectorWeight, requester, revision, current.popularity, current.ai, current.categoryAdjustment, current.adaptiveSearch, personalization);
      invalidateSearchRuntimeSettings(targetIndex);
      return res.status(200).json({ success: true, config: saved.personalization, revision: saved.revision, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy });
    }
    return res.status(405).json({ success: false, errorMessage: '허용되지 않은 HTTP 메서드입니다.' });
  } catch (error) {
    if (getSearchRankingErrorStatus(error) === 409) {
      return res.status(409).json({ success: false, errorCode: 'CONFIG_CONFLICT', errorMessage: '다른 사용자가 먼저 설정을 변경했습니다. 최신 설정을 다시 불러온 뒤 저장해 주세요.' });
    }
    return res.status(400).json({ success: false, errorCode: 'INVALID_PERSONALIZATION', errorMessage: error instanceof Error ? error.message : '개인화 설정 처리에 실패했습니다.' });
  }
}
