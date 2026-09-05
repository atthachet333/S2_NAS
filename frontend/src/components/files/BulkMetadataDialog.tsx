import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, X } from 'lucide-react';
import { ApiError, bulkApi, categoryApi, workspaceApi, type BulkOutcomeDto } from '@/lib/api';
import type { DriveEntry } from '@/lib/drive';
import { useToast } from '@/hooks/useToast';

/**
 * แก้ข้อมูลประกอบของหลายรายการพร้อมกัน
 *
 * รายงานผลตามความจริงเสมอ - สำเร็จ ข้าม และล้มเหลว เป็นคนละจำนวนกัน
 * งานสองร้อยรายการที่บอกว่า "สำเร็จ" ก้อนเดียวทั้งที่มีสิบรายการไม่ผ่าน
 * คือการโกหกที่ผู้ใช้จะไปเจอเองทีหลังในเวลาที่แย่กว่า
 */

type Mode = 'tag' | 'category' | 'owner';

const MODE_LABELS: Record<Mode, string> = {
  tag: 'เพิ่มแท็ก',
  category: 'กำหนดประเภทเอกสาร',
  owner: 'เปลี่ยนผู้ดูแล',
};

const ERROR_TEXT: Record<string, string> = {
  BULK_TOO_MANY: 'เลือกรายการมากเกินไป กรุณาแบ่งเป็นหลายครั้ง',
  BULK_EMPTY: 'กรุณาเลือกอย่างน้อยหนึ่งรายการ',
  OWNER_NOT_FOUND: 'ผู้ดูแลที่เลือกไม่ใช่บัญชีภายในที่เปิดใช้งานอยู่',
  CATEGORY_INACTIVE: 'ประเภทเอกสารนี้ถูกปิดการใช้งานอยู่',
  TAG_CREATE_DENIED: 'คุณไม่มีสิทธิ์สร้างแท็กใหม่ขององค์กร',
};

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? (ERROR_TEXT[error.code] ?? error.message ?? fallback) : fallback;

export function BulkMetadataDialog({
  entries,
  onClose,
  onDone,
}: {
  entries: DriveEntry[];
  onClose: () => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [mode, setMode] = useState<Mode>('tag');
  const [tagName, setTagName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [outcome, setOutcome] = useState<BulkOutcomeDto | null>(null);

  const categories = useQuery({ queryKey: ['document-categories'], queryFn: () => categoryApi.list() });
  const facets = useQuery({ queryKey: ['search-facets'], queryFn: workspaceApi.facets });

  const ids = entries.map((entry) => entry.id);
  const fileCount = entries.filter((entry) => entry.kind !== 'folder').length;

  const run = useMutation({
    mutationFn: async () => {
      if (mode === 'tag') return bulkApi.addTag(ids, tagName.trim());
      if (mode === 'category') return bulkApi.setCategory(ids, categoryId || null);
      return bulkApi.setOwner(ids, ownerId);
    },
    onSuccess: (result) => {
      setOutcome(result.data);
      void queryClient.invalidateQueries({ queryKey: ['resources'] });
      void queryClient.invalidateQueries({ queryKey: ['search'] });
      if (result.data.failed === 0) {
        notify({
          tone: 'success',
          title: `${MODE_LABELS[mode]}สำเร็จ ${result.data.succeeded} รายการ`,
        });
      }
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'ดำเนินการไม่สำเร็จ') }),
  });

  const canRun =
    (mode === 'tag' && tagName.trim().length > 0) ||
    (mode === 'category' && (categoryId !== '' || categoryId === '')) ||
    (mode === 'owner' && ownerId !== '');

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-3 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-dialog-title"
        className="w-full max-w-lg rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="bulk-dialog-title" className="text-sm font-semibold text-navy-800">
              แก้ข้อมูลของ {entries.length} รายการ
            </h2>
            <p className="mt-0.5 text-[11.5px] text-navy-400">
              ระบบตรวจสิทธิ์ของทุกรายการแยกกัน รายการที่ไม่มีสิทธิ์จะไม่ถูกแก้
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="s2-btn s2-btn-ghost h-8 w-8 shrink-0 p-0"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {outcome ? (
          <div className="mt-4 space-y-3">
            {/* รายงานสามจำนวนแยกกันตามความจริง */}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-2">
                <p className="text-[18px] font-semibold text-emerald-700">{outcome.succeeded}</p>
                <p className="text-[11px] text-emerald-700">สำเร็จ</p>
              </div>
              <div className="rounded-lg border border-line bg-[var(--s2-surface-soft)] px-2 py-2">
                <p className="text-[18px] font-semibold text-navy-600">{outcome.skipped}</p>
                <p className="text-[11px] text-navy-500">ข้าม</p>
              </div>
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-2 py-2">
                <p className="text-[18px] font-semibold text-rose-700">{outcome.failed}</p>
                <p className="text-[11px] text-rose-700">ล้มเหลว</p>
              </div>
            </div>

            {outcome.errors.length > 0 ? (
              <ul className="max-h-32 space-y-1 overflow-y-auto rounded-lg bg-[var(--s2-surface-soft)] p-2">
                {outcome.errors.map((error) => (
                  <li key={error.resourceId} className="text-[11px] text-navy-500">
                    {error.message}
                  </li>
                ))}
              </ul>
            ) : null}

            <button
              type="button"
              onClick={() => {
                onDone();
                onClose();
              }}
              className="s2-btn s2-btn-primary h-9 w-full text-[12.5px]"
            >
              เสร็จสิ้น
            </button>
          </div>
        ) : (
          <>
            <div className="mt-4 flex gap-1.5">
              {(Object.keys(MODE_LABELS) as Mode[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMode(key)}
                  aria-pressed={mode === key}
                  className={`flex-1 rounded-lg border px-2 py-1.5 text-[11.5px] ${
                    mode === key
                      ? 'border-brand-300 bg-brand-50 font-medium text-brand-700'
                      : 'border-line text-navy-600'
                  }`}
                >
                  {MODE_LABELS[key]}
                </button>
              ))}
            </div>

            <div className="mt-3">
              {mode === 'tag' ? (
                <label className="flex flex-col gap-1">
                  <span className="text-[11.5px] font-medium text-navy-600">ชื่อแท็ก</span>
                  <input
                    value={tagName}
                    onChange={(event) => setTagName(event.target.value)}
                    maxLength={64}
                    placeholder="เช่น ภาษี2569"
                    className="s2-input h-9 text-[12.5px]"
                  />
                  <span className="text-[10.5px] text-navy-400">
                    แท็กเดิมของแต่ละรายการจะไม่ถูกลบ
                  </span>
                </label>
              ) : mode === 'category' ? (
                <label className="flex flex-col gap-1">
                  <span className="text-[11.5px] font-medium text-navy-600">ประเภทเอกสาร</span>
                  <select
                    value={categoryId}
                    onChange={(event) => setCategoryId(event.target.value)}
                    className="s2-input h-9 text-[12.5px]"
                  >
                    <option value="">— ล้างประเภท —</option>
                    {(categories.data?.data ?? []).map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                  <span className="text-[10.5px] text-navy-400">
                    ใช้ได้กับไฟล์เท่านั้น โฟลเดอร์ {entries.length - fileCount} รายการจะถูกข้าม
                  </span>
                </label>
              ) : (
                <label className="flex flex-col gap-1">
                  <span className="text-[11.5px] font-medium text-navy-600">ผู้ดูแลคนใหม่</span>
                  <select
                    value={ownerId}
                    onChange={(event) => setOwnerId(event.target.value)}
                    className="s2-input h-9 text-[12.5px]"
                  >
                    <option value="">เลือกผู้ดูแล</option>
                    {(facets.data?.data.owners ?? []).map((owner) => (
                      <option key={owner.id} value={owner.id}>
                        {owner.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="s2-btn s2-btn-ghost h-9 text-[12.5px]">
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={() => run.mutate()}
                disabled={!canRun || run.isPending}
                className="s2-btn s2-btn-primary h-9 gap-1.5 text-[12.5px] disabled:opacity-60"
              >
                {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                ดำเนินการ
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
