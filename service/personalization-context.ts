import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextApiRequest } from 'next';

export class InvalidPersonalizationContextError extends Error {}

function header(req: NextApiRequest, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || '' : value || '';
}

export function createPersonalizationCanonicalString(memberNo: string, timestamp: string): string {
  return `${memberNo}.${timestamp}`;
}

export function getPersonalizationMemberNo(req: NextApiRequest): string | null {
  const memberNo = header(req, 'x-demo-member-no').trim();
  const timestamp = header(req, 'x-demo-timestamp').trim();
  const signature = header(req, 'x-demo-signature').trim();
  if (!memberNo && !timestamp && !signature) return null;
  const secret = process.env.PERSONALIZATION_CONTEXT_SECRET;
  if (!secret || !/^\d+$/.test(memberNo) || !/^\d+$/.test(timestamp) || !/^[a-f\d]{64}$/i.test(signature)) throw new InvalidPersonalizationContextError('개인화 인증 정보가 올바르지 않습니다.');
  const timeMs = Number(timestamp) < 100000000000 ? Number(timestamp) * 1000 : Number(timestamp);
  const configuredMaxAge = Number(process.env.PERSONALIZATION_CONTEXT_MAX_AGE_MS);
  const maxAge = Number.isInteger(configuredMaxAge) && configuredMaxAge > 0 ? configuredMaxAge : 300000;
  if (Math.abs(Date.now() - timeMs) > maxAge) throw new InvalidPersonalizationContextError('개인화 인증 정보가 만료되었습니다.');
  const expected = createHmac('sha256', secret).update(createPersonalizationCanonicalString(memberNo, timestamp)).digest('hex');
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature.toLowerCase()))) throw new InvalidPersonalizationContextError('개인화 서명이 올바르지 않습니다.');
  return memberNo;
}
