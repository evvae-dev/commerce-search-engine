import type { NextApiRequest, NextApiResponse } from 'next';

import { requireAdminAuthApi } from '../../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../../service/admin-request-validation';
import {
  deleteManagedIndexTemplate,
  getIndexTemplateError,
  updateManagedIndexTemplate,
  type IndexTemplateInput,
} from '../../../../../service/index-template-service';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

function getName(req: NextApiRequest): string | null {
  const value = Array.isArray(req.query.name) ? req.query.name[0] : req.query.name;
  return value && /^[a-z0-9][a-z0-9_-]{1,99}$/.test(value) ? value : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requester = await requireAdminAuthApi(req, res);
  if (!requester) return;
  const name = getName(req);
  if (!name) return res.status(400).json({ success: false, errorCode: 'INVALID_TEMPLATE_NAME', errorMessage: '템플릿명이 올바르지 않습니다.' });
  if (!['PUT', 'DELETE'].includes(req.method || '')) return res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED', errorMessage: '허용되지 않은 HTTP 메서드입니다.' });
  if (!isSameOriginJsonRequest(req)) return res.status(403).json({ success: false, errorCode: 'FORBIDDEN_REQUEST', errorMessage: '동일 출처의 JSON 요청만 허용됩니다.' });

  try {
    if (req.method === 'PUT') {
      await updateManagedIndexTemplate(name, req.body as IndexTemplateInput);
      return res.status(200).json({ success: true });
    }
    await deleteManagedIndexTemplate(name);
    return res.status(200).json({ success: true });
  } catch (error) {
    const detail = getIndexTemplateError(error);
    return res.status(detail.statusCode).json({ success: false, errorCode: detail.errorCode, errorMessage: detail.message });
  }
}
