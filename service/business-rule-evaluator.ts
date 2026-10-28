export type EvaluatedRuleStatus = 'inactive' | 'scheduled' | 'running' | 'ended';
export interface EvaluatedRulePeriod { status: 'active' | 'inactive'; startAt: string; endAt: string; alwaysOn?: boolean }
export interface EvaluatedPinRule { normalizedQuery: string; matchType?: 'exact' | 'keyword' }
export interface EvaluatedScoreRule {
  condition: {
    field: string;
    operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'contains';
    value: number | string;
  };
}

export function normalizeBusinessRuleQuery(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ko-KR').trim().replace(/\s+/g, ' ');
}

export function evaluateRuleStatus(rule: EvaluatedRulePeriod, at = new Date()): EvaluatedRuleStatus {
  if (rule.status === 'inactive') return 'inactive';
  if (rule.alwaysOn) return 'running';
  if (new Date(rule.startAt) > at) return 'scheduled';
  if (new Date(rule.endAt) < at) return 'ended';
  return 'running';
}

export function matchesPinRuleQuery(rule: EvaluatedPinRule, query: string, effectiveTokens: string[]): boolean {
  const expected = normalizeBusinessRuleQuery(rule.normalizedQuery);
  if ((rule.matchType || 'exact') === 'exact') return expected === normalizeBusinessRuleQuery(query);
  const expectedTokens = expected.split(' ').filter(Boolean);
  const actualTokens = effectiveTokens.flatMap((token) => normalizeBusinessRuleQuery(token).split(' ')).filter(Boolean);
  return expectedTokens.length > 0 && actualTokens.some((_, index) => expectedTokens.every((token, offset) => actualTokens[index + offset] === token));
}

export function getRuleSourceField(field: string): string {
  return field.replace(/\.keyword$/, '');
}

export function getRuleSourceValue(source: Record<string, unknown>, field: string): unknown {
  if (Object.prototype.hasOwnProperty.call(source, field)) return source[field];
  const read = (value: unknown, parts: string[]): unknown => {
    if (!parts.length) return value;
    if (Array.isArray(value)) return value.flatMap((item) => read(item, parts));
    if (!value || typeof value !== 'object') return undefined;
    return read((value as Record<string, unknown>)[parts[0]], parts.slice(1));
  };
  return read(source, getRuleSourceField(field).split('.'));
}

export function matchesScoreRuleCondition(rule: EvaluatedScoreRule, source: Record<string, unknown>): boolean {
  const sourceValue = getRuleSourceValue(source, rule.condition.field);
  if (rule.condition.operator === 'contains') {
    const expectedValues = String(rule.condition.value)
      .split(',')
      .map((value) => value.trim().toLocaleLowerCase('ko-KR'))
      .filter(Boolean);
    if (!expectedValues.length) return false;
    const values = Array.isArray(sourceValue) ? sourceValue : [sourceValue];
    return values.some((value) => {
      const actual = String(value ?? '').toLocaleLowerCase('ko-KR');
      return expectedValues.some((expected) => actual.includes(expected));
    });
  }

  const actual = Number(sourceValue); const expected = Number(rule.condition.value);
  if (!Number.isFinite(actual)) return false;
  switch (rule.condition.operator) { case 'gt': return actual > expected; case 'gte': return actual >= expected; case 'lt': return actual < expected; case 'lte': return actual <= expected; default: return actual === expected; }
}

export const matchesNumericRule = matchesScoreRuleCondition;
