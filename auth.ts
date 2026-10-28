import type { NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import CredentialsProvider from 'next-auth/providers/credentials';
import { timingSafeEqual } from 'node:crypto';

import { isAllowedAdminEmail } from './service/indexing-admin-policy';

export const authOptions: NextAuthOptions = {
  providers: [
    ...(process.env.DEMO_AUTH_ENABLED === 'true' ? [CredentialsProvider({
      id: 'demo',
      name: '로컬 데모 계정',
      credentials: { password: { label: '데모 비밀번호', type: 'password' } },
      async authorize(credentials, req) {
        const host = req.headers?.host;
        if (typeof host !== 'string' || !/^(localhost|127\.0\.0\.1):3200$/.test(host)) return null;
        const expected = process.env.DEMO_ADMIN_PASSWORD || '';
        const supplied = credentials?.password || '';
        if (expected.length < 16 || Buffer.byteLength(expected) !== Buffer.byteLength(supplied)) return null;
        if (!timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return null;
        return { id: 'demo-admin', email: 'demo@example.test', name: '데모 관리자' };
      },
    })] : []),
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    }),
    ] : []),
  ],
  session: {
    strategy: 'jwt',
    maxAge: 8 * 60 * 60,
  },
  pages: {
    signIn: '/login',
    error: '/login',
  },
  callbacks: {
    async signIn({ account, profile, user }) {
      if (account?.provider === 'demo') return process.env.DEMO_AUTH_ENABLED === 'true' && user.email === 'demo@example.test';
      if (account?.provider !== 'google') {
        return false;
      }

      const googleProfile = profile as { email_verified?: boolean } | undefined;
      if (googleProfile?.email_verified !== true) {
        return false;
      }
      return isAllowedAdminEmail(user.email);
    },
    async jwt({ token, user }) {
      if (user?.email) {
        token.email = user.email.trim().toLowerCase();
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && typeof token.email === 'string') {
        session.user.email = token.email;
      }
      return session;
    },
  },
};
