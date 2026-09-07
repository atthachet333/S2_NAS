import bcrypt from 'bcryptjs';
import type { PublicShareLink, ResourceLifecycleState, ResourceType } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import type { AuditContext } from '../workspace/workspace.service.js';
import { hashShareToken } from './share-token.js';
import { resourceAvailableToGuests, shareStatus } from './public-share.service.js';

/**
 * การเข้าถึงของแขก (F18)
 *
 * ทุกคำขอที่มาจากลิงก์แชร์ต้องผ่านไฟล์นี้ก่อนเสมอ ไม่มีข้อยกเว้น
 *
 * ผู้ถือโทเคนไม่ใช่ผู้ใช้ของระบบ ไม่มี AuthUser ไม่มี session ภายใน
 * และไม่มีทางกลายเป็นผู้ใช้ได้ สิทธิ์ทั้งหมดที่เขามีคือสิ่งที่เขียนไว้บนแถวลิงก์นั้น
 */

/**
 * คำตอบเดียวสำหรับทุกความล้มเหลว
 *
 * โทเคนผิด ลิงก์ถูกยกเลิก ลิงก์หมดอายุ เอกสารถูกลบ - ทั้งหมดตอบเหมือนกันหมด
 *
 * ถ้าตอบต่างกัน ผู้ที่สุ่มโทเคนมาเรื่อย ๆ จะแยกออกว่า "โทเคนนี้เคยมีอยู่จริง
 * แต่หมดอายุ" กับ "ไม่เคยมี" ซึ่งเป็นข้อมูลที่ช่วยเขาได้จริงในการค้นหาต่อ
 * และในกรณีเอกสารที่ถูกลบ ยังเป็นการยืนยันว่าเคยมีเอกสารนั้นอยู่
 */
export function shareUnavailable(): AppError {
  return new AppError('SHARE_UNAVAILABLE', 'ลิงก์นี้ไม่สามารถใช้งานได้แล้ว', 404);
}

/**
 * บริบทของแขกหนึ่งคำขอ - เป็นตัวตนของมันเอง ไม่ใช่ผู้ใช้ที่ถูกลดสิทธิ์
 *
 * ตั้งชื่อชนิดไว้ชัด ๆ เพื่อให้อ่านโค้ดแล้วเห็นทันทีว่ากำลังอยู่ในเส้นทางของแขก
 * และเพื่อให้ TypeScript ปฏิเสธการส่งค่านี้เข้าฟังก์ชันที่ต้องการ AuthUser
 */
export interface GuestPrincipal {
  readonly kind: 'GUEST_SHARE';
  readonly shareLinkId: string;
  readonly rootResourceId: string;
  readonly allowPreview: boolean;
  readonly allowDownload: boolean;
}

export interface ResolvedShare {
  link: PublicShareLink;
  guest: GuestPrincipal;
  resource: {
    id: string;
    type: ResourceType;
    name: string;
    mimeType: string | null;
    extension: string | null;
    size: bigint | null;
    parentId: string | null;
    deletedAt: Date | null;
    lifecycleState: ResourceLifecycleState;
  };
}

const guestResourceSelect = {
  id: true,
  type: true,
  name: true,
  mimeType: true,
  extension: true,
  size: true,
  parentId: true,
  deletedAt: true,
  lifecycleState: true,
} as const;

/**
 * หาลิงก์จากโทเคนและตรวจว่ายังใช้งานได้
 *
 * **ตรวจใหม่ทุกครั้งที่มีคำขอ** ไม่มีการจำผลไว้ ไม่มี session ที่ข้ามการตรวจนี้ได้
 * นี่คือเหตุผลที่การยกเลิกลิงก์มีผลทันที: คำขอถัดไปอ่านแถวเดิมแล้วเห็น revokedAt
 */
export async function resolveShareByToken(token: string): Promise<ResolvedShare> {
  const link = await prisma.publicShareLink.findUnique({
    where: { tokenHash: hashShareToken(token) },
  });
  if (!link) throw shareUnavailable();

  const resource = await prisma.resource.findUnique({
    where: { id: link.resourceId },
    select: guestResourceSelect,
  });

  if (shareStatus(link, resource) !== 'ACTIVE') throw shareUnavailable();
  // shareStatus รับประกันแล้วว่าไม่ null แต่ TypeScript ยังไม่รู้
  if (!resource) throw shareUnavailable();

  return {
    link,
    resource,
    guest: {
      kind: 'GUEST_SHARE',
      shareLinkId: link.id,
      rootResourceId: link.resourceId,
      allowPreview: link.allowPreview,
      allowDownload: link.allowDownload,
    },
  };
}

/* ------------------------------------------------------------------ */
/* รหัสผ่าน                                                            */
/* ------------------------------------------------------------------ */

export function requiresPassword(link: PublicShareLink): boolean {
  return link.passwordHash !== null;
}

/**
 * ตรวจรหัสผ่านของลิงก์
 *
 * ใช้ bcrypt ตัวเดียวกับรหัสผ่านผู้ใช้ ไม่ประดิษฐ์วิธีแฮชขึ้นใหม่
 * bcrypt เหมาะกับที่นี่เพราะรหัสผ่านมาจากมนุษย์ จึงเดาได้ง่ายและต้องการแฮชที่ช้า
 * (ต่างจากโทเคน 256 บิตที่ใช้ SHA-256 - ดูเหตุผลใน share-token.ts)
 */
export async function verifySharePassword(
  link: PublicShareLink,
  password: string,
): Promise<boolean> {
  if (!link.passwordHash) return false;
  return bcrypt.compare(password, link.passwordHash);
}

/* ------------------------------------------------------------------ */
/* ขอบเขตของโฟลเดอร์ที่แชร์                                              */
/* ------------------------------------------------------------------ */

/**
 * ความลึกสูงสุดที่ยอมไต่ขึ้นไปหาราก
 *
 * กันไม่ให้คำขอเดียวไล่โซ่ยาวไม่จำกัด และกันวงวนถ้าข้อมูลเสียหาย
 */
const MAX_DEPTH = 64;

/**
 * ทรัพยากรชิ้นนี้อยู่ในขอบเขตของลิงก์หรือไม่
 *
 * ไต่จากตัวมันขึ้นไปหาแม่ทีละชั้น จนกว่าจะเจอรากที่ลิงก์นี้แชร์ไว้
 *
 * **การตรวจอยู่ที่เซิร์ฟเวอร์ทั้งหมด** แขกส่ง id อะไรมาก็ได้ตามใจ - id ของเอกสาร
 * ในโฟลเดอร์อื่น หรือของโฟลเดอร์แม่ที่อยู่เหนือราก - ถ้ารากที่แชร์ไม่ปรากฏในสายนั้น
 * คำตอบคือ "ไม่พบ" เสมอ
 *
 * ไม่ใช้เส้นทางแบบข้อความ (path) เป็นเกณฑ์ เพราะเส้นทางเปลี่ยนเมื่อมีคนย้ายโฟลเดอร์
 * ส่วน id ของทรัพยากรไม่เปลี่ยน ลิงก์จึงรอดจากการจัดระเบียบภายในโดยไม่ต้องทำอะไร
 */
export async function resolveWithinShare(
  share: ResolvedShare,
  requestedId: string,
): Promise<{
  resource: ResolvedShare['resource'];
  /** เส้นทางนำทางที่หยุดที่รากของลิงก์ - ไม่มีชั้นใดเหนือรากปรากฏ */
  breadcrumb: Array<{ id: string; name: string }>;
}> {
  if (requestedId === share.link.resourceId) {
    return { resource: share.resource, breadcrumb: [{ id: share.resource.id, name: share.resource.name }] };
  }

  // ไฟล์ไม่มีลูก คำขอที่ชี้ไปที่อื่นจึงอยู่นอกขอบเขตเสมอ
  if (share.resource.type !== 'FOLDER') throw shareUnavailable();

  const chain: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  let cursor: string | null = requestedId;
  let target: ResolvedShare['resource'] | null = null;

  for (let depth = 0; cursor && depth < MAX_DEPTH; depth += 1) {
    if (seen.has(cursor)) break;
    seen.add(cursor);

    const node: (ResolvedShare['resource'] & { parentId: string | null }) | null =
      await prisma.resource.findUnique({ where: { id: cursor }, select: guestResourceSelect });
    if (!node) break;

    /**
     * ชั้นใดชั้นหนึ่งในสายถูกลบหรือเก็บเข้าคลัง = ทั้งกิ่งหายไปจากสายตาแขก
     *
     * ถ้าตรวจเฉพาะตัวเอกสาร การเก็บโฟลเดอร์แม่เข้าคลังจะไม่มีผลกับลูก
     * และเอกสารที่ตั้งใจเก็บพ้นสายตาก็ยังเปิดได้อยู่ผ่านลิงก์เดิม
     */
    if (!resourceAvailableToGuests(node)) throw shareUnavailable();

    target ??= node;
    chain.push({ id: node.id, name: node.name });

    if (node.id === share.link.resourceId) {
      // เจอรากแล้ว - ตัดทุกอย่างเหนือรากทิ้ง แล้วกลับด้านให้เป็นรากไปหาปลาย
      return { resource: target, breadcrumb: chain.reverse() };
    }
    cursor = node.parentId;
  }

  // ไต่จนสุดแล้วไม่เจอรากของลิงก์ - อยู่นอกขอบเขต
  throw shareUnavailable();
}

/** ลูกโดยตรงของโฟลเดอร์ในขอบเขต - เรียงโฟลเดอร์ก่อนไฟล์เหมือนหน้าจอภายใน */
export async function listShareChildren(folderId: string) {
  const children = await prisma.resource.findMany({
    where: { parentId: folderId, deletedAt: null, lifecycleState: 'ACTIVE' },
    select: guestResourceSelect,
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
    take: 500,
  });
  return children;
}

/* ------------------------------------------------------------------ */
/* ตัวนับและเพดานการใช้งาน                                               */
/* ------------------------------------------------------------------ */

/**
 * นับการเปิดหนึ่งครั้ง
 *
 * "การเปิด" หมายถึงหน้าของแขกถูกเปิดสำเร็จหนึ่งครั้ง ไม่ใช่ทุกคำขอที่วิ่งเข้ามา
 * การดูไฟล์ PDF หนึ่งฉบับสร้างคำขอช่วงข้อมูลนับสิบครั้ง ถ้านับทุกครั้ง
 * เพดาน "เปิดได้ 3 ครั้ง" จะหมดตั้งแต่คนแรกยังเลื่อนไม่ถึงหน้าสอง
 * และตัวเลขในรายงานก็จะไม่ตรงกับสิ่งที่เกิดขึ้นจริงเลย
 */
export async function countView(link: PublicShareLink): Promise<void> {
  await prisma.publicShareLink.update({
    where: { id: link.id },
    data: { viewCount: { increment: 1 }, lastAccessedAt: new Date() },
  });
}

/**
 * จองสิทธิ์ดาวน์โหลดหนึ่งครั้งแบบอะตอมมิก
 *
 * ตรวจแล้วค่อยเพิ่มในสองคำสั่งแยกกันจะพังเมื่อมีสองคำขอพร้อมกัน:
 * ทั้งคู่อ่านเห็น downloadCount = 4 จากเพดาน 5 ทั้งคู่ผ่านการตรวจ
 * แล้วทั้งคู่ก็ดาวน์โหลด กลายเป็น 6 ครั้งจากเพดาน 5
 *
 * วิธีที่ใช้คือให้ฐานข้อมูลตรวจและเพิ่มในคำสั่งเดียว: UPDATE ที่มีเงื่อนไข
 * เพดานอยู่ใน WHERE ถ้าไม่มีแถวไหนถูกแก้ แปลว่าโควตาหมดแล้ว
 * ฐานข้อมูลล็อกแถวให้เอง ผู้ชนะจึงมีได้เพียงคนเดียวเสมอ
 */
export async function reserveDownload(link: PublicShareLink): Promise<boolean> {
  const updated = await prisma.publicShareLink.updateMany({
    where: {
      id: link.id,
      revokedAt: null,
      allowDownload: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      ...(link.maxDownloads === null
        ? {}
        : { downloadCount: { lt: link.maxDownloads } }),
    },
    data: { downloadCount: { increment: 1 }, lastAccessedAt: new Date() },
  });
  return updated.count === 1;
}

/* ------------------------------------------------------------------ */
/* บันทึกกิจกรรมของแขก                                                  */
/* ------------------------------------------------------------------ */

/**
 * บันทึกเหตุการณ์ของแขก
 *
 * userId เป็น null เพราะไม่มีผู้ใช้จริง - หน้าตรวจสอบจะแสดงว่า "ระบบ"
 * ตัวตนที่แท้จริงของผู้กระทำคือ shareLinkId ซึ่งอยู่ใน metadata
 * และเป็นสิ่งเดียวที่เรารู้จริงเกี่ยวกับเขา
 */
export async function logGuestEvent(
  action: string,
  share: { link: PublicShareLink },
  audit: AuditContext,
  extra: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  await prisma.activityLog.create({
    data: {
      userId: null,
      action,
      resourceId: share.link.resourceId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: { shareLinkId: share.link.id, ...extra },
    },
  });
}

/**
 * บันทึกความพยายามใช้ลิงก์ที่ใช้ไม่ได้แล้ว
 *
 * แยกจากเส้นทางปกติเพราะตรงนี้ไม่มี ResolvedShare ให้ใช้ - ลิงก์ resolve ไม่ผ่าน
 * ยังต้องบันทึก เพราะ "มีคนพยายามเปิดลิงก์ที่ถูกยกเลิกไปแล้วสิบครั้ง" คือสัญญาณ
 */
export async function logExpiredAttempt(
  token: string,
  audit: AuditContext,
): Promise<void> {
  const link = await prisma.publicShareLink.findUnique({
    where: { tokenHash: hashShareToken(token) },
    select: { id: true, resourceId: true, revokedAt: true, expiresAt: true },
  });
  // โทเคนที่ไม่มีอยู่จริงไม่ถูกบันทึก มิฉะนั้นการยิงสุ่มจะกลายเป็นเครื่องมือถมบันทึก
  if (!link) return;

  await prisma.activityLog.create({
    data: {
      userId: null,
      action: 'PUBLIC_SHARE_EXPIRED_ACCESS_ATTEMPT',
      resourceId: link.resourceId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: {
        shareLinkId: link.id,
        reason: link.revokedAt ? 'REVOKED' : link.expiresAt ? 'EXPIRED' : 'UNAVAILABLE',
      },
    },
  });
}
