import type { NextApiRequest, NextApiResponse } from 'next';

import { requireAdminAuthApi } from '../../../../service/admin-auth';
import { isSameOriginJsonRequest } from '../../../../service/admin-request-validation';
import { sendInternalServerError } from '../../../../service/api-error';
import { IndexTemplateValidationError } from '../../../../service/index-template-service';
import { listDictionaryTargets } from '../../../../service/search-dictionary-service';
import { getNoriDictionary, NoriDictionaryError, previewNoriDictionary, saveNoriDictionary } from '../../../../service/nori-dictionary-service';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await requireAdminAuthApi(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST', 'PUT'].includes(req.method || '')) {
    res.setHeader('Allow', 'GET, POST, PUT');
    return res.status(405).json({ success: false, errorMessage: '허용되지 않은 HTTP 메서드입니다.' });
  }
  if (req.method !== 'GET' && !isSameOriginJsonRequest(req)) return res.status(403).json({ success: false, errorMessage: '동일 출처의 JSON 요청만 허용됩니다.' });
  try {
    if (req.method === 'GET') {
      const targets = await listDictionaryTargets();
      if (!req.query.targetIndex) return res.status(200).json({ success: true, targets });
      return res.status(200).json({ success: true, targets, config: await getNoriDictionary(req.query.targetIndex) });
    }
    const { targetIndex, rules, revision, text } = req.body || {};
    if (req.method === 'POST') return res.status(200).json({ success: true, preview: await previewNoriDictionary(targetIndex, rules, text) });
    return res.status(200).json({ success: true, config: await saveNoriDictionary(targetIndex, rules, revision) });
  } catch (error) {
    if (error instanceof NoriDictionaryError || error instanceof IndexTemplateValidationError) return res.status(error.statusCode).json({ success: false, errorMessage: error.message });
    return sendInternalServerError(res, error);
  }
}
