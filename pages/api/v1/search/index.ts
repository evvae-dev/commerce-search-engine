import type { NextApiRequest, NextApiResponse } from 'next';

import { GOODS_INDEX } from '../../../../constant/api.constant';
import { sendInternalServerError } from '../../../../service/api-error';
import { runGoodsSearch, toPublicGoodsSearchResult } from '../../../../service/goods-search-service';
import { SearchPolicyBlockError } from '../../../../service/search-query-policy';
import { EmptySearchQueryError } from '../../../../service/request-expression';
import { recordSearchEvent } from '../../../../service/search-stat-service';
import { getPersonalizationMemberNo, InvalidPersonalizationContextError } from '../../../../service/personalization-context';

function getFirst(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function parsePositiveInteger(value: unknown, defaultValue: number, maxValue?: number): number | null {
  const normalized = getFirst(value);
  if (normalized === undefined || normalized === null || normalized === '') return defaultValue;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 1 || (maxValue && parsed > maxValue)) return null;
  return parsed;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'METHOD_NOT_ALLOWED' });
  }
  const input = req.method === 'POST' ? req.body ?? {} : req.query;
  const rawQuery = getFirst(input.q);
  const queryText = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  const page = parsePositiveInteger(input.page, 1);
  const size = parsePositiveInteger(input.size, 20, 100);
  if (page === null || size === null) {
    return res.status(400).json({ success: false, errorCode: 'INVALID_PAGINATION', errorMessage: 'page는 1 이상, size는 1~100 사이여야 합니다.' });
  }
  try {
    const memberNo = getPersonalizationMemberNo(req);
    const startedAt = Date.now();
    try {
      const result = await runGoodsSearch(queryText, page, size, undefined, undefined, undefined, false, memberNo);
      // 통계 ES 응답을 기다리지 않아 실운영 검색 응답 시간에 영향을 주지 않도록 한다.
      void recordSearchEvent({ queryText, targetIndex: GOODS_INDEX, resultCount: result.total, durationMs: Date.now() - startedAt, success: true });
      return res.status(200).json({ success: true, ...toPublicGoodsSearchResult(result) });
    } catch (error) {
      void recordSearchEvent({ queryText, targetIndex: GOODS_INDEX, resultCount: 0, durationMs: Date.now() - startedAt, success: false });
      throw error;
    }
  } catch (error) {
    if (error instanceof InvalidPersonalizationContextError) {
      return res.status(401).json({ success: false, errorCode: 'INVALID_PERSONALIZATION_CONTEXT', errorMessage: error.message });
    }
    if (error instanceof SearchPolicyBlockError || error instanceof EmptySearchQueryError) {
      return res.status(422).json({ success: false, errorCode: error.code, errorMessage: error.message });
    }
    return sendInternalServerError(res, error);
  }
}
