import type { NextApiResponse } from 'next';

export function sendInternalServerError(
  res: NextApiResponse,
  error: unknown,
): void {
  console.error(error);
  if ((error as { name?: string } | null)?.name === 'TimeoutError') {
    res.status(504).json({
      success: false,
      errorCode: 'SEARCH_TIMEOUT',
      errorMessage: '검색 응답 대기시간을 초과했습니다. 잠시 후 다시 검색해 주세요.',
    });
    return;
  }
  res.status(500).json({
    success: false,
    errorCode: 'INTERNAL_SERVER_ERROR',
    errorMessage: '검색 서버 처리 중 오류가 발생했습니다.',
  });
}
