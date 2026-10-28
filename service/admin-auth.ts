import type {
  GetServerSidePropsContext,
  NextApiRequest,
  NextApiResponse,
} from 'next';
import type { Session } from 'next-auth';
import { getServerSession } from 'next-auth/next';

import { authOptions } from '../auth';
import {
  isAllowedAdminEmail,
  normalizeEmail,
} from './indexing-admin-policy';

export interface AdminAuthResult {
  email: string;
}


function resolveAdminSession(session: Session | null): AdminAuthResult | null {
  const email = normalizeEmail(session?.user?.email);
  if (!email) {
    return null;
  }
  if (!isAllowedAdminEmail(email)) {
    return null;
  }
  return { email };
}

/**
 * SSR 요청에서 JWT 세션을 조회하고 현재 관리자 허용 정책을 재검증한다.
 */
export async function getAdminPageSession(
  context: GetServerSidePropsContext,
): Promise<AdminAuthResult | null> {

  try {
    return resolveAdminSession(
      await getServerSession(context.req, context.res, authOptions),
    );
  } catch {
    return null;
  }
}

export async function requireAdminAuthApi(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<string | null> {

  let admin: AdminAuthResult | null = null;
  try {
    admin = resolveAdminSession(await getServerSession(req, res, authOptions));
  } catch {
    admin = null;
  }

  if (!admin) {
    res.status(401).json({
      success: false,
      errorCode: 'UNAUTHORIZED',
      errorMessage: '관리자 인증이 필요하거나 접근 권한이 없습니다.',
    });
    return null;
  }
  return admin.email;
}
