import type { NextApiRequest, NextApiResponse } from 'next';

import { sendInternalServerError } from '../../../../service/api-error';
import { ExhibitionGoodsInputError, getExhibitionGoods } from '../../../../service/exhibition-goods-service';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ success: false, errorCode: 'METHOD_NOT_ALLOWED', errorMessage: 'GET 요청만 허용됩니다.' });
  }
  try {
    const result = await getExhibitionGoods(req.query);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    if (error instanceof ExhibitionGoodsInputError) {
      return res.status(error.statusCode).json({ success: false, errorCode: error.code, errorMessage: error.message });
    }
    return sendInternalServerError(res, error);
  }
}
