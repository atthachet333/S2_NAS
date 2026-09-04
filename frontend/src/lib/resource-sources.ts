/**
 * ต้นทางของทรัพยากร
 *
 * S2 NAS เป็นศูนย์กลางของทรัพยากรจากหลายระบบใน S2 Ecosystem
 * ป้ายชื่อเป็นข้อมูล ไม่ใช่การจัดวาง จึงอยู่ที่นี่แยกจากคอมโพเนนต์ที่วาดป้าย
 */
export type ResourceSource =
  | 'MANUAL'
  | 'GOOGLE'
  | 'S2_PAYROLL'
  | 'S2_ERP'
  | 'S2_LINE_BOT'
  | 'EXTERNAL_UPLOAD'
  | 'SYSTEM';

export const RESOURCE_SOURCE_LABEL: Record<ResourceSource, string> = {
  MANUAL: 'Uploaded',
  GOOGLE: 'Google',
  S2_PAYROLL: 'S2 Payroll',
  S2_ERP: 'S2 ERP',
  S2_LINE_BOT: 'S2 LINE Bot',
  EXTERNAL_UPLOAD: 'External',
  SYSTEM: 'System',
};

export function sourceLabel(source?: ResourceSource): string {
  return source ? RESOURCE_SOURCE_LABEL[source] : '—';
}
