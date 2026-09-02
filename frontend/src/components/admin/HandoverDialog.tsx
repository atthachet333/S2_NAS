import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, UserRoundCog, X } from 'lucide-react';
import { ApiError, usersApi, workspaceApi, type HandoverRow } from '@/lib/api';
import { OwnerIdentity } from '@/components/files/OwnerIdentity';
import { useToast } from '@/hooks/useToast';

const ERROR_TEXT: Record<string, string> = {
  HANDOVER_SAME_USER: 'ผู้โอนและผู้รับต้องเป็นคนละคน',
  HANDOVER_TARGET_INACTIVE: 'ผู้รับต้องเป็นผู้ใช้ที่เปิดใช้งานอยู่',
  USER_NOT_FOUND: 'ไม่พบผู้ใช้ที่เลือก',
};

/**
 * ส่งมอบความรับผิดชอบทั้งชุด
 *
 * บังคับให้ดูตัวอย่างก่อนเสมอ เพราะการโอนแตะทรัพยากรจำนวนมากในครั้งเดียว
 * และไม่มีปุ่มย้อนกลับอัตโนมัติ ผู้ดูแลต้องเห็นก่อนว่ากำลังจะย้ายอะไรไปให้ใคร
 */
export function HandoverDialog({ from, onClose }: { from: HandoverRow; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [toUserId, setToUserId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const users = useQuery({ queryKey: ['users'], queryFn: () => usersApi.list({ limit: 100 }) });

  const preview = useQuery({
    queryKey: ['handover-preview', from.user.id, toUserId],
    queryFn: () => workspaceApi.handoverPreview(from.user.id, toUserId),
    enabled: Boolean(toUserId),
    retry: false,
  });

  const transfer = useMutation({
    mutationFn: () => workspaceApi.handoverTransfer(from.user.id, toUserId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['handover-overview'] });
      void queryClient.invalidateQueries({ queryKey: ['drive'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-ownership'] });
      notify({
        tone: 'success',
        title: `ส่งมอบ ${result.data.transferred} รายการให้ ${result.data.to.displayName} แล้ว`,
      });
      onClose();
    },
    onError: (reason) =>
      setError(reason instanceof ApiError ? ERROR_TEXT[reason.code] ?? reason.message : 'ส่งมอบไม่สำเร็จ'),
  });

  // ผู้รับต้องเป็นบัญชีที่ใช้งานได้จริง และไม่ใช่คนเดิม
  const candidates = (users.data?.data.items ?? []).filter(
    (user) => user.id !== from.user.id && user.status === 'ACTIVE',
  );

  const previewError =
    preview.error instanceof ApiError ? ERROR_TEXT[preview.error.code] ?? preview.error.message : null;

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-3 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="handover-title"
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop sm:p-6"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
            <UserRoundCog className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="handover-title" className="text-[16px] font-semibold text-navy-900">ส่งมอบความรับผิดชอบ</h2>
            <p className="mt-1 truncate text-[11px] text-navy-400">
              จาก {from.user.displayName} · {from.ownedTotal} รายการ
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="ปิด" className="rounded-lg p-1.5 text-navy-400 hover:bg-navy-50">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <label className="block text-[11.5px] font-semibold text-navy-700">
            ส่งมอบให้
            <select
              className="s2-input mt-1.5 h-11 rounded-xl px-3 text-[13px]"
              value={toUserId}
              onChange={(event) => {
                setToUserId(event.target.value);
                setError(null);
              }}
            >
              <option value="">เลือกผู้รับผิดชอบคนใหม่</option>
              {candidates.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName} — {user.email}
                </option>
              ))}
            </select>
          </label>

          {toUserId ? (
            preview.isPending ? (
              <p className="text-[11.5px] text-navy-400">กำลังเตรียมตัวอย่าง…</p>
            ) : previewError ? (
              <p className="rounded-xl bg-red-50 px-3 py-2 text-[11.5px] text-red-700">{previewError}</p>
            ) : preview.data ? (
              <div className="space-y-3 rounded-xl border border-line bg-[var(--s2-surface-soft)] px-3 py-3">
                <div className="flex items-center gap-2 text-[12px] text-navy-700">
                  <OwnerIdentity owner={preview.data.data.from} size="sm" />
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-navy-400" aria-hidden />
                  <OwnerIdentity owner={preview.data.data.to} size="sm" />
                </div>

                <p className="text-[12px] font-semibold text-navy-800">
                  จะโอนทั้งหมด {preview.data.data.total} รายการ
                </p>

                <ul className="max-h-40 space-y-1 overflow-y-auto">
                  {preview.data.data.sample.map((item) => (
                    <li key={item.id} className="truncate text-[11.5px] text-navy-500">
                      {item.type === 'FOLDER' ? '📁' : '📄'} {item.name}
                      {item.isLocked ? <span className="ml-1 text-[10px] text-amber-600">(ล็อกไว้)</span> : null}
                    </li>
                  ))}
                </ul>
                {preview.data.data.truncated ? (
                  <p className="text-[10.5px] text-navy-400">
                    แสดงตัวอย่าง {preview.data.data.sample.length} รายการแรกจากทั้งหมด
                  </p>
                ) : null}

                <p className="text-[11px] leading-relaxed text-navy-400">
                  การส่งมอบเปลี่ยนเฉพาะผู้ดูแลหลัก ประวัติผู้สร้างและผู้อัปโหลดเดิมยังคงอยู่
                  และทรัพยากรที่ถูกล็อกไว้จะยังล็อกอยู่เหมือนเดิม
                </p>
              </div>
            ) : null
          ) : null}

          {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-[11.5px] text-red-700">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="s2-btn s2-btn-ghost">ยกเลิก</button>
            <button
              type="button"
              className="s2-btn s2-btn-primary"
              disabled={!toUserId || !preview.data || transfer.isPending}
              onClick={() => transfer.mutate()}
            >
              {transfer.isPending ? 'กำลังส่งมอบ…' : 'ยืนยันการส่งมอบ'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
