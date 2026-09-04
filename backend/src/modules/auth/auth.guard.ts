import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../../core/errors.js';
import { verifyAccessToken } from './auth.service.js';
import { isExternalUser } from '../portal/portal-policy.js';

/**
 * ยืนยันตัวตนอย่างเดียว ไม่ตัดสินว่าใครเข้าเส้นทางไหนได้
 *
 * ใช้กับเส้นทางที่ผู้ใช้ทุกชนิดต้องเข้าถึงได้จริง ๆ เท่านั้น
 * เช่น ข้อมูลบัญชีของตัวเองและการเปลี่ยนรหัสผ่าน
 * เส้นทางอื่นต้องเลือกด่านที่ระบุชนิดผู้ใช้ให้ชัดเจน
 */
export async function authenticate(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  request.authUser = await verifyAccessToken(header.slice(7));
}

/**
 * ด่านของพื้นที่ทำงานภายใน
 *
 * ผู้ใช้ภายนอกถูกปฏิเสธที่นี่ ก่อนที่คำขอจะไปถึงตรรกะของโมดูลใด ๆ
 * นี่คือเหตุผลที่ผู้ใช้ภายนอกที่เผลอได้รับบทบาทภายในกว้าง ๆ ก็ยังเข้าไม่ได้อยู่ดี
 * การตรวจสิทธิ์รายทรัพยากรเป็นชั้นที่สอง ไม่ใช่ชั้นเดียว
 */
export async function requireInternal(request: FastifyRequest): Promise<void> {
  await authenticate(request);
  if (isExternalUser(request.authUser)) {
    throw forbidden('บัญชีนี้เข้าถึงได้เฉพาะพื้นที่เอกสารสำหรับลูกค้า');
  }
}

/** ด่านของพื้นที่เอกสารสำหรับลูกค้า - เฉพาะบัญชีภายนอกเท่านั้น */
export async function requireExternal(request: FastifyRequest): Promise<void> {
  await authenticate(request);
  if (!isExternalUser(request.authUser)) {
    throw forbidden('พื้นที่นี้สำหรับผู้ใช้งานภายนอกเท่านั้น');
  }
}

export function requirePermission(code: string) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    // สิทธิ์ภายในต้องเป็นบัญชีภายในก่อนเสมอ ชื่อบทบาทเพียงอย่างเดียวไม่พอ
    await requireInternal(request);
    if (!request.authUser?.permissions.includes(code)) throw forbidden();
  };
}
