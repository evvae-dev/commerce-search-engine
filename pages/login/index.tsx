import type { GetServerSideProps } from 'next';
import Head from 'next/head';
import { useRouter } from 'next/router';
import React, { useState } from 'react';
import { signIn } from 'next-auth/react';

import { getAdminPageSession } from '../../service/admin-auth';
import styles from './login.module.css';

export const getServerSideProps: GetServerSideProps = async (context) => {
  const admin = await getAdminPageSession(context);
  if (admin) {
    return {
      redirect: {
        destination: '/admin/dashboard',
        permanent: false,
      },
    };
  }

  return {
    props: {
      demoEnabled: process.env.DEMO_AUTH_ENABLED === 'true',
      googleEnabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    },
  };
};

function getErrorMessage(error: string | string[] | undefined): string | null {
  if (!error || typeof error !== 'string') {
    return null;
  }
  switch (error) {
    case 'AccessDenied':
      return '접근 권한이 없습니다. 승인된 관리자 구글 계정(도메인 및 이메일)으로 로그인해 주세요.';
    case 'Configuration':
      return '인증 서버 설정 오류가 발생했습니다. 환경변수 설정을 확인해 주세요.';
    default:
      return '로그인 중 오류가 발생했습니다. 다시 시도해 주세요.';
  }
}

export default function LoginPage({ demoEnabled, googleEnabled }: { demoEnabled: boolean; googleEnabled: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState('');
  const errorMessage = getErrorMessage(router.query.error);

  const handleGoogleLogin = async () => {
    setLoading(true);
    try {
      await signIn('google', {
        callbackUrl: '/admin/dashboard',
      });
    } catch {
      setLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <Head>
        <title>Commerce Demo 검색엔진 -관리자 로그인</title>
      </Head>
      <div className={styles.card}>
        <div className={styles.header}>
          <h1 className={styles.title}>Commerce Demo 검색엔진 관리 시스템</h1>
        </div>
        <p className={styles.description}>
          {demoEnabled ? '로컬 설정의 데모 비밀번호로 로그인합니다.' : '구글 계정으로 로그인하여 검색엔진 관리 시스템에 접근합니다.'}
        </p>
        {errorMessage && (
          <div className={styles.errorBanner}>{errorMessage}</div>
        )}
        {demoEnabled && <form className={styles.demoForm} onSubmit={(event) => {
          event.preventDefault();
          setLoading(true);
          void signIn('demo', { password, callbackUrl: '/admin/dashboard' }).finally(() => setLoading(false));
        }}>
          <label htmlFor="demo-password">데모 비밀번호</label>
          <input id="demo-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          <button type="submit" className={styles.googleButton} disabled={loading}>{loading ? '로그인 중...' : '데모 로그인'}</button>
        </form>}
        {googleEnabled && <button
          type="button"
          className={styles.googleButton}
          onClick={handleGoogleLogin}
          disabled={loading}
        >
          {loading ? '로그인 중...' : 'Google 계정으로 로그인'}
        </button>}
      </div>
    </div>
  );
}
