import { elasticClient } from './elastic-client';
import { getGoodsIndex } from '../constant/goods-index.constant.mjs';

export interface LegacySearchItem {
  id: string;
  goodsId: string | null;
  name: string | null;
  brand: string | null;
  imgPath: string | null;
  saleAmt: number | null;
}

/** 가중치·비즈니스 룰 적용 전의 기본 키워드 검색을 비교 기준으로 사용한다. */
export async function searchLegacyGoods(input: {
  query: string;
  page: number;
  size: number;
  environment: 'dev' | 'prd';
}): Promise<LegacySearchItem[]> {
  const response = await elasticClient.search<Record<string, unknown>>({
    index: getGoodsIndex(input.environment), from: (input.page - 1) * input.size, size: input.size,
    query: { multi_match: { query: input.query, fields: ['goods_nm', 'bnd_nm_ko', 'selling_point_txt'] } },
    sort: [{ _score: { order: 'desc' } }, { goods_id: 'asc' }],
  });
  return response.hits.hits.map((hit) => {
    const row = hit._source || {};
    return {
      id: hit._id || '',
      goodsId: String(row.goods_id || ''),
      name: String(row.goods_nm || ''),
      brand: String(row.bnd_nm_ko || ''),
      imgPath: typeof row.img_path === 'string' ? row.img_path : null,
      saleAmt: typeof row.sale_amt === 'number' ? row.sale_amt : null,
    };
  });
}
