import type { NextApiRequest, NextApiResponse } from 'next';

import { GOODS_INDEX } from '../../constant/api.constant';
import { elasticClient } from '../../service/elastic-client';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const [info, indexExists] = await Promise.all([
      elasticClient.info(),
      elasticClient.indices.exists({ index: GOODS_INDEX }),
    ]);

    return res.status(indexExists ? 200 : 503).json({
      success: indexExists,
      service: 'commerce-search-engine',
      elasticsearch: {
        connected: true,
        version: info.version.number,
      },
      index: {
        name: GOODS_INDEX,
        exists: indexExists,
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(503).json({
      success: false,
      service: 'commerce-search-engine',
      elasticsearch: { connected: false },
      index: { name: GOODS_INDEX, exists: false },
    });
  }
}
