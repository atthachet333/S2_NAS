import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, FolderTree, UserCog } from 'lucide-react';
import { workspaceApi, type HandoverRow } from '@/lib/api';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/States';
import { OwnerIdentity } from '@/components/files/OwnerIdentity';
import { HandoverDialog } from '@/components/admin/HandoverDialog';

/**
 * ความรับผิดชอบทรัพยากรและการส่งมอบ
 *
 * ตอบคำถามเชิงบริหารสองข้อ: ใครดูแลอะไรอยู่บ้าง และถ้าคนนั้นออกจะส่งต่อให้ใคร
 * ทรัพยากรทุกชิ้นเป็นขององค์กร บัญชีที่ปิดไปแล้วแต่ยังถือของอยู่จึงถูกเน้นให้เห็นชัด
 */
export default function AdminOwnershipPage() {
  const [handover, setHandover] = useState<HandoverRow | null>(null);

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['handover-overview'],
    queryFn: workspaceApi.handoverOverview,
  });

  const rows = data?.data ?? [];
  const totalResources = rows.reduce((sum, row) => sum + row.ownedTotal, 0);
  const busiest = rows.reduce((max, row) => Math.max(max, row.ownedTotal), 0);
  const pendingHandover = rows.filter((row) => row.needsHandover);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-[20px] font-semibold text-navy-900">ความรับผิดชอบทรัพยากร</h1>
        <p className="mt-1 text-[12px] text-navy-400">
          ผู้ดูแลหลักของทรัพยากรทั้งหมดที่ยังใช้งานอยู่ พร้อมการส่งมอบเมื่อมีการเปลี่ยนหน้าที่
        </p>
      </header>

      {isPending ? (
        <ListSkeleton />
      ) : isError ? (
        <ErrorState title="โหลดข้อมูลความรับผิดชอบไม่สำเร็จ" onRetry={() => void refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<UserCog className="h-7 w-7" aria-hidden />}
          title="ยังไม่มีข้อมูลความรับผิดชอบ"
          description="ข้อมูลจะปรากฏเมื่อมีการสร้างโฟลเดอร์หรืออัปโหลดไฟล์จริงในระบบ"
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:max-w-md">
            <Stat label="ผู้ดูแลทั้งหมด" value={`${rows.length} คน`} />
            <Stat label="ทรัพยากรที่มีผู้ดูแล" value={`${totalResources} รายการ`} />
          </div>

          {pendingHandover.length > 0 ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
              <p className="text-[12px] leading-relaxed text-amber-700">
                มี {pendingHandover.length} บัญชีที่ปิดการใช้งานแล้วแต่ยังเป็นผู้ดูแลทรัพยากรอยู่
                ควรส่งมอบให้ผู้รับผิดชอบคนใหม่ เพื่อไม่ให้เอกสารค้างอยู่กับบัญชีที่เข้าใช้งานไม่ได้
              </p>
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-2xl border border-[var(--s2-card-border)] bg-[var(--s2-layer-card)]">
            <table className="w-full min-w-[680px] text-left">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wide text-navy-400">
                  <th scope="col" className="px-4 py-3 font-medium">ผู้ใช้งาน</th>
                  <th scope="col" className="px-4 py-3 font-medium">สัดส่วนที่ดูแล</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">ทรัพยากรที่ดูแล</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">การส่งมอบ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.user.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-3">
                      <OwnerIdentity owner={row.user} caption={row.user.email} size="md" />
                      {row.needsHandover ? (
                        <span className="mt-1 inline-block rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
                          บัญชีปิดใช้งานแต่ยังถือทรัพยากร
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <div
                        className="h-1.5 w-full max-w-[180px] overflow-hidden rounded-full bg-navy-100"
                        role="img"
                        aria-label={`${row.ownedTotal} จาก ${busiest} รายการสูงสุด`}
                      >
                        <div
                          className="h-full rounded-full bg-brand-500"
                          style={{ width: `${busiest > 0 ? (row.ownedTotal / busiest) * 100 : 0}%` }}
                        />
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-navy-800">
                        <FolderTree className="h-3.5 w-3.5 text-brand-500" aria-hidden />
                        {row.ownedTotal} รายการ
                      </span>
                      <span className="mt-0.5 block text-[10.5px] text-navy-400">
                        {row.ownedFolders} โฟลเดอร์ · {row.ownedFiles} ไฟล์
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <button
                        type="button"
                        className="s2-btn s2-btn-outline"
                        disabled={row.ownedTotal === 0}
                        onClick={() => setHandover(row)}
                      >
                        ส่งมอบทั้งหมด
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] leading-relaxed text-navy-400">
            นับเฉพาะทรัพยากรที่ยังไม่ถูกย้ายไปถังขยะ การส่งมอบเปลี่ยนเฉพาะผู้ดูแลหลัก
            ประวัติผู้สร้างและผู้อัปโหลดเดิมยังคงอยู่ตามเดิม
          </p>
        </>
      )}

      {handover ? <HandoverDialog from={handover} onClose={() => setHandover(null)} /> : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[var(--s2-card-border)] bg-[var(--s2-layer-card)] px-4 py-3">
      <p className="s2-section-title">{label}</p>
      <p className="mt-1 text-[16px] font-semibold text-navy-900">{value}</p>
    </div>
  );
}
