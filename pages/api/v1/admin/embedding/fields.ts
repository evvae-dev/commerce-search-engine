import type { NextApiRequest, NextApiResponse } from 'next';

import { requireAdminAuthApi } from '../../../../../service/admin-auth';
import { sendInternalServerError } from '../../../../../service/api-error';
import { elasticClient } from '../../../../../service/elastic-client';
import { getIndexingConfig } from '../../../../../service/indexing-config-service';

interface MappingNode { type?: string; properties?: Record<string, MappingNode>; }
function collectFields(value: MappingNode | undefined, prefix = '', output = new Set<string>()): Set<string> {
  const properties = value?.properties || {};
  Object.entries(properties).forEach(([name, mapping]) => {
    const field = prefix ? `${prefix}.${name}` : name;
    if (mapping?.properties) collectFields(mapping, field, output);
    else if (mapping.type !== 'dense_vector' && !['embedding_text', 'embedding_version', 'embedding_hash', 'embedding_source', 'embedding_geo_fingerprint', 'embedding_context_hash', 'geo_content', 'geo_payload'].includes(name)) output.add(field);
  });
  return output;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await requireAdminAuthApi(req, res))) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, errorMessage: '허용되지 않은 HTTP 메서드입니다.' });
  const configId = typeof req.query.configId === 'string' ? req.query.configId : '';
  try {
    const config = await getIndexingConfig(configId);
    if (!config) return res.status(404).json({ success: false, errorMessage: '인덱스 설정을 찾을 수 없습니다.' });
    const mappings = await elasticClient.indices.getMapping({ index: `${config.indexName}*` });
    const fields = new Set<string>();
    Object.values(mappings).forEach((mapping) => collectFields((mapping as { mappings?: MappingNode }).mappings, '', fields));
    return res.status(200).json({ success: true, fields: [...fields].sort() });
  } catch (error) {
    return sendInternalServerError(res, error);
  }
}
