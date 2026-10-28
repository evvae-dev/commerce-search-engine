import type { AppProps } from 'next/app';
import Head from 'next/head';
import { AdminWorkspaceProvider } from '../components/admin/admin-workspace';
import { useRouter } from 'next/router';

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();
  const page = !router.pathname.startsWith('/admin') ? (
    <Component {...pageProps} />
  ) : (
    <AdminWorkspaceProvider email={pageProps.email || ''}>
      <Component {...pageProps} />
    </AdminWorkspaceProvider>
  );

  return (
    <>
      <Head>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      </Head>
      {page}
    </>
  );
}
