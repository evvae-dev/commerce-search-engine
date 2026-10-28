import type { NextApiRequest, NextApiResponse } from 'next';

import { GOODS_INDEX } from '../../../../constant/api.constant';
import { getContentsIndex } from '../../../../constant/contents-index.constant';
import { isGoodsIndexFamily } from '../../../../constant/goods-index.constant.mjs';
import { sendInternalServerError } from '../../../../service/api-error';
import { runGoodsSearch, toPublicGoodsSearchResult } from '../../../../service/goods-search-service';
import { SearchPolicyBlockError } from '../../../../service/search-query-policy';
import { EmptySearchQueryError } from '../../../../service/request-expression';
import { recordSearchEvent } from '../../../../service/search-stat-service';

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function positiveInteger(value: unknown, fallback: number, max?: number): number | null {
  const raw = first(value);
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && (!max || parsed <= max) ? parsed : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'METHOD_NOT_ALLOWED' });
  const queryText = typeof first(req.query.q) === 'string' ? String(first(req.query.q)).trim() : '';
  const page = positiveInteger(req.query.page, 1);
  const size = positiveInteger(req.query.size, 20, 100);
  if (page === null || size === null) {
    return res.status(400).json({ success: false, errorCode: 'INVALID_PAGINATION', errorMessage: 'page는 1 이상, size는 1~100 사이여야 합니다.' });
  }
  const targetIndex = getContentsIndex(isGoodsIndexFamily(GOODS_INDEX, 'prd') ? 'prd' : 'dev');
  const startedAt = Date.now();
  try {
    const result = await runGoodsSearch(queryText, page, size, targetIndex);
    void recordSearchEvent({ queryText, targetIndex, resultCount: result.total, durationMs: Date.now() - startedAt, success: true });
    return res.status(200).json({ success: true, ...toPublicGoodsSearchResult(result) });
  } catch (error) {
    void recordSearchEvent({ queryText, targetIndex, resultCount: 0, durationMs: Date.now() - startedAt, success: false });
    if (error instanceof SearchPolicyBlockError || error instanceof EmptySearchQueryError) {
      return res.status(422).json({ success: false, errorCode: error.code, errorMessage: error.message });
    }
    return sendInternalServerError(res, error);
  }
}
