import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'node:crypto';
import { getGoodsIndex } from '../../../../constant/goods-index.constant.mjs';
import { getSearchRankingConfig } from '../../../../service/search-ranking-service';
import { listSortConfigs } from '../../../../service/sort-config-service';
import { getAiSearchRuntime } from '../../../../service/ai-search-query-service';
import { simulateSearch } from '../../../../service/search-simulation-service';
import { sendInternalServerError } from '../../../../service/api-error';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const key = process.env.SEARCH_LAB_API_KEY;
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${key}`);
  if (!key || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return res.status(401).json({ success: false, errorMessage: '연동 인증이 필요합니다.' });
  }
  const targetIndex = getGoodsIndex('prd');
  if (req.method === 'POST') {
    // Only simulation inputs are accepted; callers cannot override saved keyword fields.
    const { q, page, size, sortConfigId, popularity, ai, categoryAdjustment, adaptiveSearch, personalization, testMemberNo } = req.body || {};
    req.body = { q, page, size, sortConfigId, popularity, ai, categoryAdjustment, adaptiveSearch, personalization, testMemberNo, targetIndex };
    return simulateSearch(req, res, true);
  }
  if (req.method !== 'GET') return res.status(405).json({ success: false, errorMessage: '조회와 검색 테스트만 허용됩니다.' });
  try {
    const [saved, sorts] = await Promise.all([getSearchRankingConfig(targetIndex), listSortConfigs()]);
    return res.status(200).json({
      success: true,
      config: { popularity: saved.popularity, ai: saved.ai, categoryAdjustment: saved.categoryAdjustment, adaptiveSearch: saved.adaptiveSearch, personalization: saved.personalization },
      configs: sorts.filter((sort) => sort.targetIndex === targetIndex).map(({ id, sortName, description }) => ({ id, sortName, description })),
      aiRuntime: getAiSearchRuntime(),
    });
  } catch (error) {
    return sendInternalServerError(res, error);
  }
}
