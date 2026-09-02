import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function MenuItem({
  icon,
  label,
  shortcut,
  onSelect,
  disabled = false,
  danger = false,
}: {
  icon?: ReactNode;
  label: string;
  shortcut?: string;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={cn('s2-menu-item', danger && 'text-red-600 hover:bg-red-50')}
    >
      {icon ? <span className="shrink-0 text-navy-400">{icon}</span> : null}
      <span className="flex-1 truncate">{label}</span>
      {shortcut ? <span className="text-[11px] text-navy-300">{shortcut}</span> : null}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-navy-300">
      {children}
    </p>
  );
}
