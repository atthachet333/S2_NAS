import { Bot, Building2, Cloud, ExternalLink, HardDrive, Server, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ResourceSource =
  | 'MANUAL'
  | 'GOOGLE'
  | 'S2_PAYROLL'
  | 'S2_ERP'
  | 'S2_LINE_BOT'
  | 'EXTERNAL_UPLOAD'
  | 'SYSTEM';

/**
 * ต้นทางของทรัพยากร
 *
 * S2 NAS เป็นศูนย์กลางของทรัพยากรจากหลายระบบใน S2 Ecosystem
 * ป้ายนี้ต้องบอกได้ทันทีว่า "ทรัพยากรนี้มาจากไหน" โดยไม่แย่งสายตาไปจากชื่อไฟล์
 * จึงใช้สีเข้มเฉพาะที่ไอคอน ส่วนพื้นหลังคงความสุภาพไว้
 */
const SOURCES = {
  MANUAL: { label: 'Uploaded', icon: HardDrive, tone: 'text-navy-500' },
  GOOGLE: { label: 'Google', icon: Cloud, tone: 'text-[#1a73e8]' },
  S2_PAYROLL: { label: 'S2 Payroll', icon: Wallet, tone: 'text-violet-500' },
  S2_ERP: { label: 'S2 ERP', icon: Building2, tone: 'text-sky-500' },
  S2_LINE_BOT: { label: 'LINE Bot', icon: Bot, tone: 'text-[#06c755]' },
  EXTERNAL_UPLOAD: { label: 'External', icon: ExternalLink, tone: 'text-amber-500' },
  SYSTEM: { label: 'System', icon: Server, tone: 'text-navy-400' },
} as const;

export function sourceLabel(source?: ResourceSource): string {
  return source ? SOURCES[source].label : '—';
}

export function ResourceSourceBadge({
  source,
  /** ต้นทางที่ผู้ใช้สร้างเองเป็นค่าปกติ ซ่อนได้เพื่อลดสัญญาณรบกวนในตาราง */
  hideManual = false,
  className,
}: {
  source?: ResourceSource;
  hideManual?: boolean;
  className?: string;
}) {
  if (!source) return null;
  if (hideManual && source === 'MANUAL') return null;

  const item = SOURCES[source];
  const Icon = item.icon;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-line bg-[var(--s2-surface-soft)] px-1.5 py-0.5 text-[10px] font-medium text-navy-500',
        className,
      )}
      title={`ต้นทาง: ${item.label}`}
    >
      <Icon className={cn('h-3 w-3', item.tone)} aria-hidden />
      {item.label}
    </span>
  );
}
