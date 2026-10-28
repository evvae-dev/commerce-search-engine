export interface AdaptiveSearchConfig {
  enabled: boolean;
}

export interface AdaptiveSearchDecision {
  useVector: boolean;
  reason: string;
}

export const DEFAULT_ADAPTIVE_SEARCH: AdaptiveSearchConfig = { enabled: false };

export function validateAdaptiveSearch(input: unknown): AdaptiveSearchConfig {
  const source = input && typeof input === 'object' ? input as Partial<AdaptiveSearchConfig> : {};
  return { enabled: source.enabled === true };
}

export function decideAdaptiveSearch(
  query: string,
  analyzedTokens: string[],
  removedRequestExpressions: string[],
  config: AdaptiveSearchConfig,
): AdaptiveSearchDecision {
  if (!config.enabled) return { useVector: true, reason: '적응형 검색 미사용' };
  if (/\b[A-Z]{1,4}\d{5,}\b/i.test(query)) return { useVector: false, reason: '상품번호가 포함된 명확한 검색' };
  const wordCount = query.normalize('NFKC').trim().split(/\s+/).filter(Boolean).length;
  const tokenCount = new Set(analyzedTokens.map((token) => token.normalize('NFKC').trim()).filter(Boolean)).size;
  if (removedRequestExpressions.length) return { useVector: true, reason: '요청 표현이 포함된 자연어 검색' };
  if (/(추천|입을|입기|찾아|보여|골라|어울|좋은|해줘|해주세요|주세요)/u.test(query)) return { useVector: true, reason: '의도 표현이 포함된 자연어 검색' };
  if (/(결혼식|하객)/u.test(query)) return { useVector: true, reason: '상황 맥락이 포함된 검색' };
  if (wordCount >= 4 || tokenCount >= 4) return { useVector: true, reason: '검색 의도를 보완할 복합 검색' };
  return { useVector: false, reason: '짧고 명확한 키워드 검색' };
}
