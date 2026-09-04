import { Bot, Building2, Cloud, ExternalLink, HardDrive, Server, Wallet, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RESOURCE_SOURCE_LABEL, type ResourceSource } from '@/lib/resource-sources';

export { sourceLabel } from '@/lib/resource-sources';
export type { ResourceSource } from '@/lib/resource-sources';

/**
 * ต้นทางของทรัพยากร
 *
 * ป้ายนี้ต้องบอกได้ทันทีว่า "ทรัพยากรนี้มาจากไหน" โดยไม่แย่งสายตาไปจากชื่อไฟล์
 * จึงใช้สีเข้มเฉพาะที่ไอคอน ส่วนพื้นหลังคงความสุภาพไว้
 * ชื่อที่แสดงมาจาก lib/resource-sources เพื่อให้ตารางกับป้ายพูดตรงกันเสมอ
 */
const SOURCES: Record<ResourceSource, { label: string; icon: LucideIcon; tone: string }> = {
  MANUAL: { label: RESOURCE_SOURCE_LABEL.MANUAL, icon: HardDrive, tone: 'text-navy-500' },
  GOOGLE: { label: RESOURCE_SOURCE_LABEL.GOOGLE, icon: Cloud, tone: 'text-[#1a73e8]' },
  S2_PAYROLL: { label: RESOURCE_SOURCE_LABEL.S2_PAYROLL, icon: Wallet, tone: 'text-violet-500' },
  S2_ERP: { label: RESOURCE_SOURCE_LABEL.S2_ERP, icon: Building2, tone: 'text-sky-500' },
  S2_LINE_BOT: { label: RESOURCE_SOURCE_LABEL.S2_LINE_BOT, icon: Bot, tone: 'text-[#06c755]' },
  EXTERNAL_UPLOAD: { label: RESOURCE_SOURCE_LABEL.EXTERNAL_UPLOAD, icon: ExternalLink, tone: 'text-amber-500' },
  SYSTEM: { label: RESOURCE_SOURCE_LABEL.SYSTEM, icon: Server, tone: 'text-navy-400' },
};

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
