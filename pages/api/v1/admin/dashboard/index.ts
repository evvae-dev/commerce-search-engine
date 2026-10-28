import crypto from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

import { requireAdminAuthApi } from '../../../../../service/admin-auth';
import { sendInternalServerError } from '../../../../../service/api-error';
import { getSearchStatSummary } from '../../../../../service/search-stat-service';
import { getIndexingConfig } from '../../../../../service/indexing-config-service';
import {
  createJobDoc,
  getDashboardData,
  getEnvironmentCapabilities,
  type IndexingManualOperation,
  type IndexingEnvironment,
  markJobFailed,
  spawnIndexingWorker,
} from '../../../../../service/indexing-job-service';

const VALID_OPERATIONS: ReadonlySet<string> = new Set(['full', 'sync', 'embedding']);

function getTrustedProtocol(req: NextApiRequest): string {
  const forwarded = req.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().toLowerCase();
  }
  if (Array.isArray(forwarded) && typeof forwarded[0] === 'string') {
    return forwarded[0].split(',')[0].trim().toLowerCase();
  }
  return (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
}

function validateSameOrigin(req: NextApiRequest): boolean {
  const host = typeof req.headers.host === 'string' ? req.headers.host.trim() : '';
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  if (!host || !origin) {
    return false;
  }

  try {
    const requestUrl = new URL(`${getTrustedProtocol(req)}://${host}`);
    const originUrl = new URL(origin);
    const effectivePort = (url: URL) =>
      url.port || (url.protocol === 'https:' ? '443' : '80');

    return (
      originUrl.protocol.toLowerCase() === requestUrl.protocol.toLowerCase() &&
      originUrl.hostname.toLowerCase() === requestUrl.hostname.toLowerCase() &&
      effectivePort(originUrl) === effectivePort(requestUrl)
    );
  } catch {
    return false;
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const requester = await requireAdminAuthApi(req, res);
  if (!requester) {
    return;
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'GET') {
    try {
      const data = await getDashboardData();
      try {
        return res.status(200).json({ ...data, searchStats: await getSearchStatSummary() });
      } catch {
        return res.status(200).json({
          ...data,
          searchStats: {
            hourly: [],
            topQueries: [],
            risingQueries: [],
            error: '검색 통계를 불러오지 못했습니다.',
          },
        });
      }
    } catch (error) {
      return sendInternalServerError(res, error);
    }
  }

  if (req.method === 'POST') {
    // Same-origin 검증
    if (!validateSameOrigin(req)) {
      return res.status(403).json({
        success: false,
        errorCode: 'FORBIDDEN_ORIGIN',
        errorMessage: '동일 출처 요청만 허용됩니다.',
      });
    }

    // Content-Type 검증
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return res.status(400).json({
        success: false,
        errorCode: 'INVALID_CONTENT_TYPE',
        errorMessage: 'Content-Type must be application/json',
      });
    }

    const body = req.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Object.keys(body).length < 2 || Object.keys(body).length > 3 ||
      Object.keys(body).some((key) => !['configId', 'operation', 'embeddingMode'].includes(key)) ||
      typeof body.configId !== 'string' ||
      typeof body.operation !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(body.configId) ||
      !VALID_OPERATIONS.has(body.operation) ||
      (body.operation === 'embedding' && body.embeddingMode !== 'all' && body.embeddingMode !== 'changed') ||
      (body.operation !== 'embedding' && body.embeddingMode !== undefined)
    ) {
      return res.status(400).json({
        success: false,
        errorCode: 'INVALID_REQUEST_BODY',
        errorMessage: '요청 바디는 { configId, operation: full | sync | embedding } 형식이어야 합니다.',
      });
    }

    const config = await getIndexingConfig(body.configId);
    if (!config) {
      return res.status(404).json({
        success: false,
        errorCode: 'INDEXING_CONFIG_NOT_FOUND',
        errorMessage: '인덱스 설정을 찾을 수 없습니다.',
      });
    }
    const environment = config.environment as IndexingEnvironment;
    const operation = body.operation as IndexingManualOperation;

    // 환경별 권한 및 실행 가능 여부 정책 검증
    const capabilities = getEnvironmentCapabilities(environment);
    const opCapability = capabilities[operation] || capabilities.full;
    if (!opCapability.enabled) {
      return res.status(403).json({
        success: false,
        errorCode: 'CAPABILITY_DISABLED',
        errorMessage: opCapability.reason || '해당 작업은 현재 비활성화되어 있습니다.',
      });
    }

    const jobId = crypto.randomUUID();

    let jobDocCreated = false;
    try {
      await createJobDoc(jobId, environment, operation, 'manual', requester, 'queued', config);
      jobDocCreated = true;

      // 워커가 동일 작업 슬롯과 대상 락을 원자적으로 판정해 실행·대기·스킵을 결정한다.
      await spawnIndexingWorker(jobId, environment, operation, 'manual', config.id, body.embeddingMode);

      return res.status(202).json({
        success: true,
        jobId,
        environment,
        operation,
        trigger: 'manual',
        status: 'queued',
      });
    } catch (error) {
      if (jobDocCreated) {
        await markJobFailed(
          jobId,
          'ERR_WORKER_SPAWN',
          error instanceof Error ? error.message : '워커 프로세스 기동 실패',
        ).catch(() => {});
      }
      return sendInternalServerError(res, error);
    }
  }

  return res.status(405).json({
    success: false,
    errorCode: 'METHOD_NOT_ALLOWED',
    errorMessage: '허용되지 않은 HTTP 메서드입니다.',
  });
}
