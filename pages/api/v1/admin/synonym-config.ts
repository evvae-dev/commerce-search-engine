import type { NextApiRequest, NextApiResponse } from 'next';

import { getGoodsIndex } from '../../../../constant/goods-index.constant.mjs';
import { requireAdminAuthApi } from '../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../service/admin-request-validation';
import { sendInternalServerError } from '../../../../service/api-error';
import {
  getSearchDictionaryErrorStatus,
  getSynonymConfig,
  listDictionaryTargets,
  saveSynonymConfig,
  validateDictionaryInput,
  type DictionaryRevision,
} from '../../../../service/search-dictionary-service';
import { invalidateSearchRuntimeSettings } from '../../../../service/search-runtime-settings-service';

function targetIndex(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : getGoodsIndex('prd');
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requester = await requireAdminAuthApi(req, res);
  if (!requester) return;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method === 'GET') {
    try {
      const index = targetIndex(req.query.targetIndex);
      const [config, targets] = await Promise.all([getSynonymConfig(index), listDictionaryTargets()]);
      return res.status(200).json({ success: true, config, targets });
    } catch (error) { return sendInternalServerError(res, error); }
  }
  if (req.method === 'PUT') {
    if (!isSameOriginJsonRequest(req)) return res.status(403).json({ success: false, errorCode: 'FORBIDDEN_REQUEST', errorMessage: '동일 출처의 JSON 요청만 허용됩니다.' });
    try {
      const input = await validateDictionaryInput(req.body, 'synonym') as { targetIndex: string; rules: NonNullable<Awaited<ReturnType<typeof validateDictionaryInput>>['rules']> };
      const revision = req.body?.revision as DictionaryRevision | undefined;
      if (!revision || !Number.isInteger(revision.seqNo) || !Number.isInteger(revision.primaryTerm)) throw new Error('설정 revision이 올바르지 않습니다.');
      const config = await saveSynonymConfig(input, requester, revision);
      invalidateSearchRuntimeSettings(input.targetIndex);
      return res.status(200).json({ success: true, config });
    } catch (error) {
      if (getSearchDictionaryErrorStatus(error) === 409) return res.status(409).json({ success: false, errorCode: 'CONFIG_CONFLICT', errorMessage: '다른 사용자가 먼저 변경했습니다. 최신 설정을 확인한 뒤 다시 저장해 주세요.' });
      return res.status(422).json({ success: false, errorCode: 'INVALID_SYNONYM_CONFIG', errorMessage: error instanceof Error ? error.message : '동의어 설정이 올바르지 않습니다.' });
    }
  }
  return res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED', errorMessage: '허용되지 않은 HTTP 메서드입니다.' });
}
