export interface PopularityConfig {
  enabled: boolean;
  expression: string;
  weight: number;
  normalizationMethod: PopularityNormalizationMethod;
  topPercent: number;
  referencedFields: string[];
  amountField: PopularityAmountField;
  quantityField: PopularityQuantityField;
  amountRatio: number;
  quantityRatio: number;
  hitsRatio: number;
}

export type PopularityAmountField = 'day_amt' | 'week_amt' | 'month_amt';
export type PopularityQuantityField = 'day_ord_cnt' | 'week_ord_cnt' | 'month_ord_cnt';
export type PopularityNormalizationMethod = 'max' | 'topPercent' | 'log';

export class PopularityConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PopularityConfigValidationError';
  }
}

type Token = { type: 'number' | 'identifier' | 'operator' | 'paren' | 'comma'; value: string };
type Node = { kind: 'number'; value: number } | { kind: 'field'; name: string } | { kind: 'unary'; op: '-'; value: Node } | { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: Node; right: Node } | { kind: 'call'; name: 'log1p' | 'sqrt' | 'min' | 'max' | 'pow'; args: Node[] };

const MAX_LENGTH = 500;
const MAX_DEPTH = 12;
const MAX_NODES = 100;
const FUNCTIONS = new Set(['log1p', 'sqrt', 'min', 'max', 'pow']);
const AMOUNT_FIELDS = new Set<PopularityAmountField>(['day_amt', 'week_amt', 'month_amt']);
const QUANTITY_FIELDS = new Set<PopularityQuantityField>(['day_ord_cnt', 'week_ord_cnt', 'month_ord_cnt']);
const NORMALIZATION_METHODS = new Set<PopularityNormalizationMethod>(['max', 'topPercent', 'log']);

export function buildPopularityExpression(config: Pick<PopularityConfig, 'amountField' | 'quantityField' | 'amountRatio' | 'quantityRatio' | 'hitsRatio'>): string {
  return `pow(${config.amountField} / max(${config.quantityField}, 1), ${config.amountRatio}) * pow(max(${config.quantityField}, 1), ${config.quantityRatio}) * pow(max(hits, 1), ${config.hitsRatio})`;
}

function tokenize(expression: string): Token[] {
  if (expression.length === 0 || expression.length > MAX_LENGTH) throw new Error('인기도 수식은 1~500자로 입력해야 합니다.');
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index];
    if (/\s/.test(char)) { index += 1; continue; }
    const number = expression.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if (number) { tokens.push({ type: 'number', value: number[0] }); index += number[0].length; continue; }
    const identifier = expression.slice(index).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
    if (identifier) { tokens.push({ type: 'identifier', value: identifier[0] }); index += identifier[0].length; continue; }
    if ('+-*/'.includes(char)) tokens.push({ type: 'operator', value: char });
    else if ('()'.includes(char)) tokens.push({ type: 'paren', value: char });
    else if (char === ',') tokens.push({ type: 'comma', value: char });
    else throw new Error(`인기도 수식에 허용되지 않는 문자가 있습니다: ${char}`);
    index += 1;
  }
  return tokens;
}

export function parsePopularityFormula(expression: string): { ast: Node; referencedFields: string[] } {
  const tokens = tokenize(expression); let position = 0; let nodes = 0;
  const peek = () => tokens[position];
  const consume = (value?: string) => { const token = tokens[position]; if (!token || (value && token.value !== value)) throw new Error('인기도 수식 문법이 올바르지 않습니다.'); position += 1; return token; };
  const primary = (depth: number): Node => {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) throw new Error('인기도 수식이 너무 복잡합니다.');
    const token = peek();
    if (!token) throw new Error('인기도 수식이 완성되지 않았습니다.');
    if (token.type === 'number') { consume(); return { kind: 'number', value: Number(token.value) }; }
    if (token.type === 'identifier') {
      consume();
      if (peek()?.value !== '(') return { kind: 'field', name: token.value };
      consume('('); const args: Node[] = [];
      if (peek()?.value !== ')') { do { args.push(expressionParser(depth + 1)); } while (peek()?.value === ',' && consume(',')); }
      consume(')');
      if (!FUNCTIONS.has(token.value)) throw new Error(`허용되지 않는 함수입니다: ${token.value}`);
      const expected = token.value === 'min' || token.value === 'max' || token.value === 'pow' ? 2 : 1;
      if (args.length !== expected) throw new Error(`${token.value} 함수의 인자 수가 올바르지 않습니다.`);
      return { kind: 'call', name: token.value as 'log1p' | 'sqrt' | 'min' | 'max' | 'pow', args };
    }
    if (token.value === '(') { consume('('); const value = expressionParser(depth + 1); consume(')'); return value; }
    throw new Error('인기도 수식의 항목이 올바르지 않습니다.');
  };
  const unary = (depth: number): Node => peek()?.value === '-' ? (consume('-'), { kind: 'unary', op: '-', value: unary(depth + 1) }) : primary(depth);
  const product = (depth: number): Node => { let value = unary(depth); while (peek()?.value === '*' || peek()?.value === '/') { const op = consume().value as '*' | '/'; value = { kind: 'binary', op, left: value, right: unary(depth) }; } return value; };
  function expressionParser(depth: number): Node { let value = product(depth); while (peek()?.value === '+' || peek()?.value === '-') { const op = consume().value as '+' | '-'; value = { kind: 'binary', op, left: value, right: product(depth) }; } return value; }
  const ast = expressionParser(0); if (position !== tokens.length) throw new Error('인기도 수식에 해석할 수 없는 항목이 있습니다.');
  const fields: string[] = []; const walk = (node: Node) => { if (node.kind === 'field') fields.push(node.name); else if (node.kind === 'binary') { walk(node.left); walk(node.right); } else if (node.kind === 'unary') walk(node.value); else if (node.kind === 'call') node.args.forEach(walk); }; walk(ast);
  if (fields.some((field) => !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(field))) throw new Error('인기도 참조 필드명이 올바르지 않습니다.');
  return { ast, referencedFields: [...new Set(fields)] };
}

export function validatePopularityConfig(input: unknown): PopularityConfig {
  const value = input as Partial<PopularityConfig> || {};
  const amountField = AMOUNT_FIELDS.has(value.amountField as PopularityAmountField) ? value.amountField as PopularityAmountField : 'month_amt';
  const quantityField = QUANTITY_FIELDS.has(value.quantityField as PopularityQuantityField) ? value.quantityField as PopularityQuantityField : 'month_ord_cnt';
  const amountRatio = Number(value.amountRatio ?? 0.4);
  const quantityRatio = Number(value.quantityRatio ?? 0.5);
  const hitsRatio = Number(value.hitsRatio ?? 0.1);
  const ratios = [amountRatio, quantityRatio, hitsRatio];
  if (ratios.some((ratio) => !Number.isFinite(ratio) || ratio < 0 || ratio > 1) || Math.abs(ratios.reduce((sum, ratio) => sum + ratio, 0) - 1) > 0.000001) {
    throw new PopularityConfigValidationError('판매금액, 판매수량, 조회수 비중은 각각 0~100%이고 합계가 100%여야 합니다.');
  }
  const expression = buildPopularityExpression({ amountField, quantityField, amountRatio, quantityRatio, hitsRatio });
  const parsed = parsePopularityFormula(expression);
  const weight = Number(value.weight ?? 0.2);
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new PopularityConfigValidationError('인기도 보정률은 0~100% 사이여야 합니다.');
  const normalizationMethod = NORMALIZATION_METHODS.has(value.normalizationMethod as PopularityNormalizationMethod)
    ? value.normalizationMethod as PopularityNormalizationMethod
    : 'max';
  const topPercent = Number(value.topPercent ?? 5);
  if (!Number.isFinite(topPercent) || topPercent < 1 || topPercent > 50) {
    throw new PopularityConfigValidationError('상위 기준은 1~50% 사이여야 합니다.');
  }
  return { enabled: value.enabled === true, expression, weight, normalizationMethod, topPercent, referencedFields: parsed.referencedFields, amountField, quantityField, amountRatio, quantityRatio, hitsRatio };
}

export function getPopularityNormalizationReference(
  scores: number[],
  config: Pick<PopularityConfig, 'normalizationMethod' | 'topPercent'>,
): number {
  const positiveScores = scores.filter((score) => Number.isFinite(score) && score > 0);
  if (!positiveScores.length) return 0;
  if (config.normalizationMethod !== 'topPercent') return Math.max(...positiveScores);
  const sorted = positiveScores.sort((left, right) => right - left);
  const referenceIndex = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * config.topPercent / 100) - 1));
  return sorted[referenceIndex];
}

export function normalizePopularityScore(
  score: number,
  reference: number,
  method: PopularityNormalizationMethod,
): number {
  if (!Number.isFinite(score) || score <= 0 || !Number.isFinite(reference) || reference <= 0) return 0;
  const normalized = method === 'log'
    ? Math.log1p(score) / Math.log1p(reference)
    : score / reference;
  return Math.min(1, Math.max(0, normalized));
}

function evaluate(node: Node, source: Record<string, unknown>): number {
  if (node.kind === 'number') return node.value;
  if (node.kind === 'field') { const value = Number(source[node.name]); return Number.isFinite(value) ? value : 0; }
  if (node.kind === 'unary') return -evaluate(node.value, source);
  if (node.kind === 'binary') { const left = evaluate(node.left, source); const right = evaluate(node.right, source); if (node.op === '+') return left + right; if (node.op === '-') return left - right; if (node.op === '*') return left * right; return right === 0 ? 0 : left / right; }
  const args = node.args.map((arg) => evaluate(arg, source));
  if (node.name === 'log1p') return args[0] >= 0 ? Math.log1p(args[0]) : 0;
  if (node.name === 'sqrt') return args[0] >= 0 ? Math.sqrt(args[0]) : 0;
  if (node.name === 'pow') return args[0] >= 0 ? Math.pow(args[0], args[1]) : 0;
  return node.name === 'min' ? Math.min(...args) : Math.max(...args);
}

export function evaluatePopularity(config: PopularityConfig, source: Record<string, unknown>): number {
  if (!config.enabled) return 0;
  if (Number(source[config.amountField]) <= 0 || Number(source[config.quantityField]) <= 0) return 0;
  try { const result = evaluate(parsePopularityFormula(config.expression).ast, source); return Number.isFinite(result) && result > 0 ? result : 0; } catch { return 0; }
}

export function compilePopularityFormula(config: PopularityConfig): (source: Record<string, unknown>) => number {
  const ast = parsePopularityFormula(config.expression).ast;
  return (source) => {
    if (!config.enabled) return 0;
    if (Number(source[config.amountField]) <= 0 || Number(source[config.quantityField]) <= 0) return 0;
    try { const result = evaluate(ast, source); return Number.isFinite(result) && result > 0 ? result : 0; } catch { return 0; }
  };
}
