import { Client } from '@elastic/elasticsearch';
import { applySearchBudget } from './search-budget';

import {
  ELASTICSEARCH_NODE,
  ELASTICSEARCH_REQUEST_TIMEOUT_MS,
} from '../constant/api.constant';

const username = process.env.ELASTICSEARCH_USERNAME;
const password = process.env.ELASTICSEARCH_PASSWORD;

if ((username && !password) || (!username && password)) {
  throw new Error(
    'ELASTICSEARCH_USERNAME and ELASTICSEARCH_PASSWORD must be configured together.',
  );
}

const globalWithElastic = globalThis as typeof globalThis & {
  elasticClient?: Client;
};

export const elasticClient =
  applySearchBudget(globalWithElastic.elasticClient ??
  new Client({
    node: ELASTICSEARCH_NODE,
    maxRetries: 2,
    requestTimeout: ELASTICSEARCH_REQUEST_TIMEOUT_MS,
    ...(username && password
      ? {
          auth: {
            username,
            password,
          },
        }
      : {}),
  }));

if (process.env.NODE_ENV !== 'production') {
  globalWithElastic.elasticClient = elasticClient;
}
