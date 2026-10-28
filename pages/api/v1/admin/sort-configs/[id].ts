import type { NextApiRequest, NextApiResponse } from 'next';

import { requireAdminAuthApi } from '../../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../../service/admin-request-validation';
import {
  deleteSortConfig,
  getSortConfigError,
  updateSortConfig,
  type SortConfigInput,
} from '../../../../../service/sort-config-service';

function getId(req: NextApiRequest): string | null {
  const value = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  return value && /^[a-zA-Z0-9-]{1,100}$/.test(value) ? value : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requester = await requireAdminAuthApi(req, res);
  if (!requester) return;
  const id = getId(req);
  if (!id) return res.status(400).json({ success: false, errorCode: 'INVALID_ID', errorMessage: '정렬 설정 ID가 올바르지 않습니다.' });
  if (!['PUT', 'DELETE'].includes(req.method || '')) {
    return res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED', errorMessage: '허용되지 않은 HTTP 메서드입니다.' });
  }
  if (!isSameOriginJsonRequest(req)) {
    return res.status(403).json({ success: false, errorCode: 'FORBIDDEN_REQUEST', errorMessage: '동일 출처의 JSON 요청만 허용됩니다.' });
  }

  try {
    if (req.method === 'PUT') {
      const config = await updateSortConfig(id, req.body as SortConfigInput, requester);
      return res.status(200).json({ success: true, config });
    }
    await deleteSortConfig(id);
    return res.status(200).json({ success: true });
  } catch (error) {
    const detail = getSortConfigError(error);
    return res.status(detail.statusCode).json({ success: false, errorCode: detail.errorCode, errorMessage: detail.message });
  }
}
