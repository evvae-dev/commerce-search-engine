/* eslint-disable react-hooks/set-state-in-effect -- 저장된 환경은 hydration 이후에만 복원한다. */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/router';
import AdminLayout from '../layout/admin-layout';
import type { AdminEnvironment } from './environment-tabs';
import styles from './admin-workspace.module.css';

type Panel = { path: string; content: ReactNode };
type Workspace = {
  environment: AdminEnvironment;
  setEnvironment: (value: AdminEnvironment) => void;
  tabs: Array<{ path: string; title: string }>;
  closeTab: (path: string) => void;
};
const WorkspaceContext = createContext<Workspace | null>(null);
const ShellContext = createContext(false);
const PageContext = createContext({ path: '', active: false });
const titles: Record<string, string> = {
  '/admin/dashboard': '대시보드',
  '/admin/indexing': '인덱스',
  '/admin/embedding': '임베딩',
  '/admin/sort-management': '검색정렬',
  '/admin/search-weight-tuning': '검색설정/시뮬레이션',
  '/admin/personalization': '개인화',
  '/admin/search-compare': '검색비교',
  '/admin/business-rule-management': '비즈니스 룰 설정',
  '/admin/search-filter-management': '검색필터 관리',
  '/admin/synonym-management': '동의어/유의어 관리',
  '/admin/nori-dictionary-management': '사용자 사전 관리',
  '/admin/word-policy-management': '불용어/금지어 관리',
  '/admin/request-expression-management': '요청 표현 관리',
  '/admin/search-tuning-guide': '검색엔진 가이드',
};
export const useAdminShellBoundary = () => useContext(ShellContext);
export const useAdminPagePath = () => useContext(PageContext).path;
export const useAdminPageActive = () => useContext(PageContext).active;

export function AdminWorkspaceProvider({
  children,
  email,
}: {
  children: ReactNode;
  email: string;
}) {
  const router = useRouter();
  const path = router.pathname;
  const [environment, setEnvironmentState] = useState<AdminEnvironment>('prd');
  const [cache, setCache] = useState<{ lastPath: string; panels: Panel[] }>({
    lastPath: path,
    panels: [{ path, content: children }],
  });
  // 경로 전환 시 기존 React 인스턴스를 보존한다. 닫은 탭만 캐시에서 제거한다.
  if (cache.lastPath !== path) {
    setCache({
      lastPath: path,
      panels: cache.panels.some((panel) => panel.path === path)
        ? cache.panels
        : [...cache.panels, { path, content: children }],
    });
  }
  useEffect(() => {
    try {
      if (sessionStorage.getItem('admin-environment') === 'dev')
        setEnvironmentState('dev');
    } catch {
      /* 저장소가 차단되어도 기본 운영 환경으로 사용할 수 있다. */
    }
  }, []);
  const setEnvironment = (value: AdminEnvironment) => {
    if (value === environment) return;
    if (
      !window.confirm(
        '환경을 변경하면 열린 페이지의 저장하지 않은 입력과 검색 결과가 초기화됩니다. 변경하시겠습니까?',
      )
    )
      return;
    setEnvironmentState(value);
    try {
      sessionStorage.setItem('admin-environment', value);
    } catch {
      /* 현재 세션 상태만 유지한다. */
    }
  };
  const closeTab = async (closedPath: string) => {
    if (closedPath === '/admin/dashboard') return;
    const remaining = cache.panels.filter((panel) => panel.path !== closedPath);
    if (
      path === closedPath &&
      !(await router.push(
        remaining[remaining.length - 1]?.path || '/admin/dashboard',
      ))
    )
      return;
    setCache((current) => ({
      ...current,
      panels: current.panels.filter((panel) => panel.path !== closedPath),
    }));
  };
  const paths = [
    ...new Set([
      '/admin/dashboard',
      ...cache.panels.map((panel) => panel.path),
    ]),
  ];
  return (
    <WorkspaceContext.Provider
      value={{
        environment,
        setEnvironment,
        tabs: paths.map((tabPath) => ({
          path: tabPath,
          title: titles[tabPath] || '관리자 페이지',
        })),
        closeTab: (tabPath) => {
          void closeTab(tabPath);
        },
      }}
    >
      <AdminLayout email={email}>
        <ShellContext.Provider value={true}>
          {cache.panels.map((panel) => (
            <PageContext.Provider
              key={`${environment}:${panel.path}`}
              value={{ path: panel.path, active: panel.path === path }}
            >
              <section
                className={styles.panel}
                role="tabpanel"
                aria-label={titles[panel.path]}
                hidden={panel.path !== path}
              >
                {panel.content}
              </section>
            </PageContext.Provider>
          ))}
        </ShellContext.Provider>
      </AdminLayout>
    </WorkspaceContext.Provider>
  );
}
export function useAdminWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('AdminWorkspaceProvider가 필요합니다.');
  return value;
}
export function AdminWorkspaceBar() {
  const router = useRouter();
  const { tabs, closeTab } = useAdminWorkspace();
  return (
    <div className={styles.bar}>
      <div
        className={styles.tabs}
        role="tablist"
        aria-label="열린 관리자 페이지"
      >
        {tabs.map((tab, index) => (
          <div
            key={tab.path}
            className={`${styles.tab} ${router.pathname === tab.path ? styles.active : ''}`}
          >
            <button
              type="button"
              role="tab"
              title={tab.title}
              aria-selected={router.pathname === tab.path}
              tabIndex={router.pathname === tab.path ? 0 : -1}
              onKeyDown={(event) => {
                const offset =
                  event.key === 'ArrowRight'
                    ? 1
                    : event.key === 'ArrowLeft'
                      ? -1
                      : 0;
                if (!offset) return;
                event.preventDefault();
                const next = (index + offset + tabs.length) % tabs.length;
                event.currentTarget
                  .closest('[role="tablist"]')
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [next]?.focus();
                void router.push(tabs[next].path);
              }}
              onClick={() => void router.push(tab.path)}
            >
              {tab.title}
            </button>
            {tab.path !== '/admin/dashboard' && (
              <button
                type="button"
                aria-label={`${tab.title} 닫기`}
                onClick={() => closeTab(tab.path)}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
