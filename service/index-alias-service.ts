import { deleteOldDatedIndices, isDatedIndexName, switchIndexAlias as switchAlias } from '../scripts/index-alias.mjs';

import { INDEXING_JOBS_INDEX } from '../constant/api.constant';
import { elasticClient } from './elastic-client';
import type { IndexingConfig } from './indexing-config-service';

export async function switchIndexAlias(aliasName: string, targetIndex: string): Promise<void> {
  await switchAlias(elasticClient, aliasName, targetIndex);
}

export async function switchAliasToLatestSuccessfulFull(
  config: IndexingConfig,
): Promise<{ targetIndex: string; deletedIndices: string[] }> {
  const response = await elasticClient.search({
    index: INDEXING_JOBS_INDEX,
    size: 20,
    sort: [{ finishedAt: { order: 'desc', unmapped_type: 'date' } }],
    _source: ['targetIndices'],
    query: {
      bool: {
        filter: [
          { term: { docType: 'job' } },
          { term: { configId: config.id } },
          { term: { operation: 'full' } },
          { term: { status: 'succeeded' } },
        ],
      },
    },
  });
  const targetIndex = response.hits.hits
    .flatMap((hit) => {
      const source = hit._source as { targetIndices?: string[] } | undefined;
      return source?.targetIndices || [];
    })
    .find((indexName) => isDatedIndexName(config.indexName, indexName));
  if (!targetIndex) {
    throw new Error('성공한 전체 색인의 날짜 인덱스를 찾을 수 없습니다.');
  }
  await switchIndexAlias(config.indexName, targetIndex);

  // 현재 alias 대상과 최신 과거 전체색인 2개만 보존한다.
  const deletedIndices = await deleteOldDatedIndices(elasticClient, config.indexName, targetIndex);
  return { targetIndex, deletedIndices };
}
