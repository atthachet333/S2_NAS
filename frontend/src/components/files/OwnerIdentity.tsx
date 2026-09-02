import { cn } from '@/lib/utils';

/**
 * ตัวตนของ "ผู้ดูแลโฟลเดอร์" (Folder Owner)
 *
 * เป็นแนวคิดหลักของ S2 NAS: ทุกทรัพยากรต้องมีผู้รับผิดชอบที่ชัดเจน
 * ใช้ตัวย่อจากชื่อจริงเท่านั้น ไม่มีรูปโปรไฟล์ปลอม
 */
export interface OwnerLike {
  displayName?: string | null;
  email?: string | null;
}

/** ตัวย่อจากชื่อ ถ้าไม่มีชื่อให้ใช้อีเมลแทน */
export function ownerInitials(owner: OwnerLike): string {
  const name = owner.displayName?.trim();
  if (name) {
    const words = name.split(/\s+/).filter(Boolean);
    if (words.length >= 2) return (words[0]!.slice(0, 1) + words[1]!.slice(0, 1)).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  const email = owner.email?.trim();
  if (email) return email.slice(0, 2).toUpperCase();
  return '—';
}

/** ชื่อที่แสดงได้เสมอ: ชื่อจริง → ส่วนหน้าอีเมล → ข้อความสำรอง */
export function ownerLabel(owner: OwnerLike): string {
  const name = owner.displayName?.trim();
  if (name) return name;
  const email = owner.email?.trim();
  if (email) return email.split('@')[0] ?? email;
  return 'ไม่ระบุผู้ดูแล';
}

const SIZES = {
  xs: 'h-5 w-5 text-[9px]',
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-[11px]',
  lg: 'h-11 w-11 text-[14px]',
} as const;

export function OwnerAvatar({
  owner,
  size = 'sm',
  className,
}: {
  owner: OwnerLike;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      className={cn('s2-avatar', SIZES[size], className)}
      aria-hidden
      title={owner.displayName ?? owner.email ?? undefined}
    >
      {ownerInitials(owner)}
    </span>
  );
}

/** ชิปขนาดเล็กสำหรับการ์ดและตาราง */
export function OwnerChip({ owner, className }: { owner: OwnerLike; className?: string }) {
  const label = ownerLabel(owner);
  return (
    <span className={cn('s2-chip', className)} title={owner.email ?? label}>
      <OwnerAvatar owner={owner} size="xs" />
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * แสดงตัวตนผู้ดูแลแบบเต็ม พร้อมป้ายกำกับบทบาท
 * ใช้ในหัวโฟลเดอร์และแผงรายละเอียด
 */
export function OwnerIdentity({
  owner,
  caption = 'ผู้ดูแลหลัก',
  size = 'md',
  className,
}: {
  owner: OwnerLike;
  caption?: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <OwnerAvatar owner={owner} size={size} />
      <div className="min-w-0 leading-tight">
        <p className="truncate text-[12.5px] font-semibold text-navy-800">{ownerLabel(owner)}</p>
        <p className="truncate text-[10.5px] text-navy-400">{caption}</p>
      </div>
    </div>
  );
}
