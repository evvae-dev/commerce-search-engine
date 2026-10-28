import type { NextApiRequest, NextApiResponse } from 'next';

import { requireAdminAuthApi } from '../../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../../service/admin-request-validation';
import {
  requestJobCancellation,
  type CancelJobResult,
} from '../../../../../service/indexing-job-service';

function getResultResponse(result: CancelJobResult) {
  if (result.kind === 'not-found') {
    return {
      status: 404,
      body: {
        success: false,
        errorCode: 'INDEXING_JOB_NOT_FOUND',
        errorMessage: '색인 작업을 찾을 수 없습니다.',
      },
    };
  }
  if (result.kind === 'terminal') {
    return {
      status: 409,
      body: {
        success: false,
        errorCode: 'INDEXING_JOB_TERMINAL',
        errorMessage: '이미 종료된 색인 작업은 중지할 수 없습니다.',
        job: result.job,
      },
    };
  }
  return {
    status: result.kind === 'already-cancelled' ? 200 : 202,
    body: {
      success: true,
      status: result.job.status,
      cancelRequestedAt: result.job.cancelRequestedAt,
      job: result.job,
    },
  };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const requester = await requireAdminAuthApi(req, res);
  if (!requester) return;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      errorCode: 'METHOD_NOT_ALLOWED',
      errorMessage: '허용되지 않은 HTTP 메서드입니다.',
    });
  }
  if (!isSameOriginJsonRequest(req)) {
    return res.status(403).json({
      success: false,
      errorCode: 'FORBIDDEN_ORIGIN',
      errorMessage: '동일 출처의 JSON 요청만 허용됩니다.',
    });
  }

  const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : '';
  if (!/^[0-9a-fA-F-]{36}$/.test(jobId)) {
    return res.status(400).json({
      success: false,
      errorCode: 'INVALID_JOB_ID',
      errorMessage: '유효하지 않은 작업 ID입니다.',
    });
  }

  try {
    const result = await requestJobCancellation(jobId, requester);
    const response = getResultResponse(result);
    return res.status(response.status).json(response.body);
  } catch (error) {
    console.error('Failed to request indexing cancellation:', error);
    return res.status(500).json({
      success: false,
      errorCode: 'INDEXING_CANCEL_REQUEST_FAILED',
      errorMessage: '색인 중지 요청에 실패했습니다.',
    });
  }
}
