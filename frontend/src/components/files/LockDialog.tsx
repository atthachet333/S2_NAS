import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, LockOpen, X } from 'lucide-react';
import { ApiError, workspaceApi } from '@/lib/api';
import type { DriveEntry } from '@/lib/drive';
import { formatDateTime } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';

const MAX_REASON = 500;

const ERROR_TEXT: Record<string, string> = {
  LOCK_DENIED: 'คุณไม่มีสิทธิ์ล็อกหรือปลดล็อกทรัพยากรนี้',
  RESOURCE_ALREADY_LOCKED: 'ทรัพยากรนี้ถูกล็อกไปแล้ว',
  RESOURCE_NOT_LOCKED: 'ทรัพยากรนี้ไม่ได้ถูกล็อกอยู่',
  RESOURCE_NOT_FOUND: 'ไม่พบทรัพยากรนี้แล้ว',
};

/**
 * ล็อก / ปลดล็อกทรัพยากร
 *
 * การล็อกไม่ปิดกั้นการเปิดดูหรือดาวน์โหลด แต่หยุดการแก้ไขทุกรูปแบบ
 * ใช้กับเอกสารที่ปิดงบหรือส่งหน่วยงานภายนอกไปแล้ว ซึ่งห้ามเปลี่ยนย้อนหลัง
 * จึงบังคับให้ระบุเหตุผลได้ เพื่อให้คนถัดไปเข้าใจว่าทำไมแก้ไม่ได้
 */
export function LockDialog({ entry, onClose }: { entry: DriveEntry; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const unlocking = entry.isLocked;

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = useMutation({
    mutationFn: () =>
      unlocking ? workspaceApi.unlock(entry.id) : workspaceApi.lock(entry.id, reason.trim() || null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['drive'] });
      void queryClient.invalidateQueries({ queryKey: ['resource'] });
      void queryClient.invalidateQueries({ queryKey: ['search'] });
      notify({ tone: 'success', title: unlocking ? 'ปลดล็อกแล้ว' : 'ล็อกทรัพยากรแล้ว' });
      onClose();
    },
    onError: (reason_) =>
      setError(reason_ instanceof ApiError ? ERROR_TEXT[reason_.code] ?? reason_.message : 'ดำเนินการไม่สำเร็จ'),
  });

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-3 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="lock-dialog-title"
        className="w-full max-w-md rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop sm:p-6"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 text-amber-600">
            {unlocking ? <LockOpen className="h-5 w-5" aria-hidden /> : <Lock className="h-5 w-5" aria-hidden />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="lock-dialog-title" className="text-[16px] font-semibold text-navy-900">
              {unlocking ? 'ปลดล็อกทรัพยากร' : 'ล็อกทรัพยากร'}
            </h2>
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
            submit.mutate();
          }}
        >
          {unlocking ? (
            <div className="space-y-3">
              <div className="rounded-xl border border-line bg-[var(--s2-surface-soft)] px-3 py-3 text-[12px] leading-relaxed text-navy-600">
                {entry.lockReason ? (
                  <p>เหตุผลที่ล็อกไว้: {entry.lockReason}</p>
                ) : (
                  <p>ล็อกไว้โดยไม่ได้ระบุเหตุผล</p>
                )}
                {entry.lockedByName ? (
                  <p className="mt-1 text-[11px] text-navy-400">
                    โดย {entry.lockedByName}
                    {entry.lockedAt ? ` เมื่อ ${formatDateTime(entry.lockedAt)}` : ''}
                  </p>
                ) : null}
              </div>
              <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-[12px] leading-relaxed text-amber-700">
                ปลดล็อกแล้วผู้ที่มีสิทธิ์แก้ไขจะเปลี่ยนชื่อ ย้าย เพิ่มเวอร์ชัน และลบทรัพยากรนี้ได้อีกครั้ง
              </p>
            </div>
          ) : (
            <>
              <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-[12px] leading-relaxed text-amber-700">
                ล็อกแล้วจะเปลี่ยนชื่อ ย้าย เพิ่มเวอร์ชัน หรือลบไม่ได้ แต่ยังเปิดดูและดาวน์โหลดได้ตามสิทธิ์เดิม
              </p>
              <label className="block text-[11.5px] font-semibold text-navy-700">
                เหตุผล (แนะนำให้ระบุ)
                <textarea
                  ref={inputRef}
                  className="s2-input mt-1.5 min-h-24 rounded-xl px-3 py-2.5 text-[13px]"
                  value={reason}
                  maxLength={MAX_REASON}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="เช่น ปิดงบเดือนสิงหาคม 2568 แล้ว ห้ามแก้ย้อนหลัง"
                />
              </label>
            </>
          )}

          {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-[11.5px] text-red-700">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="s2-btn s2-btn-ghost">ยกเลิก</button>
            <button type="submit" disabled={submit.isPending} className="s2-btn s2-btn-primary">
              {submit.isPending ? 'กำลังดำเนินการ…' : unlocking ? 'ปลดล็อก' : 'ล็อกทรัพยากร'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
