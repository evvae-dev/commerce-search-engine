import type { NextApiRequest, NextApiResponse } from 'next';

import { getGoodsIndex } from '../../../../constant/goods-index.constant.mjs';
import { requireAdminAuthApi } from '../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../service/admin-request-validation';
import { sendInternalServerError } from '../../../../service/api-error';
import { compileRequestExpressions, normalizeRequestExpressions, removeRequestExpressions, RequestExpressionInputError } from '../../../../service/request-expression';
import { getRequestExpressionConfig, getSearchDictionaryErrorStatus, listDictionaryTargets, saveRequestExpressionConfig, validateRequestExpressionTarget, type DictionaryRevision } from '../../../../service/search-dictionary-service';
import { invalidateSearchRuntimeSettings } from '../../../../service/search-runtime-settings-service';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requester = await requireAdminAuthApi(req, res);
  if (!requester) return;
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST', 'PUT'].includes(req.method || '')) {
    res.setHeader('Allow', 'GET, POST, PUT');
    return res.status(405).json({ success: false, errorMessage: '허용되지 않은 HTTP 메서드입니다.' });
  }
  if (req.method !== 'GET' && !isSameOriginJsonRequest(req)) return res.status(403).json({ success: false, errorMessage: '동일 출처의 JSON 요청만 허용됩니다.' });
  try {
    const targetIndex = await validateRequestExpressionTarget(req.method === 'GET' ? req.query.targetIndex ?? getGoodsIndex('prd') : req.body?.targetIndex);
    if (req.method === 'GET') {
      const [saved, targets] = await Promise.all([getRequestExpressionConfig(targetIndex), listDictionaryTargets()]);
      return res.status(200).json({ success: true, config: saved, targets });
    }
    const phrases = normalizeRequestExpressions(req.body?.phrases);
    if (req.method === 'POST') {
      const text = req.body?.text;
      if (typeof text !== 'string' || text.length > 500) throw new RequestExpressionInputError('미리보기 검색어는 500자 이하로 입력해 주세요.');
      return res.status(200).json({ success: true, preview: removeRequestExpressions(text, compileRequestExpressions(phrases)) });
    }
    const revision = req.body?.revision as DictionaryRevision | null | undefined;
    if (revision !== null && (!revision || !Number.isInteger(revision.seqNo) || revision.seqNo < 0 || !Number.isInteger(revision.primaryTerm) || revision.primaryTerm < 1)) {
      throw new RequestExpressionInputError('설정 revision이 올바르지 않습니다. 새로고침 후 다시 저장해 주세요.');
    }
    const saved = await saveRequestExpressionConfig({ targetIndex, phrases }, requester, revision);
    invalidateSearchRuntimeSettings(targetIndex);
    return res.status(200).json({ success: true, config: saved });
  } catch (error) {
    if (getSearchDictionaryErrorStatus(error) === 409) return res.status(409).json({ success: false, errorCode: 'CONFIG_CONFLICT', errorMessage: '다른 사용자가 먼저 변경했습니다. 새로고침 후 다시 저장해 주세요.' });
    if (error instanceof RequestExpressionInputError) return res.status(422).json({ success: false, errorCode: 'INVALID_REQUEST_EXPRESSION', errorMessage: error.message });
    return sendInternalServerError(res, error);
  }
}
