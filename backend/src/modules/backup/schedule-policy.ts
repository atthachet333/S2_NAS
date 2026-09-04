/**
 * กติกาของตารางเวลาสำรองข้อมูล
 *
 * แยกออกมาเป็นฟังก์ชันบริสุทธิ์ทั้งหมด รับ "เวลาปัจจุบัน" เข้ามาเสมอ ไม่อ่านนาฬิกาเอง
 * จึงทดสอบเวลาข้ามวัน ข้ามโซนเวลา และกรณีเซิร์ฟเวอร์รีสตาร์ทได้โดยไม่ต้องรอเวลาจริง
 */

export interface ScheduleConfig {
  enabled: boolean;
  /** HH:mm ตีความตามโซนเวลาด้านล่าง */
  time: string;
  timezone: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function parseTimeOfDay(time: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) throw new Error(`เวลาไม่ถูกต้อง: ${time}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * ชิ้นส่วนของเวลาในโซนเวลาที่กำหนด
 *
 * ใช้ Intl แทนการบวกลบ offset เอง เพราะ offset ของแต่ละโซนเปลี่ยนได้ตามฤดูกาล
 * Asia/Bangkok ไม่มี DST แต่โค้ดต้องไม่ผูกกับข้อเท็จจริงนั้น มิฉะนั้นย้ายโซนเวลาแล้วพังเงียบ ๆ
 */
export function zonedParts(instant: Date, timezone: string): {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // บางโซนเวลา Intl คืนชั่วโมงเป็น 24 แทน 0 ที่เที่ยงคืน
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** วันตามโซนเวลาในรูป YYYY-MM-DD - ใช้เป็นกุญแจว่า "วันนี้สำรองไปหรือยัง" */
export function zonedDateKey(instant: Date, timezone: string): string {
  const { year, month, day } = zonedParts(instant, timezone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** offset ของโซนเวลา ณ เวลาหนึ่ง (มิลลิวินาที) คำนวณจากผลต่างที่ Intl รายงาน */
function zoneOffsetMs(instant: Date, timezone: string): number {
  const parts = zonedParts(instant, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * เวลาที่กำหนดของ "วันตามโซนเวลา" ที่ระบุ แปลงกลับเป็นเวลาจริง
 *
 * คำนวณสองรอบเพื่อรองรับโซนที่ offset เปลี่ยนคร่อมจุดนั้นพอดี
 */
export function scheduledInstantFor(dateKey: string, config: ScheduleConfig): Date {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  const { hour, minute } = parseTimeOfDay(config.time);

  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstGuess = new Date(naive - zoneOffsetMs(new Date(naive), config.timezone));
  const corrected = new Date(naive - zoneOffsetMs(firstGuess, config.timezone));
  return corrected;
}

/**
 * รอบถัดไปที่ต้องทำงาน นับจากเวลาที่ให้มา
 * ถ้าวันนี้ยังไม่ถึงเวลา ก็คือวันนี้ ถ้าเลยแล้วก็คือพรุ่งนี้
 */
export function nextRunAt(now: Date, config: ScheduleConfig): Date {
  const today = scheduledInstantFor(zonedDateKey(now, config.timezone), config);
  if (today.getTime() > now.getTime()) return today;
  const tomorrow = new Date(now.getTime() + DAY_MS);
  return scheduledInstantFor(zonedDateKey(tomorrow, config.timezone), config);
}

export type ScheduleDecision =
  | { action: 'SKIP'; reason: 'DISABLED' | 'ALREADY_RAN_TODAY' | 'NOT_DUE' | 'MISSED_TOO_LONG' }
  | { action: 'RUN'; reason: 'DUE' | 'CATCH_UP'; forDate: string };

export interface ScheduleState {
  /** วัน (ตามโซนเวลา) ของงานตามตารางที่สำเร็จล่าสุด */
  lastScheduledRunDate: string | null;
}

/**
 * ตัดสินว่าตอนนี้ควรสำรองข้อมูลหรือไม่
 *
 * กติกาการตามเก็บหลังเซิร์ฟเวอร์รีสตาร์ท:
 *   - ถ้าวันนี้มีงานตามตารางสำเร็จไปแล้ว → ข้าม ไม่ทำซ้ำ
 *   - ถ้ายังไม่ถึงเวลาของวันนี้ → ยังไม่ถึงกำหนด
 *   - ถ้าเลยเวลามาแล้วไม่เกินช่วงผ่อนผัน → ตามเก็บหนึ่งครั้ง
 *   - ถ้าเลยมานานกว่าช่วงผ่อนผัน → ข้ามไปรอบถัดไป
 *
 * ข้อสุดท้ายสำคัญ: เซิร์ฟเวอร์ที่ดับไปสามวันแล้วกลับมา ไม่ควรสำรองย้อนหลังรวดเดียว
 * เพราะข้อมูลที่ได้คือสถานะ "ตอนนี้" อยู่ดี การทำซ้ำจึงไม่ได้เพิ่มความปลอดภัยอะไร
 */
export function decideScheduledRun(
  now: Date,
  config: ScheduleConfig,
  state: ScheduleState,
  graceHours: number,
): ScheduleDecision {
  if (!config.enabled) return { action: 'SKIP', reason: 'DISABLED' };

  const todayKey = zonedDateKey(now, config.timezone);
  if (state.lastScheduledRunDate === todayKey) return { action: 'SKIP', reason: 'ALREADY_RAN_TODAY' };

  const dueAt = scheduledInstantFor(todayKey, config);
  const elapsed = now.getTime() - dueAt.getTime();

  if (elapsed < 0) return { action: 'SKIP', reason: 'NOT_DUE' };
  if (elapsed <= 60_000) return { action: 'RUN', reason: 'DUE', forDate: todayKey };
  if (elapsed <= graceHours * HOUR_MS) return { action: 'RUN', reason: 'CATCH_UP', forDate: todayKey };
  return { action: 'SKIP', reason: 'MISSED_TOO_LONG' };
}

/** ชุดสำรองล่าสุดเก่าเกินไปหรือยัง - ใช้เตือนผู้ดูแล ไม่ใช่บล็อกอะไร */
export function isBackupStale(lastSuccessAt: Date | null, now: Date, staleHours: number): boolean {
  if (!lastSuccessAt) return true;
  return now.getTime() - lastSuccessAt.getTime() > staleHours * HOUR_MS;
}

/* ------------------------------------------------------------------ */
/* ตารางการซ้อมกู้คืน (รายสัปดาห์)                                      */
/* ------------------------------------------------------------------ */

export interface RehearsalScheduleConfig extends ScheduleConfig {
  /** 0 = อาทิตย์ ... 6 = เสาร์ ตามโซนเวลาที่กำหนด */
  dayOfWeek: number;
}

/** วันในสัปดาห์ตามโซนเวลา ไม่ใช่ตาม UTC */
export function zonedDayOfWeek(instant: Date, timezone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(instant);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

/**
 * รอบซ้อมถัดไป
 *
 * เดินหน้าทีละวันจนเจอวันที่ตรงและเวลายังมาไม่ถึง อ่านง่ายกว่าการคำนวณ offset
 * และไม่พลาดกรณีข้ามเดือนหรือข้ามปี
 */
export function nextRehearsalAt(now: Date, config: RehearsalScheduleConfig): Date {
  for (let offset = 0; offset <= 7; offset += 1) {
    const probe = new Date(now.getTime() + offset * DAY_MS);
    if (zonedDayOfWeek(probe, config.timezone) !== config.dayOfWeek) continue;
    const instant = scheduledInstantFor(zonedDateKey(probe, config.timezone), config);
    if (instant.getTime() > now.getTime()) return instant;
  }
  // ไม่ควรเกิดขึ้น แต่ถ้าเกิดก็ต้องคืนเวลาในอนาคตเสมอ ไม่ใช่เวลาในอดีต
  return new Date(now.getTime() + 7 * DAY_MS);
}

/**
 * ตัดสินว่าถึงเวลาซ้อมหรือยัง
 *
 * ใช้ปรัชญาเดียวกับตารางสำรองข้อมูล: ตามเก็บได้ถ้าพลาดไม่นาน
 * แต่ถ้าพลาดมานานให้รอรอบหน้า ไม่ซ้อมย้อนหลังหลายครั้งรวดเดียว
 */
export function decideRehearsalRun(
  now: Date,
  config: RehearsalScheduleConfig,
  state: { lastRehearsalDate: string | null },
  graceHours: number,
): ScheduleDecision {
  if (!config.enabled) return { action: 'SKIP', reason: 'DISABLED' };
  if (zonedDayOfWeek(now, config.timezone) !== config.dayOfWeek) return { action: 'SKIP', reason: 'NOT_DUE' };

  const todayKey = zonedDateKey(now, config.timezone);
  if (state.lastRehearsalDate === todayKey) return { action: 'SKIP', reason: 'ALREADY_RAN_TODAY' };

  const dueAt = scheduledInstantFor(todayKey, config);
  const elapsed = now.getTime() - dueAt.getTime();

  if (elapsed < 0) return { action: 'SKIP', reason: 'NOT_DUE' };
  if (elapsed <= 60_000) return { action: 'RUN', reason: 'DUE', forDate: todayKey };
  if (elapsed <= graceHours * HOUR_MS) return { action: 'RUN', reason: 'CATCH_UP', forDate: todayKey };
  return { action: 'SKIP', reason: 'MISSED_TOO_LONG' };
}

/** การซ้อมล่าสุดเก่าเกินไปหรือยัง - ใช้เตือน ไม่ใช่บล็อก */
export function isRehearsalStale(lastPassedAt: Date | null, now: Date, staleDays: number): boolean {
  if (!lastPassedAt) return true;
  return now.getTime() - lastPassedAt.getTime() > staleDays * DAY_MS;
}
