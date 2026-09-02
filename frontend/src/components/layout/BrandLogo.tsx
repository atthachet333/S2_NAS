import { useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * โลโก้ S2 NAS
 *
 * ใช้ไฟล์จริงจาก /s2-nas-logo.png ถ้ามี ถ้าโหลดไม่สำเร็จจะถอยไปใช้โลโก้ตัวอักษรเดิม
 * ไฟล์โลโก้ปัจจุบันเป็นภาพจัตุรัสที่มีชื่อ "S2 NAS" อยู่ในตัวแล้ว
 * จึงต้องไม่วางข้อความ "S2 NAS" ซ้ำข้าง ๆ อีก (ดูกฎข้อ 10)
 *
 * พื้นหลังของไฟล์เป็นสีอ่อนไม่โปร่งใส จึงวางบนแผ่นสีขาวเพื่อให้ดูตั้งใจทั้งธีมสว่างและมืด
 */
export function BrandLogo({
  size = 36,
  /** แสดงข้อความกำกับใต้/ข้างโลโก้ ใช้เมื่อโลโก้เป็นแบบไอคอนล้วนเท่านั้น */
  showWordmark = false,
  className,
}: {
  size?: number;
  showWordmark?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    // โลโก้สำรองแบบตัวอักษร ใช้เมื่อยังไม่มีไฟล์ภาพ
    return (
      <span className={cn('flex items-center gap-2.5', className)}>
        <span
          className="relative flex items-center justify-center overflow-hidden rounded-[11px] bg-[#14213d] font-bold text-white"
          style={{ height: size, width: size, fontSize: size * 0.34 }}
        >
          <span className="absolute inset-x-0 top-0 h-px bg-white/40" />
          S2
        </span>
        <span className="hidden leading-tight sm:block">
          <span className="block text-[14.5px] font-bold tracking-[-0.02em] text-navy-900">S2 NAS</span>
          <span className="block text-[10px] text-navy-400">พื้นที่ไฟล์ขององค์กร</span>
        </span>
      </span>
    );
  }

  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <span
        className="flex shrink-0 items-center justify-center overflow-hidden rounded-[11px] bg-white ring-1 ring-line"
        style={{ height: size, width: size }}
      >
        <img
          src="/s2-nas-logo.png"
          alt="S2 NAS"
          width={size}
          height={size}
          decoding="async"
          className="h-full w-full object-contain"
          onError={() => setFailed(true)}
        />
      </span>

      {/* แสดงเฉพาะกรณีโลโก้เป็นไอคอนล้วน ไฟล์ปัจจุบันมีชื่อในตัวจึงปิดไว้ */}
      {showWordmark ? (
        <span className="hidden leading-tight sm:block">
          <span className="block text-[14.5px] font-bold tracking-[-0.02em] text-navy-900">S2 NAS</span>
          <span className="block text-[10px] text-navy-400">พื้นที่ไฟล์ขององค์กร</span>
        </span>
      ) : null}
    </span>
  );
}
