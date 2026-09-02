import { useEffect, useRef, useState } from 'react';
import { Clock, HardDrive, Search, Share2, ShieldCheck, Star, Trash2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';

const baseCommands = [
  { label: 'ไปไดร์ฟของฉัน', path: '/files', icon: HardDrive },
  { label: 'แชร์กับฉัน', path: '/shared', icon: Share2 },
  { label: 'ล่าสุด', path: '/recent', icon: Clock },
  { label: 'รายการโปรด', path: '/favorites', icon: Star },
  { label: 'ถังขยะ', path: '/trash', icon: Trash2 },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { user } = useAuth();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setOpen(true); }
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
  useEffect(() => { if (open) window.setTimeout(() => inputRef.current?.focus(), 0); }, [open]);
  const commands = user?.permissions.includes('admin:access')
    ? [...baseCommands, { label: 'เปิด Admin', path: '/admin', icon: ShieldCheck }]
    : baseCommands;
  const filtered = commands.filter((command) => command.label.toLowerCase().includes(query.toLowerCase()));
  if (!open) return null;
  return <div className="fixed inset-0 z-[var(--z-palette)] flex items-start justify-center bg-[var(--s2-overlay)] px-4 pt-[14vh] backdrop-blur-[3px]" role="presentation" onMouseDown={() => setOpen(false)}>
    <section role="dialog" aria-modal="true" aria-label="Command palette" className="w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-[var(--s2-elevated)] shadow-pop" onMouseDown={(event) => event.stopPropagation()}>
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Search className="h-4 w-4 text-navy-400" />
        <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหาคำสั่ง…" className="h-14 min-w-0 flex-1 bg-transparent text-[14px] text-navy-900 outline-none placeholder:text-navy-300" />
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-navy-400 hover:bg-navy-50" aria-label="ปิด"><X className="h-4 w-4" /></button>
      </div>
      <div className="max-h-80 overflow-y-auto p-2">
        {filtered.map((command, index) => <button key={command.path} type="button" autoFocus={index === 0} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] text-navy-700 hover:bg-navy-50 hover:text-navy-900" onClick={() => { navigate(command.path); setOpen(false); setQuery(''); }}>
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-navy-50 text-navy-500"><command.icon className="h-4 w-4" /></span>{command.label}
        </button>)}
        {filtered.length === 0 ? <p className="px-3 py-8 text-center text-[12px] text-navy-400">ไม่พบคำสั่ง</p> : null}
      </div>
      <footer className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[10.5px] text-navy-300"><span>นำทางใน S2 NAS</span><span><span className="s2-kbd">Esc</span> ปิด</span></footer>
    </section>
  </div>;
}
