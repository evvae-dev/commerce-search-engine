import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'METHOD_NOT_ALLOWED' });
  }

  return res.status(200).json({
    success: true,
    service: 'commerce-search-engine',
    routes: [
      'GET /api/health',
      'GET|POST /api/v1/search',
      'GET /api/v1/goods/:goodsId',
      'GET|POST /api/v1/admin/dashboard',
    ],
  });
}