import { useRef } from 'react';

import styles from './environment-tabs.module.css';

export type AdminEnvironment = 'prd' | 'dev';

interface EnvironmentTabsProps {
  value: AdminEnvironment;
  onChange: (value: AdminEnvironment) => void;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-controls'?: string;
}

const environments: Array<{ value: AdminEnvironment; label: string }> = [
  { value: 'prd', label: '운영 (PROD)' },
  { value: 'dev', label: '개발 (DEV)' },
];

export default function EnvironmentTabs({
  value,
  onChange,
  disabled = false,
  'aria-label': ariaLabel = '환경 선택',
  'aria-controls': ariaControls,
}: EnvironmentTabsProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusTab = (index: number) => {
    const next = (index + environments.length) % environments.length;
    refs.current[next]?.focus();
    onChange(environments[next].value);
  };
  return (
    <div className={styles.tabList} role="tablist" aria-label={ariaLabel} aria-controls={ariaControls}>
      {environments.map((environment, index) => (
        <button
          key={environment.value}
          ref={(element) => { refs.current[index] = element; }}
          type="button"
          role="tab"
          aria-selected={value === environment.value}
          aria-controls={ariaControls}
          tabIndex={value === environment.value ? 0 : -1}
          disabled={disabled}
          className={`${styles.tab} ${value === environment.value ? styles.active : ''}`}
          onClick={() => onChange(environment.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') { event.preventDefault(); focusTab(index + 1); }
            else if (event.key === 'ArrowLeft') { event.preventDefault(); focusTab(index - 1); }
            else if (event.key === 'Home') { event.preventDefault(); focusTab(0); }
            else if (event.key === 'End') { event.preventDefault(); focusTab(environments.length - 1); }
          }}
        >
          {environment.label}
        </button>
      ))}
    </div>
  );
}
