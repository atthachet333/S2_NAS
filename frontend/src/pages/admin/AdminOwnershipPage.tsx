import { useQuery } from '@tanstack/react-query';
import { FolderTree, UserCog } from 'lucide-react';
import { adminApi } from '@/lib/api';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/States';
import { OwnerIdentity } from '@/components/files/OwnerIdentity';

/**
 * ภาพรวมความรับผิดชอบ
 *
 * ตอบคำถามเชิงบริหาร: ใครดูแลโฟลเดอร์อยู่กี่รายการ และงานกระจุกอยู่ที่ใคร
 * ใช้ข้อมูลจริงจาก GET /admin/ownership ซึ่งนับเฉพาะโฟลเดอร์ที่ยังไม่ถูกลบ
 */
export default function AdminOwnershipPage() {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['admin-ownership'],
    queryFn: adminApi.ownership,
  });

  const rows = data?.data ?? [];
  const totalFolders = rows.reduce((sum, row) => sum + row.ownedFolderCount, 0);
  const busiest = rows.reduce((max, row) => Math.max(max, row.ownedFolderCount), 0);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-[20px] font-semibold text-navy-900">ความรับผิดชอบทรัพยากร</h1>
        <p className="mt-1 text-[12px] text-navy-400">
          ผู้ดูแลหลักของโฟลเดอร์ทั้งหมดที่ยังใช้งานอยู่ในองค์กร
        </p>
      </header>

      {isPending ? (
        <ListSkeleton />
      ) : isError ? (
        <ErrorState message="โหลดข้อมูลความรับผิดชอบไม่สำเร็จ" onRetry={() => void refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<UserCog className="h-7 w-7" aria-hidden />}
          title="ยังไม่มีข้อมูลความรับผิดชอบ"
          description="ข้อมูลจะปรากฏเมื่อมีการสร้างโฟลเดอร์จริงในระบบ"
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:max-w-md">
            <Stat label="ผู้ดูแลทั้งหมด" value={`${rows.length} คน`} />
            <Stat label="โฟลเดอร์ที่มีผู้ดูแล" value={`${totalFolders} โฟลเดอร์`} />
          </div>

          <div className="overflow-hidden rounded-2xl border border-[var(--s2-card-border)] bg-[var(--s2-layer-card)]">
            <table className="w-full min-w-[520px] text-left">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wide text-navy-400">
                  <th scope="col" className="px-4 py-3 font-medium">
                    ผู้ใช้งาน
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    สัดส่วนที่ดูแล
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    จำนวนโฟลเดอร์ที่ดูแล
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.user.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-3">
                      <OwnerIdentity owner={row.user} caption={row.user.email} size="md" />
                    </td>
                    <td className="px-4 py-3">
                      <div
                        className="h-1.5 w-full max-w-[180px] overflow-hidden rounded-full bg-navy-100"
                        role="img"
                        aria-label={`${row.ownedFolderCount} จาก ${busiest} โฟลเดอร์สูงสุด`}
                      >
                        <div
                          className="h-full rounded-full bg-brand-500"
                          style={{ width: `${busiest > 0 ? (row.ownedFolderCount / busiest) * 100 : 0}%` }}
                        />
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-navy-800">
                        <FolderTree className="h-3.5 w-3.5 text-brand-500" aria-hidden />
                        {row.ownedFolderCount} โฟลเดอร์
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] leading-relaxed text-navy-400">
            นับเฉพาะโฟลเดอร์ที่ยังไม่ถูกย้ายไปถังขยะ การกรองทรัพยากรตามผู้ดูแลจะเปิดใช้งาน
            เมื่อ API รองรับการค้นหาด้วยเจ้าของ
          </p>
        </>
      )}
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
