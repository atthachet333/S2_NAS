import { badRequest } from '../../core/errors.js';

/**
 * นโยบายรหัสผ่าน
 *
 * ใช้ร่วมกันทั้งการเปลี่ยนรหัสผ่านด้วยตัวเอง และการตั้งรหัสผ่านชั่วคราวโดยผู้ดูแล
 * ถ้าปล่อยให้ผู้ดูแลตั้งรหัสอ่อนกว่าที่ผู้ใช้ตั้งเองได้ ช่องทางที่อ่อนที่สุดจะกลาย
 * เป็นช่องทางที่ใช้จริง เพราะเป็นรหัสแรกที่ทุกบัญชีใหม่ต้องผ่าน
 */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

/**
 * คำที่เดาได้ทันทีจากบริบทของระบบนี้
 *
 * ไม่ห้ามทั้งรหัสเพียงเพราะมีคำเหล่านี้อยู่ เพราะวลียาว ๆ ที่แข็งแรงจริงอาจบังเอิญ
 * มีคำว่า password อยู่ข้างในได้ แต่จะตัดคำเหล่านี้ทิ้งแล้ววัดว่าสิ่งที่เหลือยังยาวพอไหม
 * รหัสที่เหลือแทบไม่มีอะไรหลังตัดคำเดาง่ายออก คือรหัสที่เดาง่ายจริง
 */
const GUESSABLE_TOKENS = [
  /s2\s*nas/giu,
  /password/giu,
  /qwerty/giu,
  /1234567890|123456789|12345678/gu,
  /admin/giu,
];

export interface PasswordCheck {
  ok: boolean;
  reason?: string;
}

export function checkPasswordStrength(password: string): PasswordCheck {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: 'รหัสผ่านยาวเกินกำหนด' };
  }
  if (password.trim() !== password) {
    return { ok: false, reason: 'รหัสผ่านต้องไม่ขึ้นต้นหรือลงท้ายด้วยช่องว่าง' };
  }

  // ต้องมีอักขระอย่างน้อยสองประเภท กันรหัสยาวแต่เป็นตัวอักษรล้วนซ้ำ ๆ
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^\p{L}\p{N}]/u].filter((pattern) =>
    pattern.test(password),
  );
  if (classes.length < 2) {
    return { ok: false, reason: 'รหัสผ่านต้องมีอักขระอย่างน้อยสองประเภท เช่น ตัวอักษรและตัวเลข' };
  }

  if (/^(.)\1+$/u.test(password)) {
    return { ok: false, reason: 'รหัสผ่านนี้เดาง่ายเกินไป' };
  }

  const remaining = GUESSABLE_TOKENS.reduce((text, token) => text.replace(token, ''), password);
  if (remaining.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: 'รหัสผ่านนี้เดาง่ายเกินไป' };
  }

  return { ok: true };
}

/** ตรวจแล้วโยนข้อผิดพลาดทันทีถ้าไม่ผ่าน ใช้ในเส้นทางที่ต้องหยุดการทำงาน */
export function assertPasswordStrength(password: string): void {
  const result = checkPasswordStrength(password);
  if (!result.ok) throw badRequest('WEAK_PASSWORD', result.reason ?? 'รหัสผ่านไม่ปลอดภัยพอ');
}
