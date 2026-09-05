import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, BookmarkPlus, Loader2, Pencil, Sparkles, Trash2 } from 'lucide-react';
import { ApiError, savedSearchApi, smartViewApi, type SavedSearchDto } from '@/lib/api';
import type { SearchFilters } from '@/lib/search-filters';
import { useToast } from '@/hooks/useToast';

/**
 * ชุดค้นหาที่บันทึกไว้ และมุมมองอัจฉริยะ
 *
 * วางไว้เป็นเมนูรองข้างช่องค้นหา ไม่ทำเป็นแถบด้านข้างถาวร - แอปนี้ตั้งใจไม่มี
 * แถบด้านข้างที่สอง การเพิ่มเข้ามาเพื่อสองรายการนี้จะเบียดพื้นที่เนื้อหาโดยไม่คุ้ม
 */

const ERROR_TEXT: Record<string, string> = {
  SAVED_SEARCH_NAME_EXISTS: 'มีชุดค้นหาชื่อนี้อยู่แล้ว',
  SAVED_SEARCH_NAME_REQUIRED: 'กรุณาตั้งชื่อชุดค้นหา',
  SAVED_SEARCH_LIMIT_REACHED: 'บันทึกชุดค้นหาได้สูงสุด 100 ชุด',
  SAVED_SEARCH_NOT_FOUND: 'ไม่พบชุดค้นหานี้แล้ว',
};

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? (ERROR_TEXT[error.code] ?? error.message ?? fallback) : fallback;

interface Props {
  query: string;
  filters: SearchFilters;
  /** เรียกเมื่อผู้ใช้เลือกชุดค้นหา - หน้าค้นหาจะเขียนค่าลง URL เอง */
  onApply: (query: string, filters: SearchFilters) => void;
  onApplySmartView: (slug: string) => void;
}

export function SavedSearchMenu({ query, filters, onApply, onApplySmartView }: Props) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [open, setOpen] = useState<'saved' | 'smart' | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const saved = useQuery({ queryKey: ['saved-searches'], queryFn: savedSearchApi.list });
  const views = useQuery({
    queryKey: ['smart-views'],
    queryFn: smartViewApi.list,
    // รายชื่อมุมมองเป็นค่าคงที่ของระบบ ไม่ต้องถามซ้ำบ่อย
    staleTime: 10 * 60_000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['saved-searches'] });

  const create = useMutation({
    mutationFn: () =>
      savedSearchApi.create({ name: name.trim(), query, filters: filters as Record<string, unknown> }),
    onSuccess: () => {
      setNaming(false);
      setName('');
      void invalidate();
      notify({ tone: 'success', title: 'บันทึกชุดค้นหาแล้ว' });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'บันทึกไม่สำเร็จ') }),
  });

  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      savedSearchApi.update(input.id, { name: input.name }),
    onSuccess: () => {
      void invalidate();
      notify({ tone: 'success', title: 'เปลี่ยนชื่อแล้ว' });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'เปลี่ยนชื่อไม่สำเร็จ') }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => savedSearchApi.remove(id),
    onSuccess: () => {
      void invalidate();
      notify({ tone: 'success', title: 'ลบชุดค้นหาแล้ว' });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'ลบไม่สำเร็จ') }),
  });

  const apply = (item: SavedSearchDto) => {
    setOpen(null);
    onApply(item.query, item.filters as SearchFilters);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* ---- บันทึกการค้นหาปัจจุบัน ---- */}
      {naming ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) create.mutate();
          }}
          className="flex items-center gap-1.5"
        >
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="ชื่อชุดค้นหา"
            maxLength={100}
            aria-label="ชื่อชุดค้นหา"
            className="s2-input h-8 w-44 text-[12px]"
          />
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="s2-btn s2-btn-primary h-8 px-2.5 text-[12px] disabled:opacity-60"
          >
            {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : 'บันทึก'}
          </button>
          <button
            type="button"
            onClick={() => setNaming(false)}
            className="s2-btn s2-btn-ghost h-8 px-2 text-[12px]"
          >
            ยกเลิก
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setNaming(true)}
          className="s2-btn s2-btn-outline h-8 gap-1.5 px-2.5 text-[12px]"
        >
          <BookmarkPlus className="h-3.5 w-3.5" aria-hidden />
          บันทึกการค้นหา
        </button>
      )}

      {/* ---- ชุดที่บันทึกไว้ ---- */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen(open === 'saved' ? null : 'saved')}
          aria-expanded={open === 'saved'}
          className="s2-btn s2-btn-ghost h-8 gap-1.5 px-2.5 text-[12px]"
        >
          <Bookmark className="h-3.5 w-3.5" aria-hidden />
          การค้นหาที่บันทึกไว้
          {(saved.data?.data.length ?? 0) > 0 ? (
            <span className="rounded-md bg-[var(--s2-surface-soft)] px-1.5 text-[10px]">
              {saved.data!.data.length}
            </span>
          ) : null}
        </button>

        {open === 'saved' ? (
          <div className="absolute right-0 z-[var(--z-menu)] mt-1 max-h-80 w-72 overflow-y-auto rounded-xl border border-line bg-[var(--s2-elevated)] p-1.5 shadow-pop">
            {saved.isPending ? (
              <p className="px-2 py-3 text-center text-[11.5px] text-navy-400">กำลังโหลด…</p>
            ) : (saved.data?.data.length ?? 0) === 0 ? (
              <p className="px-2 py-3 text-center text-[11.5px] leading-relaxed text-navy-400">
                ยังไม่มีชุดค้นหาที่บันทึกไว้
                <br />
                ตั้งตัวกรองที่ใช้บ่อยแล้วกด “บันทึกการค้นหา”
              </p>
            ) : (
              <ul className="space-y-0.5">
                {saved.data!.data.map((item) => (
                  <li key={item.id} className="group flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => apply(item)}
                      className="min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-left text-[12px] text-navy-700 hover:bg-[var(--s2-surface-soft)]"
                    >
                      {item.name}
                    </button>
                    <button
                      type="button"
                      aria-label={`เปลี่ยนชื่อ ${item.name}`}
                      onClick={() => {
                        const next = window.prompt('ชื่อใหม่ของชุดค้นหา', item.name);
                        if (next && next.trim() && next !== item.name) {
                          rename.mutate({ id: item.id, name: next.trim() });
                        }
                      }}
                      className="s2-btn s2-btn-ghost h-6 w-6 shrink-0 p-0 opacity-0 group-hover:opacity-100 focus:opacity-100"
                    >
                      <Pencil className="h-3 w-3" aria-hidden />
                    </button>
                    <button
                      type="button"
                      aria-label={`ลบ ${item.name}`}
                      onClick={() => {
                        if (window.confirm(`ลบชุดค้นหา “${item.name}” ?`)) remove.mutate(item.id);
                      }}
                      className="s2-btn s2-btn-ghost h-6 w-6 shrink-0 p-0 text-rose-600 opacity-0 group-hover:opacity-100 focus:opacity-100"
                    >
                      <Trash2 className="h-3 w-3" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>

      {/* ---- มุมมองอัจฉริยะ ---- */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen(open === 'smart' ? null : 'smart')}
          aria-expanded={open === 'smart'}
          className="s2-btn s2-btn-ghost h-8 gap-1.5 px-2.5 text-[12px]"
        >
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          มุมมองอัจฉริยะ
        </button>

        {open === 'smart' ? (
          <div className="absolute right-0 z-[var(--z-menu)] mt-1 max-h-80 w-80 overflow-y-auto rounded-xl border border-line bg-[var(--s2-elevated)] p-1.5 shadow-pop">
            <ul className="space-y-0.5">
              {(views.data?.data ?? []).map((view) => (
                <li key={view.slug}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(null);
                      onApplySmartView(view.slug);
                    }}
                    className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-[var(--s2-surface-soft)]"
                  >
                    <span className="block text-[12px] font-medium text-navy-700">{view.name}</span>
                    {/* อธิบายว่ามุมมองคัดอะไรมา ผู้ใช้จะได้ไม่ต้องเดาจากชื่อ */}
                    <span className="block text-[10.5px] leading-relaxed text-navy-400">
                      {view.description}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
