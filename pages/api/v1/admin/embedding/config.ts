import type { NextApiRequest, NextApiResponse } from 'next';

import { requireAdminAuthApi } from '../../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../../service/admin-request-validation';
import { sendInternalServerError } from '../../../../../service/api-error';
import {
  getIndexingConfig,
  normalizeEmbeddingConfig,
  updateIndexingConfig,
  type IndexingConfigInput,
} from '../../../../../service/indexing-config-service';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await requireAdminAuthApi(req, res))) return;
  const configId = typeof req.query.configId === 'string' ? req.query.configId : '';
  if (!configId) return res.status(400).json({ success: false, errorMessage: 'configId가 필요합니다.' });
  try {
    const existing = await getIndexingConfig(configId);
    if (!existing) return res.status(404).json({ success: false, errorMessage: '인덱스 설정을 찾을 수 없습니다.' });
    if (req.method === 'GET') return res.status(200).json({ success: true, embedding: normalizeEmbeddingConfig(existing.embedding, existing.indexName) });
    if (req.method !== 'PUT' || !isSameOriginJsonRequest(req)) return res.status(405).json({ success: false, errorMessage: '허용되지 않은 요청입니다.' });
    const embedding = normalizeEmbeddingConfig(req.body, existing.indexName);
    const input: IndexingConfigInput = { ...existing, embedding };
    const config = await updateIndexingConfig(configId, input);
    return res.status(200).json({ success: true, embedding: config.embedding });
  } catch (error) {
    if (error instanceof Error && /설정|필드|항목|GEO SQL/.test(error.message)) return res.status(400).json({ success: false, errorMessage: error.message });
    return sendInternalServerError(res, error);
  }
}

