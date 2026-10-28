import type { NextApiRequest, NextApiResponse } from 'next';
import { requireAdminAuthApi } from '../../../../../service/admin-auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await requireAdminAuthApi(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  return res.status(410).json({
    success: false,
    errorCode: 'LEGACY_CRON_API_REMOVED',
    errorMessage: '인덱스별 설정 API /api/v1/admin/index-configs/{id}에서 스케줄을 변경해 주세요.',
  });
}
