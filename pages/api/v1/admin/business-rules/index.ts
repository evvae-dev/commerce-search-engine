import type { NextApiRequest, NextApiResponse } from 'next';
import { requireAdminAuthApi } from '../../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../../service/admin-request-validation';
import { createBusinessRule, getBusinessRuleError, listBusinessRulesWithStatus, listRuleConditionFields } from '../../../../../service/business-rule-service';
import { invalidateSearchRuntimeSettings } from '../../../../../service/search-runtime-settings-service';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requester = await requireAdminAuthApi(req, res); if (!requester) return;
  try {
    if (req.method === 'GET') {
      const targetIndex = typeof req.query.targetIndex === 'string' ? req.query.targetIndex : '';
      if (!targetIndex) return res.status(400).json({ success: false, errorMessage: '적용 인덱스를 입력해 주세요.' });
      const [rules, availableFields] = await Promise.all([listBusinessRulesWithStatus(targetIndex), listRuleConditionFields(targetIndex)]);
      return res.status(200).json({ success: true, rules, availableFields });
    }
    if (req.method === 'POST') {
      if (!isSameOriginJsonRequest(req)) return res.status(403).json({ success: false, errorMessage: '동일 출처 요청만 허용됩니다.' });
      const rule = await createBusinessRule(req.body, requester);
      invalidateSearchRuntimeSettings(rule.targetIndex);
      return res.status(201).json({ success: true, rule });
    }
    return res.status(405).json({ success: false, errorMessage: '허용되지 않은 메서드입니다.' });
  } catch (e) { const x = getBusinessRuleError(e); return res.status(x.statusCode).json({ success: false, errorMessage: x.message }); }
}
