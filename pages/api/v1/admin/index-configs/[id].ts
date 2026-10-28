import type { NextApiRequest, NextApiResponse } from 'next';

import { requireAdminAuthApi } from '../../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../../service/admin-request-validation';
import {
  deleteIndexingConfig,
  hasActiveIndexingJob,
  type IndexingConfigInput,
  updateIndexingConfig,
} from '../../../../../service/indexing-config-service';
import { reconcileIndexingCron } from '../../../../../service/cron-scheduler';

function getId(req: NextApiRequest): string | null {
  const value = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  return value && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const requester = await requireAdminAuthApi(req, res);
  if (!requester) return;
  const id = getId(req);
  if (!id) return res.status(400).json({ success: false, errorMessage: '설정 ID가 올바르지 않습니다.' });
  if (!['PUT', 'DELETE'].includes(req.method || '')) {
    return res.status(405).json({ success: false, errorMessage: '허용되지 않은 HTTP 메서드입니다.' });
  }
  if (!isSameOriginJsonRequest(req)) {
    return res.status(403).json({ success: false, errorMessage: '동일 출처의 JSON 요청만 허용됩니다.' });
  }

  try {
    if (req.method === 'DELETE' && await hasActiveIndexingJob(id)) {
      return res.status(409).json({
        success: false,
        errorCode: 'INDEXING_CONFIG_ACTIVE',
        errorMessage: '이 설정의 색인 작업이 실행 또는 대기 중이어서 변경할 수 없습니다.',
      });
    }

    if (req.method === 'PUT') {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ success: false, errorMessage: '요청 바디가 올바르지 않습니다.' });
      }
      const config = await updateIndexingConfig(id, req.body as IndexingConfigInput);
      await reconcileIndexingCron();
      return res.status(200).json({ success: true, config });
    }

    await deleteIndexingConfig(id);
    await reconcileIndexingCron();
    return res.status(200).json({ success: true });
  } catch (error) {
    const status = (error as { statusCode?: number })?.statusCode || 400;
    return res.status(status).json({
      success: false,
      errorCode: status === 404 ? 'INDEXING_CONFIG_NOT_FOUND' : 'INVALID_INDEXING_CONFIG',
      errorMessage: error instanceof Error ? error.message : '인덱스 설정 처리에 실패했습니다.',
    });
  }
}
