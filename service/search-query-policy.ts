import type { estypes } from '@elastic/elasticsearch';
import { uppercaseSearchText } from '../scripts/search-uppercase.mjs';

import type { SearchRankingConfig } from './search-ranking-service';
import type { SynonymConfig, WordPolicyConfig } from './search-dictionary-service';

export interface PolicyWarning { message: string; }
export interface QueryPolicyAnalysis {
  normalizedQuery: string;
  originalTokens: string[];
  effectiveTokens: string[];
  removedShortTokens: string[];
  removedStopwords: string[];
  removedContextTokens: string[];
  synonymExpansions: string[];
  synonymExpansionDetails: Array<{ source: string; target: string }>;
  tokenDiagnostics: Array<{ token: string; used: boolean; reason?: string }>;
  warnings: PolicyWarning[];
  effectiveQuery: string;
}
export class SearchPolicyBlockError extends Error {
  code = 'SEARCH_QUERY_BLOCKED';
  statusCode = 422;
  constructor() { super('검색 정책에 의해 검색을 수행할 수 없습니다.'); this.name = 'SearchPolicyBlockError'; }
}

export function normalizeSearchQuery(value: unknown): string {
  if (typeof value !== 'string') return '';
  return uppercaseSearchText(value).trim().replace(/\s+/g, ' ');
}

function matchingTokenRanges(term: string, tokens: string[]): number[][] {
  const normalizedTerm = normalizeSearchQuery(term);
  const compactTerm = normalizedTerm.replace(/\s+/g, '');
  const matches: number[][] = [];
  for (let start = 0; start < tokens.length; start++) {
    let spaced = '';
    let compact = '';
    for (let end = start; end < tokens.length; end++) {
      spaced = spaced ? `${spaced} ${tokens[end]}` : tokens[end];
      compact += tokens[end];
      if (spaced === normalizedTerm || compact === compactTerm) {
        matches.push(Array.from({ length: end - start + 1 }, (_, index) => start + index));
      }
      if (spaced.length > normalizedTerm.length && compact.length > compactTerm.length) break;
    }
  }
  return matches;
}

function matchingTokens(term: string, tokens: string[]): boolean {
  return matchingTokenRanges(term, tokens).length > 0;
}

/** 한글 한 글자는 우연한 일치가 많아 키워드 검색에서 제외하되, M·7 같은 영문·숫자 검색은 유지한다. */
function isSingleHangulToken(token: string): boolean {
  return Array.from(token).length === 1 && /^\p{Script=Hangul}$/u.test(token);
}

export function applySearchQueryPolicy(
  queryText: string,
  synonymConfig: SynonymConfig,
  wordPolicyConfig: WordPolicyConfig,
  analyzedTokens: Array<{ token?: string }>,
): QueryPolicyAnalysis {
  const normalizedQuery = normalizeSearchQuery(queryText);
  const originalTokens = analyzedTokens.map((item) => normalizeSearchQuery(item.token)).filter(Boolean);
  const enabledForbidden = wordPolicyConfig.forbiddenWords.filter((item) => item.enabled);
  for (const rule of enabledForbidden) {
    const term = normalizeSearchQuery(rule.term);
    const matches = rule.matchType === 'token' ? matchingTokens(term, originalTokens) : normalizedQuery.includes(term);
    if (!matches) continue;
    if (rule.action === 'block') throw new SearchPolicyBlockError();
  }
  const stopwordIndexes = new Set<number>();
  const removedStopwords: string[] = [];
  for (const rule of wordPolicyConfig.stopWords.filter((item) => item.enabled)) {
    const term = normalizeSearchQuery(rule.term);
    const ranges = matchingTokenRanges(term, originalTokens);
    if (!ranges.length) continue;
    removedStopwords.push(term);
    ranges.flat().forEach((index) => stopwordIndexes.add(index));
  }
  const contextualNumberIndexes = new Set<number>();
  originalTokens.forEach((token, index) => {
    if (/^\d{1,2}$/.test(token) && originalTokens[index + 1] === '월') contextualNumberIndexes.add(index);
  });
  const removedShortTokens = [...new Set(originalTokens.filter(isSingleHangulToken))];
  const removedContextTokens = [...new Set([...contextualNumberIndexes].map((index) => originalTokens[index]))];
  const tokenDiagnostics = originalTokens.map((token, index) => {
    if (stopwordIndexes.has(index)) return { token, used: false, reason: '불용어' };
    if (contextualNumberIndexes.has(index)) return { token, used: false, reason: '숫자' };
    if (isSingleHangulToken(token)) return { token, used: false, reason: '한 글자' };
    return { token, used: true };
  });
  const expansionSet = new Set<string>();
  originalTokens.forEach((token, index) => {
    if (!stopwordIndexes.has(index) && !contextualNumberIndexes.has(index) && !isSingleHangulToken(token)) expansionSet.add(token);
  });
  const synonymExpansions: string[] = [];
  const synonymExpansionDetails: Array<{ source: string; target: string }> = [];
  for (const rule of synonymConfig.rules.filter((item) => item.enabled)) {
    const group = [...new Set([rule.representative, ...rule.terms].map(normalizeSearchQuery))];
    const sources = rule.mode === 'bidirectional' ? group : rule.terms.map(normalizeSearchQuery);
    const matchedSource = sources.find((term) => matchingTokens(term, originalTokens));
    if (!matchedSource) continue;
    const additions = (rule.mode === 'bidirectional' ? group : [rule.representative])
      .filter((term) => !isSingleHangulToken(term) && !/^\d{1,2}\s*월$/u.test(term));
    additions.forEach((term) => {
      if (!expansionSet.has(term)) {
        expansionSet.add(term);
        synonymExpansions.push(term);
        synonymExpansionDetails.push({ source: matchedSource, target: term });
      }
    });
  }
  const warnings = enabledForbidden.filter((rule) => rule.action === 'warn' && (rule.matchType === 'token' ? matchingTokens(normalizeSearchQuery(rule.term), originalTokens) : normalizedQuery.includes(normalizeSearchQuery(rule.term)))).map((rule) => ({ message: rule.message || '검색어에 주의가 필요한 단어가 포함되어 있습니다.' }));
  const cappedTokens = [...expansionSet].slice(0, 100);
  return { normalizedQuery, originalTokens, effectiveTokens: cappedTokens, removedShortTokens, removedStopwords, removedContextTokens, synonymExpansions: synonymExpansions.slice(0, 100), synonymExpansionDetails: synonymExpansionDetails.slice(0, 100), tokenDiagnostics, warnings, effectiveQuery: cappedTokens.join(' ') };
}

/** 확장된 문자열을 query_string에 넣지 않고, 안전한 Query DSL should 절로 구성한다. */
export function buildPolicyKeywordQuery(
  analysis: QueryPolicyAnalysis,
  rankingConfig: SearchRankingConfig,
): estypes.QueryDslQueryContainer {
  if (!analysis.effectiveTokens.length) return { match_none: {} };
  const fields = rankingConfig.fields.filter((field) => field.enabled).map((field) => `${field.field}^${field.boost}`);
  return {
    bool: {
      should: analysis.effectiveTokens.map((term) => ({ multi_match: { query: term, fields, type: 'best_fields', operator: 'and' as const, _name: 'keyword' } })),
      minimum_should_match: 1,
    },
  };
}
