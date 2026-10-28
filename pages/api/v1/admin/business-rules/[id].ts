import type { NextApiRequest, NextApiResponse } from 'next';
import { requireAdminAuthApi } from '../../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../../service/admin-request-validation';
import { deleteBusinessRule, getBusinessRuleError, updateBusinessRule } from '../../../../../service/business-rule-service';
import { invalidateSearchRuntimeSettings } from '../../../../../service/search-runtime-settings-service';
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requester = await requireAdminAuthApi(req, res); if (!requester) return;
  const id = String(req.query.id);
  try { if (!isSameOriginJsonRequest(req)) return res.status(403).json({ success: false, errorMessage: '동일 출처 요청만 허용됩니다.' });
    if (req.method === 'PUT') {
      const rule = await updateBusinessRule(id, req.body, requester);
      invalidateSearchRuntimeSettings();
      return res.status(200).json({ success: true, rule });
    }
    if (req.method === 'DELETE') { await deleteBusinessRule(id); invalidateSearchRuntimeSettings(); return res.status(204).end(); }
    return res.status(405).json({ success: false, errorMessage: '허용되지 않은 메서드입니다.' });
  } catch (e) { const x = getBusinessRuleError(e); return res.status(x.statusCode).json({ success: false, errorMessage: x.message }); }
}
