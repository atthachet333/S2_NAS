import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CornerDownLeft, Search } from 'lucide-react';
import { workspaceApi } from '@/lib/api';
import { FileTypeIcon } from '@/components/files/FileTypeIcon';
import { nextMenuIndex } from '@/lib/interaction-policy';

const DEBOUNCE_MS = 250;
const MAX_SUGGESTIONS = 8;

/**
 * ค้นหาทั่วระบบจากแถบหัวเรื่อง
 *
 * ผลลัพธ์มาจาก /api/search ซึ่งกรองสิทธิ์มาแล้วที่เซิร์ฟเวอร์ ฝั่งหน้าเว็บจึงไม่ต้อง
 * (และต้องไม่) กรองเพิ่มเอง เพราะจะทำให้เห็นจำนวนไม่ตรงกับที่กดดูทั้งหมด
 *
 * ใช้คีย์บอร์ดได้เต็มรูปแบบ: "/" โฟกัส, ลูกศรเลื่อน, Enter เปิด, Esc ปิด
 */
export function GlobalSearch() {
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(term.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [term]);

  // ทางลัด "/" เพื่อโฟกัสช่องค้นหา แบบเดียวกับเครื่องมือจัดการไฟล์ทั่วไป
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typingInField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;
      if (event.key === '/' && !typingInField) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const results = useQuery({
    queryKey: ['search', 'quick', debounced],
    queryFn: () => workspaceApi.search(new URLSearchParams({ q: debounced, limit: String(MAX_SUGGESTIONS) })),
    enabled: debounced.length > 0,
  });

  const items = results.data?.data.items ?? [];
  const total = results.data?.data.total ?? 0;

  const openEntry = (index: number) => {
    const item = items[index];
    if (!item) return;
    setOpen(false);
    // ไฟล์ไม่มีหน้าของตัวเอง จึงพาไปที่โฟลเดอร์ที่มันอยู่ พร้อมบอกให้เลือกไฟล์นั้นให้ด้วย
    // มิฉะนั้นผู้ใช้จะถูกทิ้งไว้กลางโฟลเดอร์และต้องไล่หาไฟล์ที่เพิ่งค้นเจอเอง
    navigate(
      item.type === 'FOLDER'
        ? `/files/${item.id}`
        : `/files/${item.parentId ?? ''}?focus=${encodeURIComponent(item.id)}`,
    );
  };

  const seeAll = () => {
    setOpen(false);
    navigate(`/search?q=${encodeURIComponent(debounced)}`);
  };

  return (
    <div ref={boxRef} className="relative mx-auto hidden w-full max-w-2xl sm:block">
      <Search
        className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-navy-300"
        aria-hidden
      />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls="global-search-results"
        aria-autocomplete="list"
        value={term}
        onChange={(event) => {
          setTerm(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => term.trim() && setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { setOpen(false); return; }
          if (event.key === 'Enter') {
            event.preventDefault();
            if (open && items[active]) openEntry(active);
            else if (debounced) seeAll();
            return;
          }
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && items.length > 0) {
            event.preventDefault();
            setOpen(true);
            setActive((current) => nextMenuIndex(current, event.key, items.length));
          }
        }}
        placeholder="ค้นหาไฟล์ โฟลเดอร์ ลิงก์ หรือทรัพยากร..."
        aria-label="ค้นหาไฟล์และโฟลเดอร์"
        className="s2-input h-10 rounded-[12px] pl-10 pr-12 text-[13px] placeholder:text-navy-300"
      />
      <span className="s2-kbd pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">/</span>

      {open && debounced ? (
        <div
          id="global-search-results"
          role="listbox"
          aria-label="ผลการค้นหา"
          className="s2-menu absolute left-0 right-0 top-[calc(100%+8px)] z-[var(--z-menu)] max-h-[420px] overflow-y-auto p-1.5"
        >
          {results.isPending ? (
            <p className="px-3 py-6 text-center text-[12px] text-navy-400">กำลังค้นหา…</p>
          ) : items.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-navy-400">ไม่พบรายการที่ตรงกับ “{debounced}”</p>
          ) : (
            <>
              {items.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => openEntry(index)}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left ${
                    index === active ? 'bg-navy-50' : ''
                  }`}
                >
                  <FileTypeIcon name={item.name} kind={item.type === 'FOLDER' ? 'folder' : 'file'} resourceType={item.type} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-navy-800">{item.name}</span>
                    <span className="block truncate text-[10.5px] text-navy-400">
                      ผู้ดูแล {item.owner.displayName}
                      {item.tags.length > 0 ? ` · ${item.tags.map((tag) => tag.name).join(', ')}` : ''}
                    </span>
                  </span>
                </button>
              ))}

              <button
                type="button"
                onClick={seeAll}
                className="mt-1 flex w-full items-center justify-between gap-2 rounded-xl border-t border-line px-2.5 py-2.5 text-left text-[12px] text-brand-700 hover:bg-navy-50"
              >
                <span>ดูผลทั้งหมด {total} รายการ</span>
                <CornerDownLeft className="h-3.5 w-3.5" aria-hidden />
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
