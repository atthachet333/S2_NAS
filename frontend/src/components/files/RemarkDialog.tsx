import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageSquareText, X } from 'lucide-react';
import { ApiError, workspaceApi } from '@/lib/api';
import type { DriveEntry } from '@/lib/drive';
import { useToast } from '@/hooks/useToast';

const MAX_LENGTH = 1000;

const ERROR_TEXT: Record<string, string> = {
  RESOURCE_ACCESS_DENIED: 'คุณไม่มีสิทธิ์แก้ไขหมายเหตุของทรัพยากรนี้',
  RESOURCE_LOCKED: 'ทรัพยากรนี้ถูกล็อกอยู่ ต้องปลดล็อกก่อน',
  REMARK_TOO_LONG: `หมายเหตุยาวเกิน ${MAX_LENGTH} ตัวอักษร`,
  RESOURCE_NOT_FOUND: 'ไม่พบทรัพยากรนี้แล้ว',
};

/**
 * หมายเหตุของทรัพยากร
 *
 * เนื้อความหมายเหตุไม่ถูกบันทึกลง activity log โดยตั้งใจ เพราะอาจมีข้อมูลภายใน
 * บันทึกจะเก็บเพียงว่ามีการแก้ไขหรือลบเท่านั้น
 */
export function RemarkDialog({ entry, onClose }: { entry: DriveEntry; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [value, setValue] = useState(entry.remark ?? '');
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { areaRef.current?.focus(); }, []);

  const save = useMutation({
    mutationFn: () => workspaceApi.updateRemark(entry.id, value.trim() ? value.trim() : null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['drive'] });
      void queryClient.invalidateQueries({ queryKey: ['resource'] });
      void queryClient.invalidateQueries({ queryKey: ['search'] });
      notify({ tone: 'success', title: value.trim() ? 'บันทึกหมายเหตุแล้ว' : 'ลบหมายเหตุแล้ว' });
      onClose();
    },
    onError: (reason) =>
      setError(reason instanceof ApiError ? ERROR_TEXT[reason.code] ?? reason.message : 'บันทึกหมายเหตุไม่สำเร็จ'),
  });

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-3 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="remark-dialog-title"
        className="w-full max-w-md rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop sm:p-6"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
            <MessageSquareText className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="remark-dialog-title" className="text-[16px] font-semibold text-navy-900">หมายเหตุ</h2>
            <p className="mt-1 truncate text-[11px] text-navy-400">{entry.name}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="ปิด" className="rounded-lg p-1.5 text-navy-400 hover:bg-navy-50">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <label className="block text-[11.5px] font-semibold text-navy-700">
            รายละเอียดเพิ่มเติม
            <textarea
              ref={areaRef}
              className="s2-input mt-1.5 min-h-28 rounded-xl px-3 py-2.5 text-[13px]"
              value={value}
              maxLength={MAX_LENGTH}
              onChange={(event) => setValue(event.target.value)}
              placeholder="เช่น เอกสารชุดนี้ใช้ประกอบการปิดงบเดือนสิงหาคม"
            />
          </label>
          <p className="text-right text-[10.5px] text-navy-300">{value.length}/{MAX_LENGTH}</p>

          {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-[11.5px] text-red-700">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="s2-btn s2-btn-ghost">ยกเลิก</button>
            <button type="submit" disabled={save.isPending} className="s2-btn s2-btn-primary">
              {save.isPending ? 'กำลังบันทึก…' : value.trim() ? 'บันทึก' : 'ลบหมายเหตุ'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
