import { getGoodsIndex } from './goods-index.constant.mjs';

export const ELASTICSEARCH_NODE =
  process.env.ELASTICSEARCH_NODE ?? 'http://127.0.0.1:19200';

export const GOODS_INDEX =
  process.env.ELASTICSEARCH_GOODS_INDEX ?? getGoodsIndex('dev');

export const ELASTICSEARCH_REQUEST_TIMEOUT_MS = Number(
  process.env.ELASTICSEARCH_REQUEST_TIMEOUT_MS ?? 5000,
);

export const EMBEDDING_NODE =
  process.env.EMBEDDING_NODE ?? 'http://127.0.0.1:18080';

export const EMBEDDING_REQUEST_TIMEOUT_MS = Number(
  process.env.EMBEDDING_REQUEST_TIMEOUT_MS ?? 30000,
);

export const SEMANTIC_SEARCH_ENABLED =
  process.env.SEMANTIC_SEARCH_ENABLED === 'true';

export const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN ?? '*';

export const INDEXING_JOBS_INDEX =
  process.env.INDEXING_JOBS_INDEX ?? '.commerce-indexing-jobs-v1';

export const INDEXING_LOCK_ID = 'lock:indexing';

export const INDEXING_PRD_MANUAL_ENABLED =
  process.env.INDEXING_PRD_MANUAL_ENABLED === 'true';

export const INDEXING_PRD_INCREMENTAL_ENABLED =
  process.env.INDEXING_PRD_INCREMENTAL_ENABLED === 'true';
