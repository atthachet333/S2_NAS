import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Tag as TagIcon, X } from 'lucide-react';
import { ApiError, workspaceApi, type TagDto } from '@/lib/api';
import type { DriveEntry } from '@/lib/drive';
import { useToast } from '@/hooks/useToast';

const ERROR_TEXT: Record<string, string> = {
  TAG_CREATE_DENIED: 'คุณไม่มีสิทธิ์สร้างแท็กใหม่ เลือกจากแท็กที่มีอยู่แล้วได้',
  INVALID_TAG_NAME: 'ชื่อแท็กไม่ถูกต้อง',
  RESOURCE_ACCESS_DENIED: 'คุณไม่มีสิทธิ์แก้ไขแท็กของทรัพยากรนี้',
  RESOURCE_LOCKED: 'ทรัพยากรนี้ถูกล็อกอยู่ ต้องปลดล็อกก่อน',
  RESOURCE_NOT_FOUND: 'ไม่พบทรัพยากรนี้แล้ว',
};

/**
 * แผงจัดการแท็ก
 *
 * แท็กใช้ร่วมกันทั้งองค์กร ชื่อซ้ำโดยไม่สนตัวพิมพ์จะถูกยุบเป็นแท็กเดียวที่เซิร์ฟเวอร์
 * รายการที่แนะนำมาจากแท็กที่ผู้ใช้คนนี้เห็นได้จริงเท่านั้น
 */
export function TagEditor({ entry, onClose }: { entry: DriveEntry; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [term, setTerm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [tags, setTags] = useState<TagDto[]>(entry.tags);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const suggestions = useQuery({
    queryKey: ['tags', term.trim()],
    queryFn: () => workspaceApi.tags(term.trim() || undefined),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['tags'] });
    void queryClient.invalidateQueries({ queryKey: ['drive'] });
    void queryClient.invalidateQueries({ queryKey: ['search'] });
  };

  const add = useMutation({
    mutationFn: (name: string) => workspaceApi.addTag(entry.id, name),
    onSuccess: (result) => {
      setTags(result.data.tags);
      setTerm('');
      setError(null);
      refresh();
    },
    onError: (reason) =>
      setError(reason instanceof ApiError ? ERROR_TEXT[reason.code] ?? reason.message : 'เพิ่มแท็กไม่สำเร็จ'),
  });

  const remove = useMutation({
    mutationFn: (tagId: string) => workspaceApi.removeTag(entry.id, tagId),
    onSuccess: (result) => {
      setTags(result.data.tags);
      setError(null);
      refresh();
    },
    onError: (reason) =>
      setError(reason instanceof ApiError ? ERROR_TEXT[reason.code] ?? reason.message : 'ลบแท็กไม่สำเร็จ'),
  });

  const attached = new Set(tags.map((tag) => tag.id));
  const available = (suggestions.data?.data ?? []).filter((tag) => !attached.has(tag.id));

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-3 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-dialog-title"
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop sm:p-6"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
            <TagIcon className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="tag-dialog-title" className="text-[16px] font-semibold text-navy-900">จัดการแท็ก</h2>
            <p className="mt-1 truncate text-[11px] text-navy-400">{entry.name}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="ปิด" className="rounded-lg p-1.5 text-navy-400 hover:bg-navy-50">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <div>
            <p className="s2-section-title">แท็กของรายการนี้</p>
            {tags.length === 0 ? (
              <p className="mt-2 text-[11.5px] text-navy-400">ยังไม่มีแท็ก</p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <li key={tag.id}>
                    <span className="inline-flex items-center gap-1 rounded-md border border-line bg-[var(--s2-surface-soft)] py-0.5 pl-2 pr-1 text-[11.5px] text-navy-600">
                      {tag.name}
                      <button
                        type="button"
                        onClick={() => remove.mutate(tag.id)}
                        disabled={remove.isPending}
                        aria-label={`ลบแท็ก ${tag.name}`}
                        className="rounded p-0.5 text-navy-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (term.trim()) add.mutate(term.trim());
            }}
          >
            <label className="block text-[11.5px] font-semibold text-navy-700">
              เพิ่มแท็ก
              <input
                ref={inputRef}
                className="s2-input mt-1.5 h-11 rounded-xl px-3 text-[13px]"
                placeholder="พิมพ์ชื่อแท็ก เช่น สัญญา, ปิดงบ 2568"
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                maxLength={64}
              />
            </label>

            {available.length > 0 ? (
              <div className="mt-2">
                <p className="text-[10.5px] text-navy-400">แท็กที่ใช้อยู่แล้วในองค์กร</p>
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {available.slice(0, 12).map((tag) => (
                    <li key={tag.id}>
                      <button
                        type="button"
                        onClick={() => add.mutate(tag.name)}
                        disabled={add.isPending}
                        className="rounded-md border border-line px-2 py-0.5 text-[11.5px] text-navy-500 hover:bg-navy-50 disabled:opacity-50"
                      >
                        {tag.name}
                        <span className="ml-1 text-[10px] text-navy-300">{tag.resourceCount}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {error ? <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-[11.5px] text-red-700">{error}</p> : null}

            <div className="flex justify-end gap-2 pt-4">
              <button
                type="button"
                onClick={() => {
                  notify({ tone: 'success', title: 'บันทึกแท็กแล้ว' });
                  onClose();
                }}
                className="s2-btn s2-btn-ghost"
              >
                เสร็จสิ้น
              </button>
              <button type="submit" disabled={!term.trim() || add.isPending} className="s2-btn s2-btn-primary">
                {add.isPending ? 'กำลังเพิ่ม…' : 'เพิ่มแท็ก'}
              </button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}
