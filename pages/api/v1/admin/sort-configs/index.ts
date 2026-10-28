import type { NextApiRequest, NextApiResponse } from 'next';

import { requireAdminAuthApi } from '../../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../../service/admin-request-validation';
import { listIndexingConfigs } from '../../../../../service/indexing-config-service';
import {
  createSortConfig,
  getSortConfigError,
  listSortConfigs,
  type SortConfigInput,
} from '../../../../../service/sort-config-service';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requester = await requireAdminAuthApi(req, res);
  if (!requester) return;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'GET') {
    try {
      const [configs, indexingConfigs] = await Promise.all([listSortConfigs(), listIndexingConfigs()]);
      const availableIndexTargets = indexingConfigs.map((config) => ({ indexName: config.indexName, environment: config.environment }));
      const availableIndices = [...new Set(availableIndexTargets.map((config) => config.indexName))].sort();
      return res.status(200).json({ success: true, configs, availableIndices, availableIndexTargets });
    } catch (error) {
      const detail = getSortConfigError(error);
      return res.status(detail.statusCode).json({ success: false, errorCode: detail.errorCode, errorMessage: detail.message });
    }
  }

  if (req.method === 'POST') {
    if (!isSameOriginJsonRequest(req)) {
      return res.status(403).json({ success: false, errorCode: 'FORBIDDEN_REQUEST', errorMessage: '동일 출처의 JSON 요청만 허용됩니다.' });
    }
    try {
      const config = await createSortConfig(req.body as SortConfigInput, requester);
      return res.status(201).json({ success: true, config });
    } catch (error) {
      const detail = getSortConfigError(error);
      return res.status(detail.statusCode).json({ success: false, errorCode: detail.errorCode, errorMessage: detail.message });
    }
  }

  return res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED', errorMessage: '허용되지 않은 HTTP 메서드입니다.' });
}
