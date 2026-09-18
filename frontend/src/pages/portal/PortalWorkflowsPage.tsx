import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, ClipboardList, Upload } from 'lucide-react';
import {
  WORKFLOW_STATUS_LABEL,
  portalWorkflowApi,
  type AssignedWorkflowDto,
  type WorkflowStatus,
} from '@/lib/api';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/States';
import { thaiDate } from '@/lib/lifecycle';

/**
 * งานที่ได้รับมอบหมาย - หน้ารายการของผู้รับงานภายนอก (F26-C)
 *
 * **ไม่มีการนำทางไปที่อื่นของ NAS เลย** หน้านี้แสดงเฉพาะงานที่มอบหมายให้ผู้ใช้คนนี้
 * ซึ่งเซิร์ฟเวอร์กรองมาจาก token ไม่ใช่จากพารามิเตอร์ใด ๆ ที่หน้าจอส่งไป
 *
 * งานที่โฟลเดอร์ปลายทางถูกปิดไปแล้วจะไม่อยู่ในคำตอบตั้งแต่ต้น - หน้าจอไม่ต้องกรองเอง
 * และไม่มีทางแสดงชื่อเอกสารที่ผู้ใช้ไม่ควรเห็น
 */

/**
 * สีของสถานะ - ใช้ทั้งสีและข้อความเสมอ ไม่พึ่งสีอย่างเดียว
 * ผู้ใช้ที่แยกสีไม่ได้ต้องรู้ว่างานหมดเวลาแล้วเช่นกัน
 */
const STATUS_TONE: Record<WorkflowStatus, string> = {
  OPEN: 'border-brand-200 bg-brand-50 text-brand-700',
  SUBMITTED: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  UNDER_REVIEW: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  REVISION_REQUESTED: 'border-amber-200 bg-amber-50 text-amber-800',
  APPROVED: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  REJECTED: 'border-rose-200 bg-rose-50 text-rose-700',
  REVOKED: 'border-navy-200 bg-navy-50 text-navy-600',
  EXPIRED: 'border-navy-200 bg-navy-50 text-navy-600',
};

export function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
  return (
    <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium ${STATUS_TONE[status]}`}>
      {WORKFLOW_STATUS_LABEL[status]}
    </span>
  );
}

function WorkflowCard({ workflow }: { workflow: AssignedWorkflowDto }) {
  return (
    <li>
      {/*
        การ์ดทั้งใบเป็นเป้ากด ไม่ใช่ลิงก์เล็ก ๆ ในนั้น - บนมือถือเป้าที่เล็กกว่านิ้ว
        คือเป้าที่กดพลาด และไม่มีการกระทำใดในหน้านี้ที่ซ่อนอยู่หลัง hover
      */}
      <Link
        to={`/portal/workflows/${workflow.id}`}
        className="block min-h-11 rounded-xl border border-line bg-[var(--s2-surface)] p-3.5 transition-colors hover:border-brand-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
      >
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 flex-1 text-[13px] font-semibold text-navy-800">{workflow.title}</p>
          <WorkflowStatusBadge status={workflow.status} />
        </div>

        <p className="mt-1 truncate text-[11.5px] text-navy-500">
          ปลายทาง: {workflow.target.name}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-navy-400">
          {workflow.dueAt ? (
            <span className="inline-flex items-center gap-1">
              <CalendarClock className="h-3 w-3" aria-hidden />
              กำหนดส่ง {thaiDate(workflow.dueAt)}
            </span>
          ) : null}
          {workflow.permissions.allowUpload ? (
            <span className="inline-flex items-center gap-1">
              <Upload className="h-3 w-3" aria-hidden />
              ส่งไฟล์ได้
            </span>
          ) : null}
          {workflow.submissionCount > 0 ? <span>ส่งแล้ว {workflow.submissionCount} ไฟล์</span> : null}
        </div>
      </Link>
    </li>
  );
}

export default function PortalWorkflowsPage() {
  const workflows = useQuery({
    queryKey: ['portal-workflows'],
    queryFn: () => portalWorkflowApi.list(),
  });

  return (
    <section>
      <h1 className="text-[17px] font-semibold text-navy-900">งานที่ได้รับมอบหมาย</h1>
      <p className="mt-0.5 text-[12px] text-navy-400">
        รายการนี้แสดงเฉพาะงานที่มอบหมายให้คุณเท่านั้น
      </p>

      <div className="mt-4">
        {workflows.isPending ? (
          <ListSkeleton rows={4} />
        ) : workflows.isError ? (
          <ErrorState
            title="โหลดรายการงานไม่สำเร็จ"
            message="กรุณาลองใหม่อีกครั้ง หากยังไม่ได้ กรุณาติดต่อผู้ดูแลของบริษัท"
            onRetry={() => void workflows.refetch()}
          />
        ) : workflows.data && workflows.data.data.length > 0 ? (
          <ul className="space-y-2.5">
            {workflows.data.data.map((workflow) => (
              <WorkflowCard key={workflow.id} workflow={workflow} />
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<ClipboardList className="h-7 w-7" aria-hidden />}
            title="ยังไม่มีงานที่ได้รับมอบหมาย"
            description="เมื่อเจ้าหน้าที่มอบหมายงานให้คุณ รายการจะปรากฏที่นี่"
          />
        )}
      </div>
    </section>
  );
}
