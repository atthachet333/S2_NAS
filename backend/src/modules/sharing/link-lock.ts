/**
 * Link Lock - ลิงก์ไม่ใช่กุญแจ (Login Required)
 *
 * **กติกาใหม่ของทั้งระบบ: ไม่มีคำขอที่ไม่ระบุตัวตนใดได้ไบต์ของเอกสาร**
 *
 * เดิมลิงก์แชร์สาธารณะเป็นทั้ง "ที่อยู่" และ "สิทธิ์" ในตัวเดียวกัน ใครถือ URL ก็เปิดเอกสารได้
 * ซึ่งแปลว่าลิงก์ที่หลุดไปอยู่ในแชท อีเมลที่ส่งต่อ หรือประวัติเบราว์เซอร์ของเครื่องที่ใช้ร่วมกัน
 * กลายเป็นกุญแจถาวรที่เพิกถอนได้ก็ต่อเมื่อมีคนนึกได้ว่าต้องเพิกถอน
 *
 * ตั้งแต่เฟสนี้ ลิงก์ทำหน้าที่เดียวคือ **บอกว่าปลายทางคือเอกสารไหน**
 * ส่วนสิทธิ์มาจากตัวผู้ใช้ที่เข้าสู่ระบบแล้วเท่านั้น ผ่านด่านเดิมทุกด่าน
 *
 * **การเข้าสู่ระบบจำเป็น แต่ไม่เพียงพอ** ลิงก์สาธารณะไม่เคยมอบสิทธิ์ที่ผู้ใช้คนนั้นไม่มีอยู่แล้ว
 * ผู้ใช้ภายในถูกตัดสินด้วย capabilities() ตามปกติ ผู้ใช้ภายนอกถูกตัดสินด้วยด่านพื้นที่ลูกค้า
 * ซึ่งรวมสิทธิ์ที่มอบด้วยมือ ชั้นทับจากคำขอความร่วมมือ และเพดานชั้นความลับไว้แล้ว
 */
import type { FastifyRequest } from 'fastify';
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import { verifyAccessToken, type AuthUser } from '../auth/auth.service.js';
import { capabilities, resourceInclude } from '../resources/resource.service.js';
import { resolvePortalAccess } from '../portal/portal-access.js';
import { resolveShareByToken, shareUnavailable, type ResolvedShare } from './guest-access.js';

/**
 * ยังไม่ได้เข้าสู่ระบบ - แยกจาก "เข้าสู่ระบบแล้วแต่ไม่มีสิทธิ์" อย่างเด็ดขาด
 *
 * สองกรณีนี้ต้องการการกระทำคนละอย่างจากผู้ใช้: อย่างแรกให้เข้าสู่ระบบ อย่างที่สอง
 * ให้ติดต่อผู้ดูแล การยุบเป็นรหัสเดียวทำให้หน้าจอบอกทางออกที่ผิดให้คนครึ่งหนึ่งเสมอ
 */
export const loginRequired = (): AppError =>
  new AppError('LOGIN_REQUIRED', 'กรุณาเข้าสู่ระบบเพื่อเข้าถึงเอกสารนี้', 401);

/** เข้าสู่ระบบแล้ว แต่บัญชีนี้ไม่มีสิทธิ์ */
export const accessDenied = (): AppError =>
  new AppError('ACCESS_DENIED', 'บัญชีนี้ไม่มีสิทธิ์เข้าถึงเอกสาร', 403);

/**
 * ด่านของทุกเส้นทางที่เคยเปิดให้แขก
 *
 * **ตอบแบบทั่วไปที่สุดเมื่อยังไม่ได้เข้าสู่ระบบ** - ไม่บอกว่าโทเคนมีอยู่จริงไหม
 * ไม่บอกว่าลิงก์หมดอายุหรือถูกเพิกถอน และไม่บอกว่าเอกสารมีอยู่หรือไม่
 *
 * ที่ต้องเป็นอย่างนี้เพราะการบอกสถานะลิงก์ให้คนที่ยังไม่ได้เข้าสู่ระบบ เท่ากับมอบเครื่องมือ
 * ตรวจว่าโทเคนที่สุ่มมาใช้ได้หรือไม่ ซึ่งเป็นสิ่งเดียวกับที่นโยบายไม่เปิดเผยของฝั่งแขก
 * พยายามปิดมาตลอด การล็อกลิงก์แล้วเปิดช่องตรวจสอบสถานะแทน คือการย้ายรูรั่ว ไม่ใช่ปิดมัน
 *
 * ไม่แตะฐานข้อมูลเลยก่อนรู้ว่าผู้เรียกเป็นใคร - คำขอของบอตที่ยิงโทเคนมั่วจึงราคาถูกที่สุด
 * เท่าที่จะเป็นไปได้ ไม่มีการอ่านไฟล์ ไม่มีการเรียกผู้ให้บริการที่เก็บ ไม่มีการไล่โฟลเดอร์
 */
export async function requireLogin(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw loginRequired();
  try {
    request.authUser = await verifyAccessToken(header.slice(7));
  } catch {
    /*
     * โทเคนหมดอายุนับเป็น "ยังไม่ได้เข้าสู่ระบบ" ไม่ใช่ "ไม่มีสิทธิ์"
     * ผู้ใช้ที่นั่งอยู่หน้าจอนานจนเซสชันหมดต้องได้หน้าเข้าสู่ระบบพร้อมปลายทางเดิม
     * ไม่ใช่หน้าปฏิเสธที่ทำให้เข้าใจว่าถูกถอนสิทธิ์
     */
    throw loginRequired();
  }
}

export interface ShareResolution {
  share: ResolvedShare;
  /** ผู้ใช้คนนี้ดาวน์โหลดได้จริงหรือไม่ - ต้องผ่านทั้งลิงก์และสิทธิ์ของตัวเอง */
  allowDownload: boolean;
  /** ดูตัวอย่างได้หรือไม่ - เงื่อนไขเดียวกัน */
  allowPreview: boolean;
}

/**
 * แปลงลิงก์เป็นเอกสาร แล้วตัดสินด้วยสิทธิ์ของผู้ใช้ที่เข้าสู่ระบบแล้ว
 *
 * ลำดับมีความหมาย:
 *   1. สถานะลิงก์ต้องยังใช้ได้ (หมดอายุ/ถูกเพิกถอน/ติดชั้นความลับ ยังตายเหมือนเดิม)
 *      การเข้าสู่ระบบไม่ปลุกลิงก์ที่ตายแล้วให้ฟื้น
 *   2. ผู้ใช้ต้องมีสิทธิ์บนเอกสารนั้นด้วยตัวเอง
 *
 * ข้อ 2 คือหัวใจ: ลิงก์ไม่เพิ่มสิทธิ์ให้ใครเลย มันแค่พาไปถึงที่
 */
export async function resolveShareForUser(
  user: AuthUser,
  token: string,
): Promise<ShareResolution> {
  // (1) สถานะลิงก์ - ใช้เส้นทางเดิมทุกประการ รวมถึงเพดานชั้นความลับของ F25-D
  const share = await resolveShareByToken(token);

  // (2) สิทธิ์ของผู้ใช้เอง
  if (user.type === 'EXTERNAL') {
    /*
     * ผู้ใช้ภายนอกผ่านด่านพื้นที่ลูกค้า ซึ่งรวมสิทธิ์ที่มอบด้วยมือ ชั้นทับจากคำขอความร่วมมือ
     * วงจรชีวิตเอกสาร และเพดานชั้นความลับไว้ในที่เดียวแล้ว (F26-A1/B1)
     * ลิงก์สาธารณะจึงข้ามขอบเขตของงานหรือของสิทธิ์ที่ได้รับไม่ได้
     */
    try {
      const access = await resolvePortalAccess(user.id, share.resource.id);
      return {
        share,
        allowPreview: share.link.allowPreview,
        // ดาวน์โหลดต้องได้ทั้งจากลิงก์และจากสิทธิ์ของตัวเอง - การเข้าสู่ระบบไม่ใช่ใบอนุญาตดาวน์โหลด
        allowDownload: share.link.allowDownload && access.allowDownload,
      };
    } catch {
      throw accessDenied();
    }
  }

  /*
   * ผู้ใช้ภายในถูกตัดสินด้วย capabilities() ตามปกติ
   *
   * ลิงก์สาธารณะไม่ทำให้พนักงานที่เปิดเอกสารนี้ไม่ได้อยู่แล้วเปิดได้ขึ้นมา
   * มิฉะนั้นการสร้างลิงก์หนึ่งครั้งจะกลายเป็นการเปิดเอกสารให้ทั้งองค์กรโดยไม่ตั้งใจ
   */
  const resource = await prisma.resource.findUnique({
    where: { id: share.resource.id },
    include: resourceInclude,
  });
  if (!resource || resource.deletedAt) throw shareUnavailable();

  const caps = capabilities(resource, user);
  if (!caps.canView) throw accessDenied();

  return {
    share,
    allowPreview: share.link.allowPreview,
    allowDownload: share.link.allowDownload && caps.canDownload,
  };
}
