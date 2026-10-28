import { isDeepStrictEqual } from 'node:util';
import { uppercaseSearchText, uppercaseDictionaryRules, uppercaseNoriTemplate } from './search-uppercase.mjs';

const BRAND_FIELDS = ['bnd_nm_ko', 'bnd_nm_en'];
const CATEGORY_FIELDS = ['up_disp_clsf_nm', 'disp_clsf_nm'];

/** 공백은 붙여쓰기 후보로 정리하고 경로 구분자는 카테고리에서만 나눈다. */
export function addDictionaryWords(words, row) {
  for (const [field, value] of Object.entries(row)) {
    const name = field.toLowerCase();
    if (![...BRAND_FIELDS, ...CATEGORY_FIELDS].includes(name) || typeof value !== 'string') continue;
    const candidates = CATEGORY_FIELDS.includes(name) ? value.split(/[>/|]/u) : [value];
    for (const candidate of candidates) {
      const word = uppercaseSearchText(candidate).replace(/\((?:outlet|아울렛)\)/ig, '').replace(/\s+/gu, '');
      if (Array.from(word).length < 2 || word.length > 200 || /[\u0000-\u001f\u007f-\u009f,#]/u.test(word) || /^\d+$/u.test(word)) continue;
      words.add(word);
    }
  }
}

/** 원본 SQL에서 실제로 제공하는 컬럼만 조회한다. 신규 인덱스에도 사용할 수 있다. */
export async function collectDictionaryWords(connection, sql, binds, check) {
  const words = new Set();
  const statement = connection.prepare(sql);
  for (const row of statement.iterate(binds)) {
    check();
    addDictionaryWords(words, row);
  }
  return words;
}

export function mergeDictionaryRules(existing, words) {
  const rules = uppercaseDictionaryRules(existing);
  const registered = new Set(rules.map((rule) => rule.trim().split(/\s+/u)[0]));
  for (const word of [...words].map(uppercaseSearchText).sort()) {
    if (registered.has(word)) continue;
    rules.push(word);
    registered.add(word);
  }
  return rules;
}

/** 사용자 입력 규칙은 유지하고 새 단어만 전체색인용 템플릿에 추가한다. */
export async function registerDictionaryWords(client, indexName, words, requestOptions) {
  const { index_templates: templates = [] } = await client.indices.getIndexTemplate({}, requestOptions());
  const matches = templates.filter(({ index_template: body }) => body.index_patterns?.includes(`${indexName}-*`));
  if (matches.length !== 1) throw new Error('사용자 사전 자동등록에 필요한 인덱스 전용 템플릿을 확인해 주세요.');
  const { name, index_template: original } = matches[0];
  const body = structuredClone(original);
  delete body.created_date_millis;
  delete body.modified_date_millis;
  if (body.index_patterns.length !== 1 || body.composed_of?.length) throw new Error('공유·컴포넌트 템플릿에는 사전을 자동등록할 수 없습니다. 인덱스 전용 템플릿을 설정해 주세요.');
  const settings = body.template?.settings;
  const analysis = settings?.index?.analysis ?? settings?.analysis;
  const analyzerName = Object.values(body.template?.mappings?.properties || {})
    .map((mapping) => mapping?.analyzer)
    .find((name) => analysis?.analyzer?.[name]);
  const analyzer = analysis?.analyzer?.[analyzerName];
  const tokenizer = analysis?.tokenizer?.[analyzer?.tokenizer];
  if (tokenizer?.type !== 'nori_tokenizer' || tokenizer.user_dictionary) throw new Error('인라인 사용자 사전을 지원하는 Nori 분석 필드를 템플릿에 설정해 주세요.');
  const existing = tokenizer.user_dictionary_rules || [];
  const rules = mergeDictionaryRules(existing, words);
  const added = Math.max(0, rules.length - uppercaseDictionaryRules(existing).length);
  tokenizer.user_dictionary_rules = rules;
  uppercaseNoriTemplate(body);
  const comparable = structuredClone(original);
  delete comparable.created_date_millis;
  delete comparable.modified_date_millis;
  if (isDeepStrictEqual(body, comparable)) return added;
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 2 * 1024 * 1024) throw new Error('사전 자동등록 후 템플릿이 2MB를 초과합니다. 사용자 사전을 정리해 주세요.');
  await client.transport.request({ method: 'POST', path: `/_index_template/_simulate/${encodeURIComponent(name)}`, body }, requestOptions());
  const latest = await client.indices.getIndexTemplate({ name }, requestOptions());
  if (!isDeepStrictEqual(latest.index_templates[0]?.index_template, original)) throw new Error('사전 자동등록 중 템플릿이 변경되었습니다. 전체색인을 다시 실행해 주세요.');
  await client.transport.request({ method: 'PUT', path: `/_index_template/${encodeURIComponent(name)}`, body }, requestOptions());
  return added;
}
