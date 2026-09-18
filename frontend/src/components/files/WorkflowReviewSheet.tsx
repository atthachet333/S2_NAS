import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, FileText, Loader2 } from 'lucide-react';
import {
  ApiError,
  WORKFLOW_HISTORY_LABEL,
  WORKFLOW_STATUS_LABEL,
  workflowApi,
  workflowReviewApi,
  type WorkflowStatus,
} from '@/lib/api';
import { Sheet } from '@/components/ui/Sheet';
import { TextSkeleton } from '@/components/ui/States';
import { useToast } from '@/hooks/useToast';
import { thaiDate } from '@/lib/lifecycle';

/**
 * การตรวจงานที่ลูกค้าส่งมา - แผงของเจ้าหน้าที่ภายใน (F26-E/G)
 *
 * **หน้าจอไม่ตัดสินใจแทนเซิร์ฟเวอร์** ปุ่มที่แสดงมาจากสถานะที่เซิร์ฟเวอร์ส่งมา และทุกปุ่ม
 * ส่ง submissionId ที่กำลังดูอยู่ไปด้วย เพื่อให้เซิร์ฟเวอร์ปฏิเสธได้ถ้ามีฉบับใหม่เข้ามาแล้ว
 * ผู้ตรวจจึงไม่มีทางอนุมัติสิ่งที่ตัวเองไม่เคยเห็น
 *
 * ใช้ Sheet ตัวเดียวกับส่วนอื่นของระบบ ซึ่งเป็นแผงเต็มจอบนมือถือและแผงข้างบนจอกว้าง
 */

const MIN_REASON = 10;

const ERROR_TEXT: Record<string, string> = {
  WORKFLOW_REASON_REQUIRED: `ต้องระบุเหตุผลอย่างน้อย ${MIN_REASON} ตัวอักษร`,
  WORKFLOW_REVIEW_STALE: 'ลูกค้าส่งฉบับใหม่เข้ามาแล้ว กรุณาโหลดใหม่ก่อนตัดสิน',
  WORKFLOW_STATE_CONFLICT: 'สถานะถูกเปลี่ยนโดยผู้อื่นไปแล้ว กรุณาโหลดใหม่',
  WORKFLOW_INVALID_TRANSITION: 'สถานะปัจจุบันทำรายการนี้ไม่ได้',
  WORKFLOW_EXPIRED: 'คำขอนี้หมดอายุแล้ว',
  WORKFLOW_REVIEW_DENIED: 'คุณไม่มีสิทธิ์ตรวจงานนี้',
  SHARE_DENIED: 'คุณไม่มีสิทธิ์จัดการโฟลเดอร์ปลายทางของงานนี้',
};

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? (ERROR_TEXT[error.code] ?? error.message ?? fallback) : fallback;

/** การกระทำที่ทำได้ในแต่ละสถานะ - สะท้อนตารางการเปลี่ยนสถานะฝั่งเซิร์ฟเวอร์ */
function actionsFor(status: WorkflowStatus) {
  return {
    canStart: status === 'SUBMITTED',
    canDecide: status === 'SUBMITTED' || status === 'UNDER_REVIEW',
    canRevoke: status === 'OPEN' || status === 'SUBMITTED' || status === 'UNDER_REVIEW' || status === 'REVISION_REQUESTED',
  };
}

export function WorkflowReviewButton({ workflowId }: { workflowId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const queryClient = useQueryClient();
  const { notify } = useToast();

  const workflow = useQuery({
    queryKey: ['workflow', workflowId],
    queryFn: () => workflowApi.get(workflowId),
    enabled: open,
    retry: false,
  });
  const history = useQuery({
    queryKey: ['workflow-history', workflowId],
    queryFn: () => workflowReviewApi.history(workflowId),
    enabled: open,
    retry: false,
  });

  const data = workflow.data?.data;
  const submissions = data?.submissions ?? [];
  const current = submissions.length > 0 ? submissions[submissions.length - 1]! : null;

  const refresh = () => {
    setReason('');
    void queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });
    void queryClient.invalidateQueries({ queryKey: ['workflow-history', workflowId] });
    void queryClient.invalidateQueries({ queryKey: ['workflows'] });
  };

  const act = useMutation({
    mutationFn: (kind: 'start' | 'approve' | 'reject' | 'revision' | 'revoke') => {
      const submissionId = current?.id ?? null;
      const trimmed = reason.trim();
      if (kind === 'start') return workflowReviewApi.start(workflowId);
      if (kind === 'approve') return workflowReviewApi.approve(workflowId, { reason: trimmed || null, submissionId });
      if (kind === 'reject') return workflowReviewApi.reject(workflowId, { reason: trimmed, submissionId });
      if (kind === 'revision') return workflowReviewApi.requestRevision(workflowId, { reason: trimmed, submissionId });
      return workflowReviewApi.revoke(workflowId, { reason: trimmed });
    },
    onSuccess: () => {
      refresh();
      notify({ tone: 'success', title: 'บันทึกผลการตรวจแล้ว' });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'ดำเนินการไม่สำเร็จ') }),
  });

  const actions = data ? actionsFor(data.status) : { canStart: false, canDecide: false, canRevoke: false };
  const reasonTooShort = reason.trim().length < MIN_REASON;
  const busy = act.isPending;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="s2-btn s2-btn-outline min-h-11 w-full gap-1.5 text-[12px]"
      >
        <ClipboardCheck className="h-3.5 w-3.5" aria-hidden />
        ตรวจงานที่ลูกค้าส่ง
      </button>

      <Sheet open={open} title="ตรวจงานของลูกค้า" onClose={() => setOpen(false)}>
        {workflow.isPending ? (
          <TextSkeleton lines={5} />
        ) : data ? (
          <div className="space-y-4 p-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            <header>
              <p className="text-[13.5px] font-semibold text-navy-800">{data.title}</p>
              <p className="mt-0.5 text-[11.5px] text-navy-400">
                สถานะ: {WORKFLOW_STATUS_LABEL[data.status]}
                {data.dueAt ? ` · กำหนดส่ง ${thaiDate(data.dueAt)}` : ''}
              </p>
            </header>

            <section>
              <h3 className="text-[12px] font-semibold text-navy-700">ไฟล์ที่ส่งมา</h3>
              {submissions.length > 0 ? (
                <ul className="mt-1.5 space-y-1.5">
                  {submissions.map((submission) => (
                    <li
                      key={submission.id}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-[11.5px] ${
                        submission.id === current?.id ? 'border-brand-200 bg-brand-50' : 'border-line'
                      }`}
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0 text-navy-400" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-navy-700">
                        ฉบับที่ {submission.sequence} · {submission.file.name}
                      </span>
                      {submission.id === current?.id ? (
                        <span className="shrink-0 text-[10px] font-medium text-brand-700">ฉบับล่าสุด</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-[11.5px] text-navy-400">ลูกค้ายังไม่ได้ส่งไฟล์</p>
              )}
            </section>

            {actions.canDecide || actions.canRevoke ? (
              <section>
                <label className="block">
                  <span className="text-[11px] text-navy-400">
                    เหตุผล (บังคับเมื่อไม่อนุมัติ ขอให้แก้ไข หรือยกเลิก)
                  </span>
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={500}
                    rows={3}
                    className="s2-input mt-1 w-full text-[12px]"
                    placeholder="อธิบายให้ลูกค้าเข้าใจว่าต้องแก้อะไร หรือทำไมจึงไม่อนุมัติ"
                  />
                </label>
              </section>
            ) : null}

            {/* ปุ่มเรียงตามลำดับที่ใช้จริง และทุกปุ่มเป็นเป้ากดขนาดเต็มบนมือถือ */}
            <section className="flex flex-col gap-2">
              {actions.canStart ? (
                <button
                  type="button" disabled={busy} onClick={() => act.mutate('start')}
                  className="s2-btn s2-btn-outline min-h-11 w-full text-[12.5px] disabled:opacity-60"
                >
                  เริ่มตรวจ
                </button>
              ) : null}
              {actions.canDecide ? (
                <>
                  <button
                    type="button" disabled={busy} onClick={() => act.mutate('approve')}
                    className="s2-btn s2-btn-primary min-h-11 w-full text-[12.5px] disabled:opacity-60"
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : 'อนุมัติ'}
                  </button>
                  <button
                    type="button" disabled={busy || reasonTooShort} onClick={() => act.mutate('revision')}
                    className="s2-btn s2-btn-outline min-h-11 w-full text-[12.5px] disabled:opacity-60"
                  >
                    ขอให้แก้ไข
                  </button>
                  <button
                    type="button" disabled={busy || reasonTooShort} onClick={() => act.mutate('reject')}
                    className="s2-btn s2-btn-outline min-h-11 w-full text-[12.5px] text-rose-700 disabled:opacity-60"
                  >
                    ไม่อนุมัติ
                  </button>
                </>
              ) : null}
              {actions.canRevoke ? (
                <button
                  type="button" disabled={busy || reasonTooShort} onClick={() => act.mutate('revoke')}
                  className="s2-btn s2-btn-ghost min-h-11 w-full text-[12.5px] text-rose-700 disabled:opacity-60"
                >
                  ยกเลิกคำขอ
                </button>
              ) : null}
            </section>

            <section>
              <h3 className="text-[12px] font-semibold text-navy-700">ลำดับเหตุการณ์</h3>
              {history.data ? (
                <ol className="mt-1.5 space-y-1.5">
                  {history.data.data.map((entry, index) => (
                    <li key={`${entry.action}-${index}`} className="text-[11px] text-navy-500">
                      <span className="text-navy-700">{WORKFLOW_HISTORY_LABEL[entry.action] ?? entry.action}</span>
                      {entry.actor ? ` · ${entry.actor.displayName}` : ''}
                      {entry.reason ? <span className="block text-navy-400">เหตุผล: {entry.reason}</span> : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-1 text-[11px] text-navy-400">กำลังโหลด</p>
              )}
            </section>
          </div>
        ) : (
          <p className="p-3 text-[12px] text-navy-500">ไม่พบคำขอ หรือคุณไม่มีสิทธิ์ตรวจงานนี้</p>
        )}
      </Sheet>
    </>
  );
}
