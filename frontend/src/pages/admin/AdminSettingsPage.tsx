import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Panel, PanelBody, PanelHeader, Badge } from '@/components/ui/Panel';
import { ErrorState, TextSkeleton } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';
import { formatUptime } from '@/lib/utils';

/** ข้อมูลระบบจริงจาก backend - การแก้ไขค่าตั้งค่าจะทำใน Phase 6 */
export default function AdminSettingsPage() {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['system-info'],
    queryFn: api.systemInfo,
    refetchInterval: 30_000,
    retry: 1,
  });

  const info = data?.data;

  return (
    <div className="space-y-4">
      <PageTitle title="ตั้งค่า" description="ข้อมูลระบบและค่าตั้งค่าของ S2 NAS" />

      <Panel>
        <PanelHeader
          title="ข้อมูลระบบ"
          description="สถานะปัจจุบันของเซิร์ฟเวอร์"
          action={<Badge tone="info">อ่านอย่างเดียว</Badge>}
        />
        <PanelBody>
          {isPending ? (
            <TextSkeleton lines={5} />
          ) : isError || !info ? (
            <ErrorState message="อ่านข้อมูลระบบไม่สำเร็จ" onRetry={() => void refetch()} />
          ) : (
            <dl className="divide-y divide-line text-[13px]">
              <Row label="ระบบ" value={`${info.service} · ${info.subtitle}`} />
              <Row label="เวอร์ชัน" value={info.version} />
              <Row label="Environment" value={info.environment} />
              <Row label="ฐานข้อมูล" value={info.database} />
              <Row label="ขนาดอัปโหลดสูงสุด" value={`${info.maxUploadSizeMb} MB`} />
              <Row label="Uptime" value={formatUptime(info.uptime)} />
            </dl>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="ค่าตั้งค่าระบบ"
          description="ปรับค่าการทำงานของ S2 NAS"
          action={<Badge tone="neutral">Phase 6</Badge>}
        />
        <PanelBody>
          <p className="text-[12.5px] leading-relaxed text-navy-400">
            การแก้ไขค่าตั้งค่าจะเปิดใช้งานพร้อมระบบสิทธิ์ MANAGE_SYSTEM
          </p>
        </PanelBody>
      </Panel>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-navy-400">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-navy-800">{value}</dd>
    </div>
  );
}
