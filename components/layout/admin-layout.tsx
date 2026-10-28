import { signOut } from 'next-auth/react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import styles from './admin-layout.module.css';
import { AdminWorkspaceBar, useAdminShellBoundary } from '../admin/admin-workspace';
import { useAdminWorkspace } from '../admin/admin-workspace';

interface AdminLayoutProps {
  children: ReactNode;
  email: string;
}

interface NavigationChild {
  title: string;
  path?: string;
}

interface NavigationGroup {
  id: string;
  title: string;
  icon: ReactNode;
  children: NavigationChild[];
}

const navigation: NavigationGroup[] = [
  {
    id: 'index',
    title: '색인 관리',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3C7.58 3 4 4.34 4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6c0-1.66-3.58-3-8-3Zm0 2c3.87 0 6 .99 6 1s-2.13 1-6 1-6-.99-6-1 2.13-1 6-1Zm0 14c-3.87 0-6-.99-6-1v-2.08C7.45 16.61 9.63 17 12 17s4.55-.39 6-1.08V18c0 .01-2.13 1-6 1Zm0-4c-3.87 0-6-.99-6-1v-2.08C7.45 12.61 9.63 13 12 13s4.55-.39 6-1.08V14c0 .01-2.13 1-6 1Zm0-4c-3.87 0-6-.99-6-1V7.92C7.45 8.61 9.63 9 12 9s4.55-.39 6-1.08V10c0 .01-2.13 1-6 1Z" />
      </svg>
    ),
    children: [
      { title: '인덱스', path: '/admin/indexing' },
      { title: '임베딩', path: '/admin/embedding' },
      { title: '검색정렬', path: '/admin/sort-management' },
    ],
  },
  {
    id: 'query',
    title: '검색 설정',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M10 4a6 6 0 1 0 3.47 10.9l4.82 4.81 1.42-1.42-4.81-4.82A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" />
      </svg>
    ),
    children: [
      { title: '검색설정/시뮬레이션', path: '/admin/search-weight-tuning' },
      { title: '개인화', path: '/admin/personalization' },
      // { title: '검색비교', path: '/admin/search-compare' },
      { title: '비즈니스 룰 설정', path: '/admin/business-rule-management' },
      { title: '검색필터 관리', path: '/admin/search-filter-management' },
    ],
  },
  {
    id: 'dictionary',
    title: '사전 관리',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M18 2H8a4 4 0 0 0-4 4v13a3 3 0 0 0 3 3h13V4a2 2 0 0 0-2-2Zm0 18H7a1 1 0 0 1 0-2h11v2Zm0-4H8a4 4 0 0 0-2 .54V6a2 2 0 0 1 2-2h10v12Z" />
      </svg>
    ),
    children: [
      { title: '사용자 사전 관리', path: '/admin/nori-dictionary-management' },
      { title: '동의어/유의어 관리', path: '/admin/synonym-management' },
      { title: '불용어/금지어 관리', path: '/admin/word-policy-management' },
      { title: '요청 표현 관리', path: '/admin/request-expression-management' },
    ],
  },
  {
    id: 'statistics',
    title: '통계 및 분석',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 9.2h3V19H5V9.2ZM10.5 5h3v14h-3V5ZM16 12h3v7h-3v-7Z" />
      </svg>
    ),
    children: [
      { title: '검색어 통계' },
      { title: '검색 전환(CVR) 통계' },
      { title: '검색결과 없음 통계' },
    ],
  },
];

export default function AdminLayout({ children, email }: AdminLayoutProps) {
  const nestedLayout = useAdminShellBoundary();
  return nestedLayout ? <>{children}</> : <AdminLayoutShell email={email}>{children}</AdminLayoutShell>;
}

function AdminLayoutShell({ children, email }: AdminLayoutProps) {
  const { environment, setEnvironment } = useAdminWorkspace();
  const router = useRouter();
  const safeEmail = email || '관리자';
  const [sessionUser, setSessionUser] = useState<{
    name?: string | null;
    image?: string | null;
  }>({});
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<string[]>(() => {
    const activeGroup = navigation.find((group) =>
      group.children.some((item) => item.path === router.pathname),
    );
    return [activeGroup?.id || 'index'];
  });
  const displayName =
    sessionUser.name?.trim() || safeEmail.split('@')[0] || '관리자';

  useEffect(() => {
    let active = true;
    fetch('/api/auth/session', { headers: { Accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          session: {
            user?: { name?: string | null; image?: string | null };
          } | null,
        ) => {
          if (active && session?.user) setSessionUser(session.user);
        },
      )
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const toggleGroup = (groupId: string) => {
    if (collapsed) {
      setCollapsed(false);
      setOpenGroups([groupId]);
      return;
    }
    setOpenGroups((groups) =>
      groups.includes(groupId)
        ? groups.filter((id) => id !== groupId)
        : [...groups, groupId],
    );
  };

  const sidebar = (
    <div className={styles.sidebarBody}>
      <div className={styles.sidebarHeader}>
        {!collapsed && (
          <Link href="/admin/dashboard" className={styles.brand}>
            <strong>COMMERCE</strong>
            <span>Search Engine</span>
          </Link>
        )}
        <button
          type="button"
          className={styles.sidebarToggle}
          aria-label={collapsed ? '메뉴 펼치기' : '메뉴 접기'}
          onClick={() => {
            if (mobileOpen) {
              setMobileOpen(false);
              return;
            }
            setCollapsed((value) => !value);
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 6h16v2H4V6Zm0 5h16v2H4v-2Zm0 5h16v2H4v-2Z" />
          </svg>
        </button>
      </div>

      <Link
        href="/admin/search-tuning-guide"
        className={`${styles.guideLink} ${router.pathname === '/admin/search-tuning-guide' ? styles.guideLinkActive : ''}`}
        title={collapsed ? '검색엔진 가이드' : undefined}
        onClick={() => setMobileOpen(false)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M11 17h2v-2h-2v2Zm1-15a8 8 0 1 0 8 8 8.01 8.01 0 0 0-8-8Zm0 14a6 6 0 1 1 6-6 6.01 6.01 0 0 1-6 6Zm0-11a4 4 0 0 0-4 4h2a2 2 0 1 1 3.2 1.6A4.13 4.13 0 0 0 11 14h2a2.13 2.13 0 0 1 1.2-1.6A4 4 0 0 0 12 5Z" />
        </svg>
        {!collapsed && <span>검색엔진 가이드</span>}
      </Link>

      <div className={styles.environmentControl}>
        {!collapsed && <span>사용 환경</span>}
        <select aria-label="공통 사용 환경" value={environment} onChange={(event) => setEnvironment(event.target.value as 'prd' | 'dev')}>
          <option value="prd">{collapsed ? '운영' : '운영 (PROD)'}</option>
          <option value="dev">{collapsed ? '개발' : '개발 (DEV)'}</option>
        </select>
      </div>
      <nav className={styles.navigation} aria-label="검색엔진 관리자 메뉴">
        {navigation.map((group) => {
          const active = group.children.some(
            (item) => item.path === router.pathname,
          );
          const open = openGroups.includes(group.id);
          return (
            <div key={group.id} className={styles.navGroup}>
              <button
                type="button"
                className={`${styles.navGroupButton} ${active ? styles.navGroupButtonActive : ''}`}
                title={collapsed ? group.title : undefined}
                aria-expanded={open}
                onClick={() => toggleGroup(group.id)}
              >
                <span className={styles.navIcon}>{group.icon}</span>
                {!collapsed && (
                  <>
                    <span className={styles.navGroupTitle}>{group.title}</span>
                    <svg
                      className={`${styles.groupChevron} ${open ? styles.groupChevronOpen : ''}`}
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path d="m7.4 8.6 4.6 4.6 4.6-4.6L18 10l-6 6-6-6 1.4-1.4Z" />
                    </svg>
                  </>
                )}
              </button>
              {!collapsed && open && (
                <div className={styles.navChildren}>
                  {group.children.map((item) =>
                    item.path ? (
                      <Link
                        key={item.title}
                        href={item.path}
                        className={`${styles.navChildItem} ${router.pathname === item.path ? styles.navChildItemActive : ''}`}
                        onClick={() => setMobileOpen(false)}
                      >
                        <span className={styles.childDot} />
                        <span>{item.title}</span>
                      </Link>
                    ) : (
                      <span
                        key={item.title}
                        className={`${styles.navChildItem} ${styles.navChildItemReady}`}
                        title="추후 구현 예정"
                      >
                        <span className={styles.childDot} />
                        <span>{item.title}</span>
                        <small>준비</small>
                      </span>
                    ),
                  )}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div
        className={`${styles.sidebarUser} ${collapsed ? styles.sidebarUserCollapsed : ''}`}
      >
        <div
          className={styles.userAvatar}
          title={`${displayName} (${safeEmail})`}
        >
          {sessionUser.image ? (
            <Image
              src={sessionUser.image}
              alt={`${displayName} 프로필`}
              width={34}
              height={34}
              unoptimized
              referrerPolicy="no-referrer"
            />
          ) : (
            <span>G</span>
          )}
        </div>
        {!collapsed && (
          <div className={styles.userInfo}>
            <strong title={displayName}>{displayName}</strong>
            <span title={safeEmail}>{safeEmail}</span>
          </div>
        )}
        <button
          type="button"
          className={styles.sidebarLogout}
          title="로그아웃"
          aria-label="로그아웃"
          onClick={() => signOut({ callbackUrl: '/login' })}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M10 17v-2h4V9h-4V7l-5 5 5 5Zm8-14H8a2 2 0 0 0-2 2v3h2V5h10v14H8v-3H6v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Z" />
          </svg>
        </button>
      </div>
    </div>
  );

  return (
    <div
      className={`${styles.layout} ${collapsed ? styles.layoutCollapsed : ''}`}
    >
      <aside
        className={`${styles.desktopSidebar} ${collapsed ? styles.sidebarCollapsed : ''}`}
      >
        {sidebar}
      </aside>
      {mobileOpen && (
        <button
          type="button"
          className={styles.mobileBackdrop}
          aria-label="메뉴 닫기"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        className={`${styles.mobileSidebar} ${mobileOpen ? styles.mobileSidebarOpen : ''}`}
      >
        {sidebar}
      </aside>
      <div className={styles.mainColumn}>
        <header className={styles.mobileHeader}>
          <button
            type="button"
            className={styles.mobileMenuButton}
            aria-label="메뉴 열기"
            onClick={() => {
              setCollapsed(false);
              setMobileOpen(true);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h16v2H4V6Zm0 5h16v2H4v-2Zm0 5h16v2H4v-2Z" />
            </svg>
          </button>
          <Link href="/admin/dashboard" className={styles.mobileBrand}>
            COMMERCE <span>Search Engine</span>
          </Link>
        </header>
        <main className={styles.mainContent}><AdminWorkspaceBar />{children}</main>
      </div>
    </div>
  );
}
