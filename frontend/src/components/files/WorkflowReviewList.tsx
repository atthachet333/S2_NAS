import { useQuery } from '@tanstack/react-query';
import { WORKFLOW_STATUS_LABEL, workflowApi } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { WorkflowReviewButton } from './WorkflowReviewSheet';

/**
 * คำขอความร่วมมือของโฟลเดอร์นี้ - จุดเข้าสู่การตรวจงานจากแผงรายละเอียด (F26-E)
 *
 * แสดงเฉพาะเมื่อโฟลเดอร์นี้มีคำขออยู่จริง ไม่ขึ้นหัวข้อว่างให้เกะกะกับเอกสารส่วนใหญ่
 * ที่ไม่มีงานภายนอกเกี่ยวข้องเลย
 *
 * ด่านจริงอยู่ฝั่งเซิร์ฟเวอร์ (ต้องจัดการสิทธิ์ของโฟลเดอร์ได้) การซ่อนปุ่มที่นี่เป็นเพียง
 * การไม่รบกวนสายตา ไม่ใช่การควบคุมการเข้าถึง
 */
export function WorkflowReviewList({ resourceId }: { resourceId: string }) {
  const { user } = useAuth();
  const mayReview =
    user?.roles.includes('SUPER_ADMIN') ||
    user?.roles.includes('ADMIN') ||
    user?.permissions.includes('resources:share') ||
    false;

  const workflows = useQuery({
    queryKey: ['workflows', resourceId],
    queryFn: () => workflowApi.list({ targetResourceId: resourceId }),
    enabled: mayReview,
    retry: false,
  });

  const items = workflows.data?.data ?? [];
  if (!mayReview || items.length === 0) return null;

  return (
    <section className="mt-2.5 border-t border-line pt-2.5">
      <h3 className="text-[11px] font-semibold text-navy-700">คำขอความร่วมมือภายนอก</h3>
      <ul className="mt-1.5 space-y-2">
        {items.map((workflow) => (
          <li key={workflow.id} className="rounded-lg border border-line p-2.5">
            <p className="truncate text-[11.5px] font-medium text-navy-800">{workflow.title}</p>
            <p className="mt-0.5 text-[10.5px] text-navy-400">
              {workflow.assignee.organizationName ?? workflow.assignee.displayName} ·{' '}
              {WORKFLOW_STATUS_LABEL[workflow.status]}
              {workflow.submissions.length > 0 ? ` · ส่งแล้ว ${workflow.submissions.length} ฉบับ` : ''}
            </p>
            <div className="mt-1.5">
              <WorkflowReviewButton workflowId={workflow.id} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
