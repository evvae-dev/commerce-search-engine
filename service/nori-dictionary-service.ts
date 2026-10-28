import { createHash } from 'node:crypto';
import { uppercaseSearchText, uppercaseDictionaryRules, uppercaseNoriTemplate } from '../scripts/search-uppercase.mjs';

import { elasticClient } from './elastic-client';
import { listManagedIndexTemplates, updateManagedIndexTemplate } from './index-template-service';

type JsonObject = Record<string, unknown>;
export interface NoriDictionaryConfig {
  targetIndex: string;
  templateName: string;
  rules: string[];
  revision: string;
  applicationStatus: 'applied' | 'pending' | 'unavailable';
}
export interface NoriDictionaryPreview {
  current: string[] | null;
  draft: string[];
}
export class NoriDictionaryError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

export function normalizeNoriRules(value: unknown): string[] {
  if (!Array.isArray(value)) throw new NoriDictionaryError(422, '사용자 사전은 단어 목록으로 입력해 주세요.');
  const words = new Set<string>();
  return value.map((line, index) => {
    if (typeof line !== 'string' || /[\u0000-\u001f\u007f-\u009f,#]/u.test(line)) throw new NoriDictionaryError(422, `${index + 1}번째 항목에 사용할 수 없는 문자가 있습니다.`);
    const rule = uppercaseSearchText(line).trim().replace(/\s+/g, ' ');
    if (/[,#]/u.test(rule)) throw new NoriDictionaryError(422, `${index + 1}번째 항목에는 쉼표와 #을 사용할 수 없습니다.`);
    if (!rule || rule.length > 200) throw new NoriDictionaryError(422, `${index + 1}번째 항목은 1~200자로 입력해 주세요.`);
    const [word, ...parts] = rule.split(' ');
    if (parts.length && parts.join('') !== word) throw new NoriDictionaryError(422, `${word}: 분해 단어를 합치면 등록 단어와 같아야 합니다.`);
    if (words.has(word)) throw new NoriDictionaryError(422, `중복된 단어입니다: ${word}`);
    words.add(word);
    return rule;
  });
}

function revision(body: unknown): string {
  const canonical = JSON.stringify(body, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
  });
  return createHash('sha256').update(canonical).digest('hex');
}

async function context(targetIndex: unknown) {
  const { templates, availableIndices } = await listManagedIndexTemplates();
  if (typeof targetIndex !== 'string' || !availableIndices.includes(targetIndex)) throw new NoriDictionaryError(422, '등록된 대상 인덱스를 선택해 주세요.');
  const matches = templates.filter((item) => item.indexPatterns.includes(`${targetIndex}-*`));
  if (matches.length !== 1 || matches[0].indexPatterns.length !== 1) throw new NoriDictionaryError(422, '대상 인덱스 전용 템플릿을 먼저 설정해 주세요. 여러 인덱스가 공유하는 템플릿은 이 화면에서 수정할 수 없습니다.');
  const template = matches[0];
  if (template.composedOf.length) throw new NoriDictionaryError(422, '컴포넌트 템플릿을 사용하는 경우 인덱스 설정에서 사용자 사전을 관리해 주세요.');
  const definition = object(template.body.template);
  const settings = object(definition.settings);
  const analysis = object(object(settings.index).analysis ?? settings.analysis);
  const properties = object(object(definition.mappings).properties);
  const analyzerName = object(properties.goods_nm).analyzer;
  const analyzer = object(object(analysis.analyzer)[String(analyzerName)]);
  const tokenizerName = String(analyzer.tokenizer || '');
  const tokenizer = object(object(analysis.tokenizer)[tokenizerName]);
  if (tokenizer.type !== 'nori_tokenizer') throw new NoriDictionaryError(422, 'goods_nm 필드에 연결된 Nori 분석기를 찾을 수 없습니다.');
  if (tokenizer.user_dictionary) throw new NoriDictionaryError(422, '파일 기반 사용자 사전이 설정되어 있습니다. 인덱스 설정에서 인라인 사전으로 전환한 후 사용해 주세요.');
  return { targetIndex, template, analysis, analyzer, tokenizerName, tokenizer };
}

function rulesOf(tokenizer: JsonObject): string[] {
  return Array.isArray(tokenizer.user_dictionary_rules) ? tokenizer.user_dictionary_rules as string[] : [];
}

async function configOf(ctx: Awaited<ReturnType<typeof context>>): Promise<NoriDictionaryConfig> {
  const rules = uppercaseDictionaryRules(rulesOf(ctx.tokenizer)) as string[];
  let applicationStatus: NoriDictionaryConfig['applicationStatus'] = 'unavailable';
  try {
    const settings = await elasticClient.indices.getSettings({ index: ctx.targetIndex });
    const current = Object.values(settings);
    applicationStatus = current.length && current.every((item) => {
      const analysis = object(item.settings?.index?.analysis);
      const tokenizer = object(object(analysis.tokenizer)[ctx.tokenizerName]);
      return tokenizer.type === 'nori_tokenizer' && !tokenizer.user_dictionary
        && Object.values(object(analysis.analyzer)).some((value) => {
          const analyzer = object(value);
          return analyzer.tokenizer === ctx.tokenizerName
            && Array.isArray(analyzer.char_filter) && analyzer.char_filter.includes('search_uppercase')
            && Array.isArray(analyzer.filter) && analyzer.filter.includes('uppercase') && !analyzer.filter.includes('lowercase');
        })
        && JSON.stringify([...rulesOf(tokenizer)].sort()) === JSON.stringify([...rules].sort());
    }) ? 'applied' : 'pending';
  } catch (error) {
    if ((error as { meta?: { statusCode?: number } }).meta?.statusCode !== 404) throw error;
  }
  return { targetIndex: ctx.targetIndex, templateName: ctx.template.name, rules, revision: revision(ctx.template.body), applicationStatus };
}

export async function getNoriDictionary(targetIndex: unknown): Promise<NoriDictionaryConfig> {
  return configOf(await context(targetIndex));
}

async function analyzeDraft(ctx: Awaited<ReturnType<typeof context>>, rules: string[], text: string): Promise<string[]> {
  const draftBody = structuredClone(ctx.template.body);
  uppercaseNoriTemplate(draftBody);
  const settings = object(object(draftBody.template).settings);
  const analysis = object(object(settings.index).analysis ?? settings.analysis);
  const analyzerName = object(object(object(draftBody.template).mappings).properties).goods_nm;
  const analyzer = object(object(analysis.analyzer)[String(object(analyzerName).analyzer)]);
  const components = (kind: 'filter' | 'char_filter') => {
    const definitions = object(analysis[kind]);
    const configured = analyzer[kind];
    return Array.isArray(configured) ? configured.map((name: string) => definitions[name] ?? name) : [];
  };
  // 임시 분석 요청으로 사전을 검증하며 기존 인덱스는 변경하지 않는다.
  try {
    const result = await elasticClient.transport.request<{ tokens?: Array<{ token: string }> }>({
      method: 'POST', path: '/_analyze',
      body: { text, tokenizer: { ...ctx.tokenizer, user_dictionary_rules: rules }, filter: components('filter'), char_filter: components('char_filter') },
    });
    return (result.tokens || []).map((item) => item.token);
  } catch (error) {
    const meta = (error as { meta?: { statusCode?: number; body?: { error?: { reason?: string } } } }).meta;
    if (meta?.statusCode === 400) throw new NoriDictionaryError(422, `사전 분석 검증에 실패했습니다: ${meta.body?.error?.reason || '등록 단어와 분해 방법을 확인해 주세요.'}`);
    throw error;
  }
}

export async function previewNoriDictionary(targetIndex: unknown, input: unknown, text: unknown): Promise<NoriDictionaryPreview> {
  if (typeof text !== 'string' || !text.trim() || text.length > 500) throw new NoriDictionaryError(422, '분석할 검색어는 1~500자로 입력해 주세요.');
  const rules = normalizeNoriRules(input);
  const ctx = await context(targetIndex);
  const draft = await analyzeDraft(ctx, rules, text);
  let current: string[] | null = null;
  try {
    const result = await elasticClient.indices.analyze({ index: ctx.targetIndex, field: 'goods_nm', text });
    current = (result.tokens || []).map((item) => item.token || '');
  } catch (error) {
    if ((error as { meta?: { statusCode?: number } }).meta?.statusCode !== 404) throw error;
  }
  return { current, draft };
}

export async function saveNoriDictionary(targetIndex: unknown, input: unknown, expectedRevision: unknown): Promise<NoriDictionaryConfig> {
  const rules = normalizeNoriRules(input);
  const ctx = await context(targetIndex);
  if (typeof expectedRevision !== 'string' || expectedRevision !== revision(ctx.template.body)) throw new NoriDictionaryError(409, '템플릿이 변경되었습니다. 새로고침한 후 다시 저장해 주세요.');
  await analyzeDraft(ctx, rules, '사용자 사전 검증');
  const latest = await context(targetIndex);
  if (revision(latest.template.body) !== expectedRevision) throw new NoriDictionaryError(409, '템플릿이 변경되었습니다. 새로고침한 후 다시 저장해 주세요.');
  latest.tokenizer.user_dictionary_rules = rules;
  await updateManagedIndexTemplate(latest.template.name, { name: latest.template.name, bodyText: JSON.stringify(latest.template.body) });
  return configOf(latest);
}
