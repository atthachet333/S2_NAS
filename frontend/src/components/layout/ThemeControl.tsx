import { useRef, useState } from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type ThemePreference } from '@/hooks/useTheme';
import { useOutsideClose } from '@/hooks/useOutsideClose';

const choices: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export function ThemeControl({ compact = false }: { compact?: boolean }) {
  const { preference, resolved, setPreference } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, open, () => setOpen(false));
  const ActiveIcon = resolved === 'dark' ? Moon : Sun;
  return <div className="relative" ref={ref}>
    <button type="button" onClick={() => setOpen((v) => !v)} className="rounded-[11px] border border-line bg-surface p-2 text-navy-500 shadow-subtle hover:bg-navy-50 hover:text-navy-900" aria-label="ตั้งค่าธีม" aria-haspopup="menu" aria-expanded={open}>
      <ActiveIcon className="h-4 w-4" />
      {!compact ? <span className="sr-only">ธีม {preference}</span> : null}
    </button>
    {open ? <div role="menu" className="s2-menu absolute right-0 z-[var(--z-menu)] mt-7 w-44">
      {choices.map((choice) => <button key={choice.value} type="button" role="menuitem" className="s2-menu-item" onClick={() => { setPreference(choice.value); setOpen(false); }}>
        <choice.icon className="h-4 w-4 text-navy-400" /><span className="flex-1">{choice.label}</span>{preference === choice.value ? <Check className="h-3.5 w-3.5 text-brand-600" /> : null}
      </button>)}
    </div> : null}
  </div>;
}
