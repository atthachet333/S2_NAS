/**
 * การตัดสินใจเรื่องการเชิญให้ติดตั้งแอป (F24-J)
 *
 * **แยกออกมาเป็นตรรกะบริสุทธิ์** เพราะกฎว่า "ควรเชิญตอนไหน" มีเงื่อนไขหลายชั้น
 * และทุกชั้นเป็นเรื่องที่ทำผิดแล้วน่ารำคาญมาก การเชิญซ้ำ ๆ คือสาเหตุอันดับหนึ่ง
 * ที่ผู้ใช้เรียนรู้ที่จะเมินคำเชิญทุกชนิดของแอป
 */

export type InstallCapability =
  /** เบราว์เซอร์ให้เราสั่งเปิดกล่องติดตั้งได้เอง (Chromium) */
  | 'PROMPTABLE'
  /** ติดตั้งได้แต่ต้องทำเอง (iOS Safari) - เราสั่งแทนไม่ได้ */
  | 'MANUAL_ONLY'
  /** ติดตั้งไปแล้ว กำลังเปิดจากไอคอนบนหน้าจอโฮม */
  | 'INSTALLED'
  /** เบราว์เซอร์นี้ติดตั้งไม่ได้ */
  | 'UNSUPPORTED';

export interface InstallEnvironment {
  /** ได้รับเหตุการณ์ beforeinstallprompt แล้วหรือยัง */
  promptCaptured: boolean;
  /** กำลังทำงานในโหมดแอปที่ติดตั้งแล้ว */
  standalone: boolean;
  /** เป็น iOS ซึ่งไม่มี beforeinstallprompt แต่ติดตั้งด้วยมือได้ */
  ios: boolean;
}

export function installCapability(environment: InstallEnvironment): InstallCapability {
  // ติดตั้งแล้วสำคัญที่สุด - ไม่ต้องเชิญคนที่ติดตั้งไปแล้ว
  if (environment.standalone) return 'INSTALLED';
  if (environment.promptCaptured) return 'PROMPTABLE';
  if (environment.ios) return 'MANUAL_ONLY';
  return 'UNSUPPORTED';
}

/** ระยะเวลาที่เงียบหลังผู้ใช้ปิดคำเชิญ - นานพอให้ไม่รู้สึกว่าถูกตื๊อ */
export const DISMISS_QUIET_DAYS = 30;

export interface AutoInviteInput {
  capability: InstallCapability;
  /** เวลาที่ผู้ใช้ปิดคำเชิญครั้งล่าสุด (มิลลิวินาที) - ไม่เคยปิดคือ null */
  dismissedAt: number | null;
  now: number;
  /** มีงานที่ค้างอยู่ เช่น กำลังอัปโหลด หรือมีกล่องโต้ตอบเปิดอยู่ */
  busy: boolean;
  /** ยังไม่ได้เข้าสู่ระบบ */
  anonymous: boolean;
}

/**
 * ควรเชิญให้ติดตั้งเองโดยไม่ต้องรอผู้ใช้ไปหาในเมนูหรือไม่
 *
 * **ทำไมไม่เชิญตอนยังไม่เข้าสู่ระบบ:** คนที่ยังไม่ผ่านหน้าเข้าระบบยังไม่รู้เลยว่า
 * แอปนี้มีประโยชน์กับเขาหรือไม่ การขอให้ติดตั้งตอนนั้นคือการขอก่อนที่จะให้อะไรเลย
 *
 * **ทำไมไม่เชิญตอนมีงานค้าง:** คำเชิญที่โผล่มาระหว่างอัปโหลดจะบังความคืบหน้า
 * และถ้าผู้ใช้กดติดตั้ง เบราว์เซอร์จะเปิดกล่องของระบบทับสิ่งที่เขากำลังดูอยู่
 */
export function shouldAutoInvite(input: AutoInviteInput): boolean {
  if (input.capability === 'INSTALLED' || input.capability === 'UNSUPPORTED') return false;
  if (input.anonymous || input.busy) return false;
  if (input.dismissedAt === null) return true;

  const quietPeriod = DISMISS_QUIET_DAYS * 24 * 60 * 60 * 1000;
  return input.now - input.dismissedAt >= quietPeriod;
}

/**
 * คีย์ที่เก็บความจำเรื่องการปิดคำเชิญ
 *
 * เก็บแค่เวลาที่ปิด ซึ่งไม่ใช่ข้อมูลส่วนบุคคลและไม่ผูกกับบัญชีใด
 * ห้ามเก็บอะไรที่ระบุตัวผู้ใช้ได้ลงใน web storage ตามข้อตกลงเดิมของระบบ
 */
export const INSTALL_DISMISSED_KEY = 's2-install-dismissed-at';

/** อ่านเวลาที่ปิดคำเชิญ - ค่าที่เสียหายถือว่าไม่เคยปิด */
export function readDismissedAt(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}
