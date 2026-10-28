import type { GetServerSideProps } from 'next';

import AdminDashboardPage from '../dashboard';
import { getAdminPageSession } from '../../../service/admin-auth';

interface IndexingPageProps {
  email: string;
}

export const getServerSideProps: GetServerSideProps<IndexingPageProps> = async (context) => {
  const admin = await getAdminPageSession(context);
  if (!admin) {
    return { redirect: { destination: '/login', permanent: false } };
  }
  return { props: { email: admin.email } };
};

export default AdminDashboardPage;