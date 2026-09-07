import { SignJWT, jwtVerify } from 'jose';
import { env } from '../../config/env.js';

/**
 * ใบผ่านชั่วคราวของแขกที่ผ่านรหัสผ่านแล้ว (F18)
 *
 * มีไว้เพื่อไม่ให้ต้องพิมพ์รหัสผ่านซ้ำทุกครั้งที่กดเปิดไฟล์ในโฟลเดอร์ที่แชร์
 * ไม่ได้มีไว้ให้สิทธิ์อะไรเพิ่มเลย
 */

const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

/**
 * ผู้รับที่ต่างจาก token ภายในโดยสิ้นเชิง
 *
 * jose ตรวจ audience ให้ตอน verify ใบผ่านของแขกที่ถูกส่งไปยังเส้นทางภายใน
 * จึงถูกปฏิเสธที่ชั้นลายเซ็น ไม่ใช่ที่ตรรกะซึ่งอาจมีคนเขียนพลาด
 * และ token ภายในก็ใช้เปิดลิงก์แขกไม่ได้เช่นกัน
 */
const GUEST_AUDIENCE = 's2-nas-guest-share';

/**
 * อายุสั้นมากโดยตั้งใจ
 *
 * ใบผ่านนี้เป็นสำเนาสิทธิ์ที่เซิร์ฟเวอร์ตรวจไม่ได้ว่าถูกยกเลิกไปหรือยัง
 * ยิ่งอายุยาว ช่องว่างระหว่าง "กดยกเลิก" กับ "ใช้ไม่ได้จริง" ก็ยิ่งกว้าง
 *
 * สองชั่วโมงพอสำหรับการดูเอกสารหนึ่งชุดจนจบ และสั้นพอที่จะไม่เป็นกุญแจสำรอง
 *
 * หมายเหตุสำคัญ: ใบผ่านนี้ **ไม่ได้** ข้ามการตรวจสถานะลิงก์ ทุกคำขอยังอ่านแถว
 * ในฐานข้อมูลใหม่เสมอ การยกเลิกจึงมีผลทันทีแม้ใบผ่านจะยังไม่หมดอายุ
 * ใบผ่านตอบได้เพียงคำถามเดียวคือ "คนนี้เคยพิมพ์รหัสผ่านถูกหรือไม่"
 */
const GUEST_TTL = '2h';

/** ผูกกับลิงก์เดียวเท่านั้น - ใบผ่านของลิงก์ A ใช้กับลิงก์ B ไม่ได้ */
export async function issueGuestPass(shareLinkId: string): Promise<string> {
  return new SignJWT({ kind: 'GUEST_SHARE' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(shareLinkId)
    .setIssuer('s2-nas')
    .setAudience(GUEST_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(GUEST_TTL)
    .sign(secret);
}

/** คืนค่า true เมื่อใบผ่านนี้เป็นของลิงก์นี้จริงและยังไม่หมดอายุ */
export async function guestPassValid(pass: string | undefined, shareLinkId: string): Promise<boolean> {
  if (!pass) return false;
  try {
    const { payload } = await jwtVerify(pass, secret, {
      issuer: 's2-nas',
      audience: GUEST_AUDIENCE,
    });
    return payload.sub === shareLinkId && payload.kind === 'GUEST_SHARE';
  } catch {
    // ลายเซ็นผิด หมดอายุ หรือผู้รับไม่ตรง - ทั้งหมดแปลว่า "ยังไม่ได้พิสูจน์ตัว"
    return false;
  }
}
