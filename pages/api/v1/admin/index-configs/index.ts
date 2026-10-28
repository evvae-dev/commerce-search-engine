import type { NextApiRequest, NextApiResponse } from 'next';

import { requireAdminAuthApi } from '../../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../../service/admin-request-validation';
import { sendInternalServerError } from '../../../../../service/api-error';
import { reconcileIndexingCron } from '../../../../../service/cron-scheduler';
import {
  createIndexingConfig,
  listIndexingConfigs,
  type IndexingConfigInput,
} from '../../../../../service/indexing-config-service';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const requester = await requireAdminAuthApi(req, res);
  if (!requester) return;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'GET') {
    try {
      return res.status(200).json({
        success: true,
        configs: await listIndexingConfigs(),
      });
    } catch (error) {
      return sendInternalServerError(res, error);
    }
  }

  if (req.method === 'POST') {
    if (!isSameOriginJsonRequest(req)) {
      return res.status(403).json({
        success: false,
        errorCode: 'FORBIDDEN_REQUEST',
        errorMessage: '동일 출처의 JSON 요청만 허용됩니다.',
      });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ success: false, errorMessage: '요청 바디가 올바르지 않습니다.' });
    }
    try {
      const config = await createIndexingConfig(req.body as IndexingConfigInput);
      await reconcileIndexingCron();
      return res.status(201).json({ success: true, config });
    } catch (error) {
      return res.status(400).json({
        success: false,
        errorCode: 'INVALID_INDEXING_CONFIG',
        errorMessage: error instanceof Error ? error.message : '인덱스 설정이 올바르지 않습니다.',
      });
    }
  }

  return res.status(405).json({
    success: false,
    errorCode: 'METHOD_NOT_ALLOWED',
    errorMessage: '허용되지 않은 HTTP 메서드입니다.',
  });
}
