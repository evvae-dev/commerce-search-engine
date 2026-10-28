import type { GetServerSideProps } from 'next';

export const getServerSideProps: GetServerSideProps = async () => ({
  redirect: {
    destination: '/admin/search-weight-tuning',
    permanent: false,
  },
});

export default function SearchRankingRedirect() {
  return null;
}
