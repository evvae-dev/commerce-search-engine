import Head from 'next/head';
import type { ReactNode } from 'react';
import { useAdminPageActive } from './admin-workspace';

// 숨겨진 탭의 제목이 현재 페이지 제목을 덮어쓰지 않도록 한다.
export default function AdminPageHead({ children }: { children: ReactNode }) {
  return useAdminPageActive() ? <Head>{children}</Head> : null;
}
