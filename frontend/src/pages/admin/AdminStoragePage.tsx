import { useQuery } from '@tanstack/react-query';
import { HardDrive } from 'lucide-react';
import { api } from '@/lib/api';
import { Panel, PanelBody, PanelHeader, Badge } from '@/components/ui/Panel';
import { ErrorState, TextSkeleton } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';
import { formatBytes } from '@/lib/utils';

/** พื้นที่จัดเก็บ - ข้อมูลจริงจาก backend */
export default function AdminStoragePage() {
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['storage'],
    queryFn: api.storage,
    refetchInterval: 60_000,
    retry: 1,
  });

  const storage = data?.data;
  const percent =
    storage?.totalBytes && storage.totalBytes > 0 && storage.usedBytes !== null
      ? (storage.usedBytes / storage.totalBytes) * 100
      : 0;

  return (
    <div className="space-y-4">
      <PageTitle title="Storage" description="พื้นที่จัดเก็บไฟล์บนเซิร์ฟเวอร์" />

      <Panel>
        <PanelHeader
          title="พื้นที่ใช้งาน"
          description="ข้อมูลจากไดรฟ์ที่ตั้งเป็น storage root"
          action={
            storage ? (
              <Badge tone={storage.status === 'READY' ? 'success' : storage.status === 'READ_ONLY' ? 'warning' : 'danger'}>
                {storage.status}
              </Badge>
            ) : null
          }
        />
        <PanelBody>
          {isPending ? (
            <TextSkeleton lines={4} />
          ) : isError || !storage ? (
            <ErrorState message="อ่านข้อมูลพื้นที่จัดเก็บไม่สำเร็จ" onRetry={() => void refetch()} />
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-navy-50 text-navy-500">
                  <HardDrive className="h-5 w-5" aria-hidden />
                </span>
                <div>
                  <p className="text-[15px] font-semibold text-navy-900">
                    {formatBytes(storage.usedBytes)} / {formatBytes(storage.totalBytes)}
                  </p>
                  <p className="text-[12px] text-navy-400">เหลือ {formatBytes(storage.freeBytes)}</p>
                </div>
              </div>

              <div className="h-2 w-full overflow-hidden rounded-full bg-navy-50">
                <div
                  className={`h-full rounded-full ${percent >= 90 ? 'bg-red-500' : percent >= 75 ? 'bg-amber-500' : 'bg-brand-500'}`}
                  style={{ width: `${Math.min(percent, 100)}%` }}
                />
              </div>

              <dl className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-4">
                <Stat label="สถานะ" value={storage.status} />
                <Stat label="อ่านได้" value={storage.readable ? 'ใช่' : 'ไม่'} ok={storage.readable} />
                <Stat label="เขียนได้" value={storage.writable ? 'ใช่' : 'ไม่'} ok={storage.writable} />
                <Stat label="ใช้ไป" value={`${percent.toFixed(1)}%`} />
              </dl>

              <p className="text-[11.5px] leading-relaxed text-navy-300">
                ตำแหน่งจริงของ storage อยู่บนเซิร์ฟเวอร์เท่านั้น และไม่ถูกส่งมายังเบราว์เซอร์
              </p>
            </div>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}

function Stat({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="rounded-[10px] bg-canvas px-3 py-2.5">
      <dt className="text-navy-400">{label}</dt>
      <dd
        className={
          ok === undefined
            ? 'mt-0.5 font-medium text-navy-800'
            : ok
              ? 'mt-0.5 font-medium text-emerald-700'
              : 'mt-0.5 font-medium text-red-600'
        }
      >
        {value}
      </dd>
    </div>
  );
}
