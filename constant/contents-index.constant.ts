export const CONTENTS_INDEX_BY_ENVIRONMENT = {
  dev: 'dev-search-contents',
  prd: 'prd-search-contents',
} as const;

export function getContentsIndex(environment: 'dev' | 'prd'): string {
  return CONTENTS_INDEX_BY_ENVIRONMENT[environment];
}

export function isContentsIndex(value: unknown): value is string {
  return typeof value === 'string' && Object.values(CONTENTS_INDEX_BY_ENVIRONMENT).includes(value as 'dev-search-contents' | 'prd-search-contents');
}
