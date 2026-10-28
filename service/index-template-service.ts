import { invalidateSearchMorphology } from './search-morphology-cache';
import { elasticClient } from './elastic-client';
import { uppercaseNoriTemplate } from '../scripts/search-uppercase.mjs';
import { listIndexingConfigs } from './indexing-config-service';

export interface ManagedIndexTemplate {
  name: string;
  indexPatterns: string[];
  priority: number | null;
  version: number | null;
  composedOf: string[];
  body: Record<string, unknown>;
}

export interface IndexTemplateInput {
  name: string;
  bodyText: string;
}

interface TemplateApiItem {
  name?: string;
  index_template?: Record<string, unknown> & {
    index_patterns?: unknown;
    priority?: unknown;
    version?: unknown;
    composed_of?: unknown;
  };
}

interface TemplateApiResponse {
  index_templates?: TemplateApiItem[];
}

export class IndexTemplateValidationError extends Error {
  statusCode: number;
  errorCode: string;

  constructor(statusCode: number, errorCode: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

function getStatusCode(error: unknown): number | undefined {
  const typed = error as { statusCode?: number; meta?: { statusCode?: number } };
  return typed.statusCode ?? typed.meta?.statusCode;
}

function getReason(error: unknown): string {
  const typed = error as { message?: string; meta?: { body?: { error?: { reason?: string; root_cause?: Array<{ reason?: string }> } } } };
  return typed.meta?.body?.error?.root_cause?.[0]?.reason
    || typed.meta?.body?.error?.reason
    || typed.message
    || 'Elasticsearch가 인덱스 템플릿을 처리하지 못했습니다.';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

async function getManagedIndexNames(): Promise<string[]> {
  return [...new Set((await listIndexingConfigs()).map((config) => config.indexName))];
}

function patternBelongsToManagedIndex(pattern: string, indexNames: string[]): boolean {
  return indexNames.some((indexName) => pattern === indexName || pattern.startsWith(`${indexName}-`));
}

function toManagedTemplate(item: TemplateApiItem): ManagedIndexTemplate | null {
  const name = item.name;
  const body = item.index_template;
  if (!name || !body) return null;
  const indexPatterns = asStringArray(body.index_patterns);
  // 조회 응답의 날짜 메타데이터는 PUT/시뮬레이션 요청 본문에 사용할 수 없다.
  const editableBody = { ...body };
  delete editableBody.created_date_millis;
  delete editableBody.modified_date_millis;
  return {
    name,
    indexPatterns,
    priority: typeof body.priority === 'number' ? body.priority : null,
    version: typeof body.version === 'number' ? body.version : null,
    composedOf: asStringArray(body.composed_of),
    body: editableBody,
  };
}

async function requestTemplates(name?: string): Promise<TemplateApiResponse> {
  return elasticClient.transport.request<TemplateApiResponse>({
    method: 'GET',
    path: name ? `/_index_template/${encodeURIComponent(name)}` : '/_index_template',
  });
}

export async function listManagedIndexTemplates(): Promise<{ templates: ManagedIndexTemplate[]; availableIndices: string[] }> {
  const availableIndices = await getManagedIndexNames();
  const response = await requestTemplates();
  const templates = (response.index_templates || [])
    .map(toManagedTemplate)
    .filter((item): item is ManagedIndexTemplate => Boolean(item))
    .filter((item) => !item.name.startsWith('.') && item.indexPatterns.some((pattern) => patternBelongsToManagedIndex(pattern, availableIndices)))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { templates, availableIndices: availableIndices.sort() };
}

function parseInput(input: IndexTemplateInput, availableIndices: string[]): { name: string; body: Record<string, unknown> } {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!/^[a-z0-9][a-z0-9_-]{1,99}$/.test(name) || name.startsWith('.')) {
    throw new IndexTemplateValidationError(400, 'INVALID_TEMPLATE_NAME', '템플릿명은 영문 소문자 또는 숫자로 시작하고 소문자, 숫자, 밑줄, 하이픈만 사용할 수 있습니다.');
  }
  const bodyText = typeof input?.bodyText === 'string' ? input.bodyText.trim() : '';
  if (!bodyText || Buffer.byteLength(bodyText, 'utf8') > 2 * 1024 * 1024) {
    throw new IndexTemplateValidationError(400, 'INVALID_TEMPLATE_BODY', '템플릿 JSON은 1자 이상 2MB 이하로 입력해 주세요.');
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch (error) {
    throw new IndexTemplateValidationError(400, 'INVALID_TEMPLATE_JSON', `템플릿 JSON 문법이 올바르지 않습니다: ${error instanceof Error ? error.message : '파싱 실패'}`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new IndexTemplateValidationError(400, 'INVALID_TEMPLATE_BODY', '템플릿은 JSON 객체여야 합니다.');
  }
  const normalized = body as Record<string, unknown>;
  const patterns = asStringArray(normalized.index_patterns);
  if (!patterns.length || patterns.length !== (normalized.index_patterns as unknown[])?.length) {
    throw new IndexTemplateValidationError(400, 'INVALID_INDEX_PATTERNS', 'index_patterns에는 하나 이상의 문자열 패턴이 필요합니다.');
  }
  const invalidPattern = patterns.find((pattern) => !patternBelongsToManagedIndex(pattern, availableIndices));
  if (invalidPattern) {
    throw new IndexTemplateValidationError(400, 'UNMANAGED_INDEX_PATTERN', `등록된 색인 범위를 벗어난 패턴은 사용할 수 없습니다: ${invalidPattern}`);
  }
  return { name, body: normalized };
}

async function assertTemplateState(name: string, shouldExist: boolean): Promise<void> {
  try {
    await requestTemplates(name);
    if (!shouldExist) throw new IndexTemplateValidationError(409, 'DUPLICATE_TEMPLATE', '같은 이름의 템플릿이 이미 존재합니다.');
  } catch (error) {
    if (error instanceof IndexTemplateValidationError) throw error;
    if (getStatusCode(error) === 404) {
      if (shouldExist) throw new IndexTemplateValidationError(404, 'TEMPLATE_NOT_FOUND', '인덱스 템플릿을 찾을 수 없습니다.');
      return;
    }
    throw error;
  }
}

async function validateAndSave(input: IndexTemplateInput, shouldExist: boolean): Promise<void> {
  const availableIndices = await getManagedIndexNames();
  const { name, body } = parseInput(input, availableIndices);
  uppercaseNoriTemplate(body);
  await assertTemplateState(name, shouldExist);
  try {
    // 동일 이름의 기존 템플릿을 교체하는 조건으로 검증해 같은 우선순위 충돌을 오탐하지 않는다.
    await elasticClient.transport.request({ method: 'POST', path: `/_index_template/_simulate/${encodeURIComponent(name)}`, body });
    await elasticClient.transport.request({ method: 'PUT', path: `/_index_template/${encodeURIComponent(name)}`, body });
    invalidateSearchMorphology();
  } catch (error) {
    throw new IndexTemplateValidationError(422, 'TEMPLATE_VALIDATION_FAILED', `Elasticsearch 템플릿 검증에 실패했습니다: ${getReason(error)}`);
  }
}

export async function createManagedIndexTemplate(input: IndexTemplateInput): Promise<void> {
  await validateAndSave(input, false);
}

export async function updateManagedIndexTemplate(name: string, input: IndexTemplateInput): Promise<void> {
  if (input.name !== name) throw new IndexTemplateValidationError(400, 'TEMPLATE_NAME_IMMUTABLE', '수정 시 템플릿명은 변경할 수 없습니다.');
  await validateAndSave(input, true);
}

export async function deleteManagedIndexTemplate(name: string): Promise<void> {
  const { templates } = await listManagedIndexTemplates();
  if (!templates.some((template) => template.name === name)) {
    throw new IndexTemplateValidationError(404, 'TEMPLATE_NOT_FOUND', '관리 가능한 인덱스 템플릿을 찾을 수 없습니다.');
  }
  await elasticClient.transport.request({ method: 'DELETE', path: `/_index_template/${encodeURIComponent(name)}` });
}

export function getIndexTemplateError(error: unknown): { statusCode: number; errorCode: string; message: string } {
  if (error instanceof IndexTemplateValidationError) {
    return { statusCode: error.statusCode, errorCode: error.errorCode, message: error.message };
  }
  return { statusCode: getStatusCode(error) || 500, errorCode: 'INDEX_TEMPLATE_ERROR', message: getReason(error) };
}
