import type { NextApiRequest, NextApiResponse } from 'next';

import { requireAdminAuthApi } from '../../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../../service/admin-request-validation';
import {
  createManagedIndexTemplate,
  getIndexTemplateError,
  listManagedIndexTemplates,
  type IndexTemplateInput,
} from '../../../../../service/index-template-service';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requester = await requireAdminAuthApi(req, res);
  if (!requester) return;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ success: true, ...(await listManagedIndexTemplates()) });
    }
    if (req.method === 'POST') {
      if (!isSameOriginJsonRequest(req)) return res.status(403).json({ success: false, errorCode: 'FORBIDDEN_REQUEST', errorMessage: '동일 출처의 JSON 요청만 허용됩니다.' });
      await createManagedIndexTemplate(req.body as IndexTemplateInput);
      return res.status(201).json({ success: true });
    }
    return res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED', errorMessage: '허용되지 않은 HTTP 메서드입니다.' });
  } catch (error) {
    const detail = getIndexTemplateError(error);
    return res.status(detail.statusCode).json({ success: false, errorCode: detail.errorCode, errorMessage: detail.message });
  }
}
