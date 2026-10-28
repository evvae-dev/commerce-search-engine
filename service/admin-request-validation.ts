import type { NextApiRequest } from 'next';

function getTrustedProtocol(req: NextApiRequest): string {
  const forwarded = req.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().toLowerCase();
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].split(',')[0].trim().toLowerCase();
  }
  return (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
}

export function isSameOriginJsonRequest(req: NextApiRequest): boolean {
  const host = typeof req.headers.host === 'string' ? req.headers.host.trim() : '';
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  const contentType = req.headers['content-type'] || '';
  if (!host || !origin || !contentType.toLowerCase().includes('application/json')) return false;
  try {
    const requestUrl = new URL(`${getTrustedProtocol(req)}://${host}`);
    const originUrl = new URL(origin);
    const port = (url: URL) => url.port || (url.protocol === 'https:' ? '443' : '80');
    return (
      requestUrl.protocol === originUrl.protocol &&
      requestUrl.hostname.toLowerCase() === originUrl.hostname.toLowerCase() &&
      port(requestUrl) === port(originUrl)
    );
  } catch {
    return false;
  }
}
