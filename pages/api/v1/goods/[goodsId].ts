import { errors } from '@elastic/elasticsearch';
import type { NextApiRequest, NextApiResponse } from 'next';

import { GOODS_INDEX } from '../../../../constant/api.constant';
import { sendInternalServerError } from '../../../../service/api-error';
import { elasticClient } from '../../../../service/elastic-client';

type GoodsDocument = Record<string, unknown>;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'METHOD_NOT_ALLOWED' });
  }

  const rawGoodsId = Array.isArray(req.query.goodsId)
    ? req.query.goodsId[0]
    : req.query.goodsId;
  const goodsId = rawGoodsId?.trim().toUpperCase();

  if (!goodsId) {
    return res.status(400).json({
      success: false,
      errorCode: 'INVALID_GOODS_ID',
      errorMessage: 'goodsId가 필요합니다.',
    });
  }

  try {
    const result = await elasticClient.get<GoodsDocument>({
      index: GOODS_INDEX,
      id: goodsId,
    });

    return res.status(200).json({
      success: true,
      item: {
        id: result._id,
        ...result._source,
      },
    });
  } catch (error) {
    if (error instanceof errors.ResponseError && error.meta.statusCode === 404) {
      return res.status(404).json({
        success: false,
        errorCode: 'GOODS_NOT_FOUND',
        errorMessage: '상품을 찾을 수 없습니다.',
      });
    }
    return sendInternalServerError(res, error);
  }
}
