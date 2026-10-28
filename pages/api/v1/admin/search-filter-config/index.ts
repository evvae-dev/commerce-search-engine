import type { NextApiRequest, NextApiResponse } from 'next';
import { requireAdminAuthApi } from '../../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../../service/admin-request-validation';
import { getSearchFilterError, getSearchFilterConfig, saveSearchFilterConfig, validateSearchFilterDraft } from '../../../../../service/search-filter-service';
import { evaluateSearchFilters } from '../../../../../service/search-filter-evaluator';
import { invalidateSearchRuntimeSettings } from '../../../../../service/search-runtime-settings-service';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requester = await requireAdminAuthApi(req, res); if (!requester) return;
  try {
    if (req.method === 'GET') {
      const targetIndex = typeof req.query.targetIndex === 'string' ? req.query.targetIndex : '';
      if (!targetIndex) return res.status(400).json({ success: false, errorMessage: '적용 인덱스를 입력해 주세요.' });
      return res.status(200).json({ success: true, config: await getSearchFilterConfig(targetIndex) });
    }
    if (!isSameOriginJsonRequest(req)) return res.status(403).json({ success: false, errorMessage: '동일 출처의 JSON 요청만 허용됩니다.' });
    if (req.method === 'POST') {
      const query = typeof req.body?.query === 'string' ? req.body.query : '';
      const targetIndex = String(req.body?.targetIndex || '');
      const rules = Array.isArray(req.body?.rules)
        ? await validateSearchFilterDraft(targetIndex, req.body.rules)
        : (await getSearchFilterConfig(targetIndex)).rules;
      return res.status(200).json({ success: true, ...evaluateSearchFilters(query, rules) });
    }
    if (req.method === 'PUT') {
      const config = await saveSearchFilterConfig(req.body, requester);
      invalidateSearchRuntimeSettings(config.targetIndex);
      return res.status(200).json({ success: true, config });
    }
    return res.status(405).json({ success: false, errorMessage: '허용되지 않은 메서드입니다.' });
  } catch (error) { const result = getSearchFilterError(error); return res.status(result.statusCode).json({ success: false, errorMessage: result.message }); }
}
