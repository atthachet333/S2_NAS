import { Database } from 'lucide-react';
import { formatBytes } from '@/lib/utils';
import { TextSkeleton } from '@/components/ui/States';

/**
 * การ์ดพื้นที่จัดเก็บแบบวงแหวน
 *
 * ใช้ข้อมูลจริงจาก GET /api/system/storage เท่านั้น (ตัวเลขดิสก์ของ storage root)
 * ไม่มีการประมาณค่าและไม่เปิดเผยเส้นทางไฟล์จริงบนเซิร์ฟเวอร์
 *
 * วงแหวนวาดตามสัดส่วนจริง ใช้ปลายเส้นแบบมนเพื่อให้สัดส่วนที่น้อยมาก
 * (เช่น 0.8%) ยังมองเห็นได้ โดยตัวเลขกำกับยังเป็นค่าจริงเสมอ
 */
const SIZE = 148;
const STROKE = 13;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface StorageDonutData {
  totalBytes: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
}

export function StorageDonut({
  data,
  managedBytes,
  isLoading = false,
  isError = false,
}: {
  data?: StorageDonutData;
  /** ขนาดรวมของไฟล์ที่ S2 NAS ดูแลจริง แยกจากพื้นที่ดิสก์ทั้ง volume */
  managedBytes?: number;
  isLoading?: boolean;
  isError?: boolean;
}) {
  const hasData =
    !isError && data && data.totalBytes !== null && data.totalBytes > 0 && data.usedBytes !== null;

  const percent = hasData ? (data.usedBytes! / data.totalBytes!) * 100 : 0;
  const clamped = Math.min(Math.max(percent, 0), 100);
  const offset = CIRCUMFERENCE * (1 - clamped / 100);

  const ringColor =
    clamped >= 90 ? 'var(--s2-danger-ring)' : clamped >= 75 ? 'var(--s2-warning-ring)' : 'var(--s2-primary)';

  return (
    <article className="s2-resource-card flex h-full flex-col p-5">
      <header className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-brand-50 text-brand-600">
          <Database className="h-4 w-4" aria-hidden />
        </span>
        <h3 className="text-[13px] font-semibold text-navy-800">พื้นที่ดิสก์ที่ใช้งาน</h3>
      </header>

      {isLoading ? (
        <div className="mt-5 flex-1">
          <TextSkeleton lines={4} />
        </div>
      ) : !hasData ? (
        <div className="mt-5 flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-navy-50 text-navy-300">
            <Database className="h-5 w-5" aria-hidden />
          </span>
          <p className="text-[12px] leading-relaxed text-navy-400">ยังไม่มีข้อมูลการใช้งานพื้นที่</p>
        </div>
      ) : (
        <div className="mt-4 flex flex-1 flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-5 xl:flex-col xl:gap-4">
          <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
            <svg
              width={SIZE}
              height={SIZE}
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              role="img"
              aria-label={`ใช้พื้นที่ไปแล้ว ${percent.toFixed(1)} เปอร์เซ็นต์`}
              className="-rotate-90"
            >
              <circle
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                stroke="var(--s2-donut-track)"
                strokeWidth={STROKE}
              />
              <circle
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                stroke={ringColor}
                strokeWidth={STROKE}
                strokeLinecap="round"
                strokeDasharray={CIRCUMFERENCE}
                strokeDashoffset={offset}
                style={{ transition: 'stroke-dashoffset .6s ease' }}
              />
            </svg>

            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-[24px] font-semibold leading-none tracking-tight text-navy-900">
                {percent < 10 ? percent.toFixed(1) : Math.round(percent)}
                <span className="ml-0.5 text-[13px] font-medium text-navy-400">%</span>
              </span>
              <span className="mt-1 text-[10px] text-navy-400">ใช้ไปแล้ว</span>
            </div>
          </div>

          <dl className="w-full min-w-0 space-y-2">
            <Row label="ใช้ไป" value={formatBytes(data.usedBytes)} accent />
            <Row label="จากทั้งหมด" value={formatBytes(data.totalBytes)} />
            <Row label="คงเหลือ" value={formatBytes(data.freeBytes)} />
            {managedBytes !== undefined ? (
              <Row label="ไฟล์ใน S2 NAS" value={formatBytes(managedBytes)} />
            ) : null}
          </dl>
        </div>
      )}

      {hasData ? (
        <p className="mt-3 border-t border-line pt-2.5 text-[10px] leading-relaxed text-navy-400">
          ตัวเลขนี้คือพื้นที่ของไดรฟ์ทั้งลูกที่เก็บ storage root ไม่ใช่ขนาดไฟล์ใน S2 NAS เพียงอย่างเดียว
        </p>
      ) : null}
    </article>
  );
}

function Row({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line pb-2 last:border-0 last:pb-0">
      <dt className="shrink-0 text-[11px] text-navy-400">{label}</dt>
      <dd
        className={
          accent
            ? 'truncate text-[13px] font-semibold text-navy-900'
            : 'truncate text-[12px] font-medium text-navy-600'
        }
      >
        {value}
      </dd>
    </div>
  );
}
