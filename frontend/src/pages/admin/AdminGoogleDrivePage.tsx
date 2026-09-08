import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Plug, ShieldAlert } from 'lucide-react';
import { PageTitle } from '@/components/ui/PageTitle';
import { EmptyState } from '@/components/ui/States';
import { OwnerIdentity } from '@/components/files/OwnerIdentity';
import { ApiError, googleDriveApi } from '@/lib/api';
import { CONNECTION_STATUS } from '@/lib/google-drive';
import { formatDateTime } from '@/lib/utils';

/**
 * สุขภาพของการเชื่อมต่อ Google Drive ทั้งระบบ (F19)
 *
 * ผู้ดูแลเห็นว่าใครเชื่อมต่ออยู่ ใครต้องเชื่อมต่อใหม่ และมีการผูกไฟล์กี่รายการ
 *
 * **แต่ใช้การเชื่อมต่อของคนอื่นไม่ได้ และไม่มีข้อมูลรับรองใด ๆ ในหน้านี้**
 * การดูแลระบบคือการเห็นสถานะ ไม่ใช่การสวมรอย - พนักงานยินยอมให้ระบบอ่าน Drive
 * ของเขา ไม่ได้ยินยอมให้เพื่อนร่วมงานอ่าน
 */
export default function AdminGoogleDrivePage() {
  const overview = useQuery({
    queryKey: ['admin-drive'],
    queryFn: googleDriveApi.adminOverview,
    retry: false,
  });

  if (overview.isError && overview.error instanceof ApiError && overview.error.status === 403) {
    return (
      <div className="space-y-4">
        <PageTitle title="Google Drive" description="ภาพรวมการเชื่อมต่อ Google Drive ของทั้งองค์กร" />
        <EmptyState
          icon={<ShieldAlert className="h-6 w-6" aria-hidden />}
          title="คุณไม่มีสิทธิ์ดูภาพรวมการเชื่อมต่อ"
          description="รายการนี้ครอบคลุมทั้งองค์กร จึงจำกัดไว้เฉพาะผู้ดูแลระบบ"
        />
      </div>
    );
  }

  const data = overview.data?.data;

  return (
    <div className="space-y-4">
      <PageTitle
        title="Google Drive"
        description="ภาพรวมการเชื่อมต่อ Google Drive ของทั้งองค์กร"
      />

      {overview.isPending ? (
        <div className="flex justify-center py-16 text-navy-400">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
        </div>
      ) : !data ? (
        <EmptyState
          icon={<ShieldAlert className="h-6 w-6" aria-hidden />}
          title="โหลดข้อมูลไม่สำเร็จ"
        />
      ) : (
        <>
          {/* ---------- สถานะของระบบ ---------- */}
          {!data.configured || !data.encryptionReady ? (
            <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[12.5px] text-[var(--s2-warning-ring)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                {!data.configured
                  ? 'ยังไม่ได้ตั้งค่า OAuth client ของ Google Drive - ผู้ใช้จึงยังเชื่อมต่อไม่ได้'
                  : 'ยังไม่ได้ตั้งค่ากุญแจเข้ารหัสข้อมูลรับรอง (S2_NAS_INTEGRATION_ENCRYPTION_KEY)'}
              </span>
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2 text-[12px]">
            <Stat label="การเชื่อมต่อทั้งหมด" value={data.connections.length} />
            <Stat
              label="ต้องเชื่อมต่อใหม่"
              value={data.connections.filter((row) => row.state === 'REAUTH_REQUIRED').length}
              tone="warning"
            />
            <Stat label="การซิงก์ที่มีปัญหา" value={data.failingSyncs} tone="warning" />
            <Stat label="รอบตรวจ (วินาที)" value={data.pollSeconds} />
          </div>

          {/* ---------- รายการ ---------- */}
          {data.connections.length === 0 ? (
            <EmptyState
              icon={<Plug className="h-6 w-6" aria-hidden />}
              title="ยังไม่มีใครเชื่อมต่อ Google Drive"
              description="ผู้ใช้เชื่อมต่อบัญชีของตัวเองได้จากหน้าตั้งค่า → การเชื่อมต่อภายนอก"
            />
          ) : (
            <ul className="overflow-hidden rounded-xl border border-line">
              <li className="hidden gap-3 border-b border-line bg-[var(--s2-surface-soft)] px-3 py-2 text-[11px] font-medium text-navy-500 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_150px_90px]">
                <span>ผู้ใช้</span>
                <span>บัญชี Google</span>
                <span>สถานะ</span>
                <span>ซิงก์ล่าสุด</span>
                <span>ไฟล์ที่ผูก</span>
              </li>

              {data.connections.map((row) => {
                const style = CONNECTION_STATUS[row.state];
                return (
                  <li key={row.id} className="border-b border-line last:border-0">
                    <div className="flex flex-col gap-1.5 px-3 py-2.5 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_120px_150px_90px] lg:items-center lg:gap-3">
                      <div className="min-w-0">
                        <OwnerIdentity owner={row.user} caption={row.user.email} size="sm" />
                      </div>

                      <span className="truncate text-[12px] text-navy-600">
                        {row.googleAccountEmail}
                      </span>

                      <span
                        className={`w-fit rounded-md border px-1.5 py-0.5 text-[10.5px] ${style.className}`}
                      >
                        {style.label}
                      </span>

                      <span className="text-[11.5px] text-navy-500">
                        {row.lastSuccessfulSyncAt
                          ? formatDateTime(row.lastSuccessfulSyncAt)
                          : 'ยังไม่เคยซิงก์'}
                      </span>

                      <span className="text-[11.5px] text-navy-500">{row.syncCount} รายการ</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="text-[11.5px] leading-relaxed text-navy-400">
            หน้านี้แสดงสถานะเท่านั้น - ผู้ดูแลระบบใช้การเชื่อมต่อของผู้ใช้คนอื่นไม่ได้
            และไม่มีข้อมูลรับรองใดปรากฏที่นี่
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warning' }) {
  return (
    <span
      className={`rounded-lg border px-2.5 py-1 ${
        tone === 'warning' && value > 0
          ? 'border-amber-200 bg-amber-50 text-[var(--s2-warning-ring)]'
          : 'border-line bg-[var(--s2-surface-soft)] text-navy-600'
      }`}
    >
      {label} <span className="font-semibold">{value}</span>
    </span>
  );
}
