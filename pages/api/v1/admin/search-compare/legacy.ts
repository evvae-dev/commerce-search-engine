import type { NextApiRequest, NextApiResponse } from 'next';

import { requireAdminAuthApi } from '../../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../../service/admin-request-validation';
import { searchLegacyGoods } from '../../../../../service/legacy-search-service';

const RESULT_SIZES = new Set([10, 30, 50, 100]);
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const requester = await requireAdminAuthApi(req, res);
  if (!requester) return;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  if (req.method !== 'POST') return res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED', errorMessage: '허용되지 않은 HTTP 메서드입니다.' });
  if (!isSameOriginJsonRequest(req)) return res.status(403).json({ success: false, errorCode: 'FORBIDDEN_REQUEST', errorMessage: '동일 출처의 JSON 요청만 허용됩니다.' });

  const q = typeof req.body?.q === 'string' ? req.body.q.trim() : '';
  const environment = req.body?.environment === 'dev' ? 'dev' : req.body?.environment === 'prd' ? 'prd' : null;
  const size = req.body?.size === undefined ? 10 : Number(req.body.size);
  const page = req.body?.page === undefined ? 1 : Number(req.body.page);
  if (!q || q.length > 200) return res.status(400).json({ success: false, errorCode: 'INVALID_QUERY', errorMessage: '검색어는 1~200자로 입력해 주세요.' });
  if (!environment) return res.status(400).json({ success: false, errorCode: 'INVALID_ENVIRONMENT', errorMessage: '검색 환경은 운영 또는 개발이어야 합니다.' });
  if (!Number.isInteger(size) || !RESULT_SIZES.has(size)) return res.status(400).json({ success: false, errorCode: 'INVALID_SIZE', errorMessage: '결과 수는 10, 30, 50, 100 중에서 선택해 주세요.' });
  if (!Number.isInteger(page) || page < 1) return res.status(400).json({ success: false, errorCode: 'INVALID_PAGE', errorMessage: '페이지는 1 이상이어야 합니다.' });

  try {
    const items = await searchLegacyGoods({ query: q, page, size, environment });
    // 비교 패널은 기본 multi_match 결과의 현재 페이지를 반환한다.
    return res.status(200).json({ success: true, query: q, sort: 'SCORE', page, size, total: items.length, totalPages: 1, items });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    return res.status(timedOut ? 504 : 502).json({ success: false, errorCode: timedOut ? 'LEGACY_SEARCH_TIMEOUT' : 'LEGACY_SEARCH_UNAVAILABLE', errorMessage: timedOut ? '기본 키워드 검색 응답 시간이 초과되었습니다.' : '기본 키워드 검색 서버에 연결하지 못했습니다.' });
  }
}
