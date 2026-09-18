import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarClock, CheckCircle2, FileText, Loader2, Upload, WifiOff } from 'lucide-react';
import { ApiError, portalWorkflowApi } from '@/lib/api';
import { ErrorState, TextSkeleton } from '@/components/ui/States';
import { useConnectivity } from '@/hooks/useConnectivity';
import { useToast } from '@/hooks/useToast';
import { thaiDate } from '@/lib/lifecycle';
import { WorkflowStatusBadge } from './PortalWorkflowsPage';

/**
 * รายละเอียดงานที่ได้รับมอบหมาย และการส่งไฟล์ (F26-C/D)
 *
 * **หน้าจอไม่ตัดสินใจแทนเซิร์ฟเวอร์** ปุ่มส่งไฟล์ปรากฏตาม `canSubmit` ที่เซิร์ฟเวอร์
 * คำนวณมาให้ ไม่ใช่จากการตีความสถานะเองที่นี่ ถ้าหน้าจอตีความเอง วันที่กติกาเปลี่ยน
 * มันจะเสนอปุ่มที่กดแล้วถูกปฏิเสธ หรือซ่อนปุ่มที่ควรกดได้
 *
 * **ไม่มีคิวส่งซ้ำอัตโนมัติ** ตามหลักที่ตั้งไว้ตั้งแต่ F24: ไฟล์ที่ค้างอยู่ในหน้าเว็บจะหายไป
 * เมื่อปิดแท็บ การสัญญาว่าจะส่งให้ทีหลังเป็นสัญญาที่รักษาไม่ได้ ออฟไลน์จึงปฏิเสธตรง ๆ
 */

const ERROR_TEXT: Record<string, string> = {
  WORKFLOW_NOT_FOUND: 'ไม่พบงานนี้ หรืองานนี้ไม่ได้มอบหมายให้คุณแล้ว',
  WORKFLOW_NOT_SUBMITTABLE: 'งานนี้ส่งไฟล์เพิ่มไม่ได้ในสถานะปัจจุบัน',
  WORKFLOW_UPLOAD_NOT_ALLOWED: 'งานนี้ไม่ได้เปิดให้ส่งไฟล์',
  WORKFLOW_ALREADY_SUBMITTED: 'งานนี้ถูกส่งไปแล้ว',
  WORKFLOW_INVALID_TRANSITION: 'สถานะของงานเปลี่ยนไปแล้ว กรุณาโหลดหน้าใหม่',
  WORKFLOW_DESTINATION_NOT_ACCEPTED: 'ปลายทางของการส่งงานกำหนดโดยระบบ',
  FILE_TOO_LARGE: 'ไฟล์ใหญ่เกินกว่าที่ระบบรับได้',
  FILE_TYPE_NOT_ALLOWED: 'ระบบไม่รองรับไฟล์ชนิดนี้',
};

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? (ERROR_TEXT[error.code] ?? error.message ?? fallback) : fallback;

export default function PortalWorkflowDetailPage() {
  const { workflowId = '' } = useParams();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const { online } = useConnectivity();
  const fileInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<File | null>(null);

  const workflow = useQuery({
    queryKey: ['portal-workflow', workflowId],
    queryFn: () => portalWorkflowApi.get(workflowId),
    enabled: workflowId.length > 0,
    retry: false,
  });

  const submit = useMutation({
    mutationFn: (file: File) => portalWorkflowApi.submit(workflowId, file),
    onSuccess: () => {
      setSelected(null);
      if (fileInput.current) fileInput.current.value = '';
      void queryClient.invalidateQueries({ queryKey: ['portal-workflow', workflowId] });
      void queryClient.invalidateQueries({ queryKey: ['portal-workflows'] });
      notify({ tone: 'success', title: 'ส่งไฟล์เรียบร้อยแล้ว' });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'ส่งไฟล์ไม่สำเร็จ') }),
  });

  const data = workflow.data?.data;

  return (
    <section className="pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <Link
        to="/portal/workflows"
        className="inline-flex min-h-11 items-center gap-1.5 text-[12.5px] text-navy-500 hover:text-navy-800"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        งานที่ได้รับมอบหมาย
      </Link>

      {workflow.isPending ? (
        <div className="mt-4"><TextSkeleton lines={5} /></div>
      ) : workflow.isError ? (
        <ErrorState
          title="ไม่พบงานนี้"
          message={message(workflow.error, 'งานนี้อาจถูกยกเลิก หมดเวลา หรือไม่ได้มอบหมายให้คุณ')}
        />
      ) : data ? (
        <>
          <header className="mt-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h1 className="min-w-0 flex-1 text-[17px] font-semibold text-navy-900">{data.title}</h1>
              <WorkflowStatusBadge status={data.status} />
            </div>
            <p className="mt-1 text-[12px] text-navy-400">ปลายทาง: {data.target.name}</p>
          </header>

          {/*
            ผลการตัดสินล่าสุดที่ถึงตัวผู้รับงาน - ขอให้แก้ไข ไม่อนุมัติ หรือยกเลิก
            แสดงเหนือคำชี้แจงเดิม เพราะมันคือสิ่งที่ต้องอ่านก่อนในรอบนี้
          */}
          {data.latestDecision ? (
            <div
              className={`mt-3 rounded-xl border p-3.5 ${
                data.latestDecision.status === 'REVISION_REQUESTED'
                  ? 'border-amber-200 bg-amber-50'
                  : 'border-rose-200 bg-rose-50'
              }`}
            >
              <h2 className="text-[12px] font-semibold text-navy-800">
                {data.latestDecision.status === 'REVISION_REQUESTED'
                  ? 'เจ้าหน้าที่ขอให้แก้ไข'
                  : data.latestDecision.status === 'REJECTED'
                    ? 'งานนี้ไม่ได้รับอนุมัติ'
                    : 'งานนี้ถูกยกเลิก'}
              </h2>
              {data.latestDecision.reason ? (
                <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-navy-700">
                  {data.latestDecision.reason}
                </p>
              ) : null}
            </div>
          ) : null}

          {data.instructions ? (
            <div className="mt-3 rounded-xl border border-line bg-[var(--s2-surface-soft)] p-3.5">
              <h2 className="text-[12px] font-semibold text-navy-700">คำชี้แจง</h2>
              <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-navy-600">
                {data.instructions}
              </p>
            </div>
          ) : null}

          <dl className="mt-3 space-y-1.5 text-[12px]">
            {data.dueAt ? (
              <div className="flex items-center justify-between gap-2">
                <dt className="inline-flex items-center gap-1 text-navy-400">
                  <CalendarClock className="h-3.5 w-3.5" aria-hidden />
                  กำหนดส่ง
                </dt>
                <dd className="text-navy-700">{thaiDate(data.dueAt)}</dd>
              </div>
            ) : null}
            {data.expiresAt ? (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-navy-400">เปิดให้ส่งถึง</dt>
                <dd className="text-navy-700">{thaiDate(data.expiresAt)}</dd>
              </div>
            ) : null}
          </dl>

          {/* ---- ไฟล์ที่ส่งไปแล้ว ---- */}
          <section className="mt-5">
            <h2 className="text-[13px] font-semibold text-navy-800">ไฟล์ที่ส่งแล้ว</h2>
            {data.submissions.length > 0 ? (
              <ul className="mt-2 space-y-1.5">
                {data.submissions.map((submission) => (
                  <li
                    key={submission.id}
                    className="flex items-center gap-2 rounded-lg border border-line px-3 py-2.5 text-[12px]"
                  >
                    <FileText className="h-4 w-4 shrink-0 text-navy-400" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-navy-700">
                      ฉบับที่ {submission.sequence} · {submission.file.name}
                    </span>
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 text-[12px] text-navy-400">ยังไม่ได้ส่งไฟล์</p>
            )}
          </section>

          {/* ---- ส่งไฟล์ ---- */}
          {data.canSubmit ? (
            <section className="mt-5 rounded-xl border border-line p-3.5">
              <h2 className="text-[13px] font-semibold text-navy-800">
                {data.status === 'REVISION_REQUESTED' ? 'ส่งฉบับแก้ไข' : 'ส่งไฟล์'}
              </h2>
              <p className="mt-0.5 text-[11.5px] text-navy-400">
                {data.status === 'REVISION_REQUESTED'
                  ? 'ไฟล์ที่ส่งไปแล้วยังถูกเก็บไว้ ฉบับใหม่จะถูกเพิ่มเข้าไปเป็นอีกฉบับหนึ่ง'
                  : 'ระบบจะนำไฟล์เข้าโฟลเดอร์ของงานนี้ให้โดยอัตโนมัติ'}
              </p>

              {!online ? (
                <p className="mt-2 flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11.5px] text-amber-800">
                  <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  ต้องเชื่อมต่ออินเทอร์เน็ตเพื่อส่งไฟล์ ระบบจะไม่ส่งให้อัตโนมัติภายหลัง
                </p>
              ) : null}

              <input
                ref={fileInput}
                type="file"
                className="sr-only"
                onChange={(event) => setSelected(event.target.files?.[0] ?? null)}
              />

              <div className="mt-2.5 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  disabled={submit.isPending}
                  className="s2-btn s2-btn-outline min-h-11 flex-1 gap-1.5 text-[12.5px] disabled:opacity-60"
                >
                  <Upload className="h-4 w-4" aria-hidden />
                  {selected ? 'เปลี่ยนไฟล์' : 'เลือกไฟล์'}
                </button>
                <button
                  type="button"
                  onClick={() => selected && submit.mutate(selected)}
                  disabled={!selected || !online || submit.isPending}
                  className="s2-btn s2-btn-primary min-h-11 flex-1 gap-1.5 text-[12.5px] disabled:opacity-60"
                >
                  {submit.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      กำลังส่ง
                    </>
                  ) : data.status === 'REVISION_REQUESTED' ? (
                    'ส่งฉบับแก้ไข'
                  ) : (
                    'ส่งไฟล์'
                  )}
                </button>
              </div>

              {selected ? (
                <p className="mt-2 truncate text-[11.5px] text-navy-500">เลือกไว้: {selected.name}</p>
              ) : null}
            </section>
          ) : (
            <p className="mt-5 rounded-xl border border-line bg-[var(--s2-surface-soft)] px-3.5 py-3 text-[12px] text-navy-500">
              {data.permissions.allowUpload
                ? 'งานนี้ส่งไฟล์เพิ่มไม่ได้ในสถานะปัจจุบัน'
                : 'งานนี้ไม่ได้เปิดให้ส่งไฟล์'}
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}
