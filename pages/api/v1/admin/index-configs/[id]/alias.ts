import type { NextApiRequest, NextApiResponse } from 'next';

import { requireAdminAuthApi } from '../../../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../../../service/admin-request-validation';
import { switchAliasToLatestSuccessfulFull } from '../../../../../../service/index-alias-service';
import { getIndexingConfig, hasActiveIndexingJob } from '../../../../../../service/indexing-config-service';

function getId(req: NextApiRequest): string | null {
  const value = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  return value && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requester = await requireAdminAuthApi(req, res);
  if (!requester) return;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED', errorMessage: '허용되지 않은 HTTP 메서드입니다.' });
  }
  if (!isSameOriginJsonRequest(req)) {
    return res.status(403).json({ success: false, errorCode: 'FORBIDDEN_REQUEST', errorMessage: '동일 출처의 JSON 요청만 허용됩니다.' });
  }
  const id = getId(req);
  if (!id) return res.status(400).json({ success: false, errorMessage: '설정 ID가 올바르지 않습니다.' });

  try {
    const config = await getIndexingConfig(id);
    if (!config) return res.status(404).json({ success: false, errorCode: 'INDEXING_CONFIG_NOT_FOUND', errorMessage: '인덱스 설정을 찾을 수 없습니다.' });
    if (await hasActiveIndexingJob(id)) {
      return res.status(409).json({ success: false, errorCode: 'INDEXING_CONFIG_ACTIVE', errorMessage: '색인 작업이 실행 또는 대기 중이어서 별칭을 변경할 수 없습니다.' });
    }
    const result = await switchAliasToLatestSuccessfulFull(config);
    return res.status(200).json({ success: true, alias: config.indexName, ...result });
  } catch (error) {
    return res.status(400).json({
      success: false,
      errorCode: 'ALIAS_SWITCH_FAILED',
      errorMessage: error instanceof Error ? error.message : '최신 인덱스로 별칭을 변경하지 못했습니다.',
    });
  }
}
