import type { NextApiRequest, NextApiResponse } from 'next';
import { requireAdminAuthApi } from '../../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../../service/admin-request-validation';
import { simulateSearch } from '../../../../../service/search-simulation-service';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await requireAdminAuthApi(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED', errorMessage: '허용되지 않은 HTTP 메서드입니다.' });
  if (!isSameOriginJsonRequest(req)) return res.status(403).json({ success: false, errorCode: 'FORBIDDEN_REQUEST', errorMessage: '동일 출처의 JSON 요청만 허용됩니다.' });
  return simulateSearch(req, res);
}
