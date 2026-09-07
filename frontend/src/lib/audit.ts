/**
 * เครื่องมือตรวจสอบฝั่งหน้าจอ
 *
 * ป้ายทั้งหมดมาจากเซิร์ฟเวอร์ (สารบัญเหตุการณ์) ไม่ทำสำเนารายชื่อไว้ที่นี่
 * สำเนาที่สองจะเพี้ยนจากต้นฉบับในวันที่มีคนเพิ่มเหตุการณ์ใหม่แล้วอัปเดตแค่ที่เดียว
 *
 * ที่นี่เก็บเฉพาะสิ่งที่เป็นเรื่องของหน้าจอล้วน ๆ: การแปลงตัวกรองกับ URL
 * และการเลือกสี/ไอคอนตามระดับความสำคัญ
 */

export interface AuditFilters {
  q?: string;
  action?: string;
  category?: string;
  preset?: string;
  actorId?: string;
  actorType?: string;
  resourceId?: string;
  from?: string;
  to?: string;
  failuresOnly?: boolean;
}

export const AUDIT_FILTER_KEYS = [
  'q',
  'action',
  'category',
  'preset',
  'actorId',
  'actorType',
  'resourceId',
  'from',
  'to',
  'failuresOnly',
] as const;

const BOOLEAN_KEYS = new Set<string>(['failuresOnly']);

export const ACTOR_TYPE_LABELS: Record<string, string> = {
  INTERNAL: 'บุคลากร',
  EXTERNAL: 'ลูกค้า',
  SERVICE: 'บัญชีบริการ',
  SYSTEM: 'ระบบ',
  INTEGRATION: 'การเชื่อมต่อ',
};

/**
 * ช่วงวันที่สำเร็จรูป
 *
 * คำนวณเป็นวันที่จริงตอนกด แล้วเขียนลง URL - ลิงก์ที่ส่งต่อให้เพื่อนร่วมงาน
 * จึงหมายถึงช่วงเวลาเดียวกันเสมอ ไม่ใช่ "7 วันที่ผ่านมา" ที่เลื่อนไปตามวันที่เปิด
 * ซึ่งจะทำให้สองคนดูหลักฐานคนละชุดโดยไม่รู้ตัว
 */
export const DATE_PRESETS: Record<string, string> = {
  today: 'วันนี้',
  last7: '7 วันที่ผ่านมา',
  last30: '30 วันที่ผ่านมา',
  thisMonth: 'เดือนนี้',
  custom: 'กำหนดเอง',
};

export function resolveDatePreset(preset: string, now: Date = new Date()): { from?: string } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  switch (preset) {
    case 'today':
      return { from: start.toISOString() };
    case 'last7':
      start.setDate(start.getDate() - 6);
      return { from: start.toISOString() };
    case 'last30':
      start.setDate(start.getDate() - 29);
      return { from: start.toISOString() };
    case 'thisMonth':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() };
    default:
      return {};
  }
}

/* ------------------------------------------------------------------ */
/* URL                                                                 */
/* ------------------------------------------------------------------ */

export function auditFiltersFromParams(params: URLSearchParams): AuditFilters {
  const filters: Record<string, string | boolean> = {};
  for (const key of AUDIT_FILTER_KEYS) {
    const value = params.get(key);
    if (!value) continue;
    filters[key] = BOOLEAN_KEYS.has(key) ? value === 'true' : value;
  }
  return filters as AuditFilters;
}

export function auditParamsFromFilters(filters: AuditFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    params.set(key, String(value));
  }
  return params;
}

/* ------------------------------------------------------------------ */
/* การแสดงผล                                                            */
/* ------------------------------------------------------------------ */

/**
 * สีของแถวตามระดับความสำคัญ
 *
 * ใช้อย่างประหยัด - เหตุการณ์ปกติเป็นกลาง เพราะถ้าทุกแถวมีสี
 * จะไม่มีแถวไหนโดดเด่น และผู้ตรวจสอบจะมองข้ามสิ่งที่สำคัญจริง
 */
/**
 * สีตัวอักษรมาจากโทเคนของธีม ไม่ใช่เฉดคงที่ของ Tailwind
 *
 * ระบบสลับเฉพาะพื้นหลัง (-50) ให้เข้ากับธีมมืด ส่วนสีตัวอักษรอย่าง text-amber-800
 * ยังเป็นสีเข้มเหมือนเดิม ผลคือตัวอักษรสีเข้มบนพื้นเข้ม ซึ่งอ่านไม่ออก
 * และป้ายที่อ่านไม่ออกก็ไม่ต่างจากไม่มีป้าย
 */
export const TONE_CLASS: Record<string, string> = {
  DANGER: 'border-red-200 bg-red-50 text-[var(--s2-danger-ring)]',
  WARNING: 'border-amber-200 bg-amber-50 text-[var(--s2-warning-ring)]',
  SUCCESS: 'border-emerald-200 bg-emerald-50 text-[var(--s2-success-ring)]',
  NEUTRAL: 'border-line bg-[var(--s2-surface-soft)] text-navy-600',
};

/** ป้ายที่กดปิดได้ของตัวกรองที่ใช้อยู่ */
export interface AuditChip {
  key: string;
  label: string;
}

export function auditChips(
  filters: AuditFilters,
  lookups: {
    presets?: Map<string, string>;
    categories?: Map<string, string>;
    events?: Map<string, string>;
    actors?: Map<string, string>;
  } = {},
): AuditChip[] {
  const chips: AuditChip[] = [];
  const add = (key: string, label: string) => chips.push({ key, label });

  if (filters.preset && filters.preset !== 'all') {
    add('preset', lookups.presets?.get(filters.preset) ?? filters.preset);
  }
  if (filters.category) add('category', lookups.categories?.get(filters.category) ?? filters.category);
  if (filters.action) add('action', lookups.events?.get(filters.action) ?? filters.action);
  if (filters.actorId) add('actorId', `ผู้ดำเนินการ: ${lookups.actors?.get(filters.actorId) ?? 'ที่เลือก'}`);
  if (filters.actorType) {
    add('actorType', ACTOR_TYPE_LABELS[filters.actorType] ?? filters.actorType);
  }
  if (filters.resourceId) add('resourceId', 'เฉพาะทรัพยากรที่เลือก');
  if (filters.failuresOnly) add('failuresOnly', 'เฉพาะที่ล้มเหลว/ถูกปฏิเสธ');
  if (filters.from) add('from', `ตั้งแต่ ${formatDate(filters.from)}`);
  if (filters.to) add('to', `ถึง ${formatDate(filters.to)}`);

  return chips;
}

export function formatDate(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return date.toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return date.toLocaleString('th-TH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** ชื่อทรัพยากรที่ปลอดภัยสำหรับแสดง - ของที่ถูกลบแล้วยังต้องอ่านรู้เรื่อง */
export function resourceLabel(
  resource: { name: string | null; deleted: boolean } | null,
): string | null {
  if (!resource) return null;
  return resource.deleted ? 'ทรัพยากรถูกลบแล้ว' : resource.name;
}
