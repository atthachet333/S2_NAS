import bcrypt from 'bcryptjs';
import type { PublicShareLink, Resource } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../core/prisma.js';
import { AppError, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { capabilities } from '../resources/resource.service.js';
import { resourceInclude, type AuditContext } from '../workspace/workspace.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import { generateShareToken, hashShareToken, shareUrl } from './share-token.js';
import { CLASSIFICATION_LABEL, allowsAnonymousLink } from '../governance/classification.policy.js';

/**
 * ลิงก์แชร์ภายนอก (F18)
 *
 * ให้คนที่ไม่มีบัญชี S2 NAS เปิดเอกสารที่เราตั้งใจส่งให้ได้ โดยไม่ต้องสร้างบัญชีให้เขา
 *
 * **ไม่ใช่พื้นที่ลูกค้า** พื้นที่ลูกค้าคือความสัมพันธ์ระยะยาวกับคนที่ระบบรู้จักชื่อ
 * ที่นี่คือการส่งเอกสารหนึ่งฉบับให้คนหนึ่งครั้ง แล้วปิดประตูตามหลัง
 * สองอย่างนี้มีสถาปัตยกรรมแยกกันโดยตั้งใจ และต้องไม่ไหลมาปนกัน
 */

/** ค่าเริ่มต้นที่ปลอดภัย - เปิดดูได้ ดาวน์โหลดไม่ได้ หมดอายุใน 7 วัน */
export const DEFAULT_EXPIRY_DAYS = 7;

/**
 * เพดานอายุของลิงก์
 *
 * ใช้เกณฑ์เดียวกับการแชร์ภายใน เพื่อไม่ให้มีสองมาตรฐานในระบบเดียว
 */
const MAX_EXPIRY_DAYS = 730;

/**
 * เพดานจำนวนลิงก์ที่ยังใช้งานได้ต่อทรัพยากรหนึ่งชิ้น
 *
 * ลิงก์ที่ยังเปิดอยู่คือประตูที่ยังไม่ได้ล็อก สิบกว่าบานต่อเอกสารหนึ่งฉบับ
 * แปลว่าไม่มีใครรู้แล้วว่าใครเข้าถึงอะไรได้บ้าง ซึ่งเป็นสภาพที่ตรวจสอบไม่ได้
 */
export const MAX_ACTIVE_LINKS_PER_RESOURCE = 20;

/** สถานะที่คำนวณจากข้อมูลจริงเสมอ ไม่เก็บซ้ำในฐานข้อมูลเพราะจะเพี้ยนจากความจริง */
export type ShareStatus =
  | 'ACTIVE'
  | 'EXPIRED'
  | 'REVOKED'
  | 'LIMIT_REACHED'
  | 'RESOURCE_UNAVAILABLE'
  /** ถูกปิดด้วยนโยบายชั้นความลับ - แถวยังอยู่ ไม่ได้ถูกลบ (F25-D) */
  | 'CLASSIFICATION_RESTRICTED';

/* ------------------------------------------------------------------ */
/* สิทธิ์ในการสร้าง                                                     */
/* ------------------------------------------------------------------ */

/**
 * ใครสร้างลิงก์แชร์ภายนอกได้
 *
 * ใช้ความสามารถ canShare ที่มีอยู่แล้ว ไม่สร้างระบบสิทธิ์ชุดที่สอง
 *
 * เหตุผล: "ใครควบคุมได้ว่าใครเข้าถึงเอกสารนี้" เป็นคำถามเดียวกันไม่ว่าคนนั้น
 * จะมีบัญชีหรือไม่ ถ้าแยกเป็นสองระบบ วันหนึ่งจะมีคนที่แชร์ภายในไม่ได้
 * แต่ปล่อยลิงก์สาธารณะได้ ซึ่งกลับหัวกลับหางจากเจตนา
 *
 * ผลที่ตามมา: VIEWER สร้างไม่ได้ ส่วน EDITOR สร้างไม่ได้เช่นกันเว้นแต่มี
 * resources:share ตามนโยบายการแชร์เดิม
 */
export function canCreatePublicShare(
  resource: Parameters<typeof capabilities>[0],
  user: AuthUser,
): boolean {
  return capabilities(resource, user).canShare;
}

/* ------------------------------------------------------------------ */
/* สถานะ                                                              */
/* ------------------------------------------------------------------ */

/**
 * สถานะของทรัพยากรที่จำเป็นต่อการตัดสินสถานะลิงก์
 *
 * classification เป็นฟิลด์บังคับโดยตั้งใจ ไม่ใช่ทางเลือก ถ้าปล่อยให้เป็นทางเลือก
 * จุดเรียกที่ลืม select มันจะข้ามการบังคับใช้นโยบายไปเงียบ ๆ ซึ่งเป็นการเปิดช่องแบบ fail-open
 * การบังคับให้มีทำให้คอมไพเลอร์จับจุดที่ลืมได้ตั้งแต่ตอน build
 */
type ResourceState = Pick<Resource, 'deletedAt' | 'lifecycleState' | 'classification'>;

/**
 * ทรัพยากรอยู่ในสภาพที่ให้คนนอกเห็นได้หรือไม่
 *
 * ถังขยะและคลังเอกสารต่างก็ทำให้ลิงก์ใช้ไม่ได้ทันที แต่ด้วยเหตุผลคนละอย่าง:
 * ถังขยะแปลว่า "ตั้งใจจะทิ้ง" ส่วนคลังแปลว่า "งานชิ้นนี้จบแล้ว"
 * ทั้งสองอย่างเป็นสัญญาณว่าเอกสารไม่ควรอยู่ในมือคนนอกอีกต่อไป
 *
 * ไม่บันทึกการยกเลิกลิงก์ - ลิงก์ยังมีชีวิตอยู่ เพียงแต่ประตูปิดชั่วคราว
 * ถ้าเอกสารกลับมาใช้งานได้ ลิงก์ที่ยังไม่หมดอายุและไม่ถูกยกเลิกก็ใช้ได้อีก
 */
/**
 * ความพร้อมของทรัพยากรสำหรับแขก - เรื่องของการมีอยู่ ไม่ใช่เรื่องของนโยบาย
 *
 * รับเฉพาะสิ่งที่ใช้จริง ไม่ผูกกับ ResourceState ที่กว้างกว่า เพื่อให้จุดเรียกที่ไล่สายบรรพบุรุษ
 * ไม่ต้องดึงชั้นความลับของทุกชั้นมาโดยไม่จำเป็น การบังคับใช้ชั้นความลับอยู่ที่ shareStatus
 * ซึ่งตัดสินจากทรัพยากรที่ลิงก์ชี้ถึงโดยตรง
 */
export function resourceAvailableToGuests(
  resource: Pick<Resource, 'deletedAt' | 'lifecycleState'>,
): boolean {
  return resource.deletedAt === null && resource.lifecycleState === 'ACTIVE';
}

/**
 * ทรัพยากรนี้ปรากฏต่อผู้เยี่ยมชมที่ไม่ระบุตัวตนได้หรือไม่ (F25-D)
 *
 * ต่างจาก resourceAvailableToGuests ตรงที่รวมนโยบายชั้นความลับเข้ามาด้วย ใช้กับ **ทุกชั้น
 * ที่อยู่ใต้รากของลิงก์** ไม่ใช่เฉพาะตัวรากที่ shareStatus ตรวจไปแล้ว
 *
 * **ช่องโหว่ที่ฟังก์ชันนี้ปิด:** ลิงก์สาธารณะที่ชี้ไปที่โฟลเดอร์ยอมให้แขกไต่ลงไปดูลูกหลานได้
 * ถ้าตรวจชั้นความลับเฉพาะที่ราก โฟลเดอร์ที่ตั้งเป็นสาธารณะจะกลายเป็นประตูที่เปิดเอกสารชั้น
 * ภายใน และ ลับ ทุกฉบับข้างในออกสู่สาธารณะ ทั้งที่ไม่มีใครตั้งใจเปิดเอกสารเหล่านั้นเลย
 *
 * ชั้นความลับในระบบนี้ไม่สืบทอดลงล่างโดยเจตนา ทุกฉบับตอบเรื่องการเปิดเผยของตัวเอง
 * กฎนี้จึงเป็นด้านกลับที่ขาดไม่ได้: โฟลเดอร์ที่เปิดกว้างไม่ทำให้ลูกที่ปิดอยู่เปิดตามไปด้วย
 */
export function resourceExposableToGuests(resource: ResourceState): boolean {
  return resourceAvailableToGuests(resource) && allowsAnonymousLink(resource.classification);
}

export function shareStatus(
  link: PublicShareLink,
  resource: ResourceState | null,
  now: Date = new Date(),
): ShareStatus {
  if (link.revokedAt) return 'REVOKED';
  if (link.expiresAt && link.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (link.maxViews !== null && link.viewCount >= link.maxViews) return 'LIMIT_REACHED';
  if (!link.allowPreview && link.allowDownload && link.maxDownloads !== null && link.downloadCount >= link.maxDownloads) return 'LIMIT_REACHED';
  if (!link.allowPreview && !link.allowDownload) return 'LIMIT_REACHED';
  /**
   * นโยบายชั้นความลับปิดลิงก์ทันทีโดยไม่ต้องลบแถว (F25-D)
   *
   * วางไว้หลังสถานะที่มนุษย์เป็นคนกด (เพิกถอน/หมดอายุ/ใช้ครบโควตา) เพราะถ้าลิงก์ถูกเพิกถอน
   * ไปแล้ว เหตุผลที่แท้จริงคือการเพิกถอน ไม่ใช่ชั้นความลับ การรายงานสาเหตุที่ใกล้ความจริงที่สุด
   * สำคัญกว่าการรายงานสาเหตุที่เข้มงวดที่สุด
   */
  if (resource && !allowsAnonymousLink(resource.classification)) {
    return 'CLASSIFICATION_RESTRICTED';
  }
  if (!resource || !resourceAvailableToGuests(resource)) return 'RESOURCE_UNAVAILABLE';
  return 'ACTIVE';
}

/* ------------------------------------------------------------------ */
/* สร้าง                                                              */
/* ------------------------------------------------------------------ */

export interface CreateShareInput {
  allowPreview?: boolean;
  allowDownload?: boolean;
  expiresAt?: Date | null;
  password?: string | null;
  maxViews?: number | null;
  maxDownloads?: number | null;
  label?: string | null;
}

export interface CreatedShare {
  link: PublicShareLinkDto;
  /** ปรากฏครั้งเดียวในชีวิตของลิงก์นี้ ไม่มีเส้นทางใดอ่านกลับได้อีก */
  url: string;
}

function normalizeExpiry(value: Date | null | undefined, now: Date): Date | null {
  // ไม่ระบุ = ใช้ค่าเริ่มต้น 7 วัน ส่วน null ที่ตั้งใจส่งมา = ไม่หมดอายุ
  if (value === undefined) {
    return new Date(now.getTime() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  }
  if (value === null) return null;

  if (Number.isNaN(value.getTime())) {
    throw new AppError('SHARE_INVALID_EXPIRY', 'วันหมดอายุไม่ถูกต้อง', 400);
  }
  if (value.getTime() <= now.getTime()) {
    throw new AppError('SHARE_INVALID_EXPIRY', 'วันหมดอายุต้องอยู่ในอนาคต', 400);
  }
  if (value.getTime() > now.getTime() + MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000) {
    throw new AppError(
      'SHARE_INVALID_EXPIRY',
      `วันหมดอายุต้องไม่เกิน ${MAX_EXPIRY_DAYS} วันนับจากวันนี้`,
      400,
    );
  }
  return value;
}

function normalizeLimit(value: number | null | undefined, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new AppError('SHARE_INVALID_LIMIT', `${field} ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป`, 400);
  }
  return value;
}

export async function createPublicShare(
  resourceId: string,
  user: AuthUser,
  input: CreateShareInput,
  audit: AuditContext,
): Promise<CreatedShare> {
  const resource = await prisma.resource.findFirst({
    where: { id: resourceId },
    include: resourceInclude,
  });
  if (!resource) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');

  const caps = capabilities(resource, user);
  if (!caps.canView) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  if (!caps.canShare) {
    throw new AppError('PUBLIC_SHARE_DENIED', 'ไม่มีสิทธิ์สร้างลิงก์แชร์ภายนอกของทรัพยากรนี้', 403);
  }

  /**
   * เอกสารในถังขยะและในคลังสร้างลิงก์ใหม่ไม่ได้
   *
   * ทั้งสองสถานะแปลว่ามีคนตัดสินใจแล้วว่าเอกสารนี้ไม่ได้อยู่ในการใช้งานประจำวัน
   * การเปิดประตูให้คนนอกในจังหวะนั้นย้อนแย้งกับการตัดสินใจที่เพิ่งเกิดขึ้น
   * ถ้าตั้งใจจะแชร์จริง ให้เอาออกจากคลังก่อน ซึ่งเป็นการตัดสินใจที่มีร่องรอย
   */
  if (resource.deletedAt) {
    throw new AppError('SHARE_RESOURCE_TRASHED', 'ทรัพยากรอยู่ในถังขยะ สร้างลิงก์ไม่ได้', 409);
  }
  if (resource.lifecycleState !== 'ACTIVE') {
    throw new AppError(
      'SHARE_RESOURCE_ARCHIVED',
      'ทรัพยากรถูกเก็บเข้าคลัง ต้องนำออกจากคลังก่อนจึงจะสร้างลิงก์ได้',
      409,
    );
  }
  /**
   * ชั้นความลับปิดกั้นตั้งแต่ตอนสร้าง ไม่ใช่ปล่อยให้สร้างแล้วค่อยตายทีหลัง (F25-D)
   *
   * shareStatus จะตอบ CLASSIFICATION_RESTRICTED อยู่แล้วถ้าปล่อยให้สร้างผ่าน แต่ผลลัพธ์คือ
   * ผู้ใช้ได้ลิงก์มาในมือ ส่งให้ลูกค้า แล้วลูกค้ากดไม่ได้ ระบบที่ยอมให้สร้างสิ่งที่ตัวเองจะปฏิเสธ
   * ในวินาทีถัดไป คือระบบที่โยนความผิดพลาดของตัวเองไปให้ผู้ใช้เจอกับลูกค้า
   *
   * ข้อความบอกทางออกที่ทำได้จริง แทนที่จะบอกแค่ว่าไม่ได้
   */
  if (!allowsAnonymousLink(resource.classification)) {
    throw new AppError(
      'SHARE_CLASSIFICATION_RESTRICTED',
      `เอกสารชั้น "${CLASSIFICATION_LABEL[resource.classification]}" สร้างลิงก์สาธารณะไม่ได้ ต้องปรับชั้นความลับเป็น "${CLASSIFICATION_LABEL.PUBLIC}" ก่อน`,
      409,
    );
  }

  if (resource.type !== 'FILE' && resource.type !== 'FOLDER') {
    throw new AppError(
      'SHARE_UNSUPPORTED_TYPE',
      'แชร์ภายนอกได้เฉพาะไฟล์และโฟลเดอร์',
      400,
    );
  }

  const now = new Date();
  const expiresAt = normalizeExpiry(input.expiresAt, now);
  const maxViews = normalizeLimit(input.maxViews, 'จำนวนครั้งที่เปิดได้');
  const maxDownloads = normalizeLimit(input.maxDownloads, 'จำนวนครั้งที่ดาวน์โหลดได้');

  const allowPreview = input.allowPreview ?? true;
  const allowDownload = input.allowDownload ?? false;
  if (!allowPreview && !allowDownload) {
    throw new AppError(
      'SHARE_NO_PERMISSION',
      'ลิงก์ต้องอนุญาตอย่างน้อยการดูตัวอย่างหรือการดาวน์โหลด',
      400,
    );
  }

  const existingLinks = await prisma.publicShareLink.findMany({ where: { resourceId } });
  const active = existingLinks.filter((link) => shareStatus(link, resource, now) === 'ACTIVE').length;
  if (active >= MAX_ACTIVE_LINKS_PER_RESOURCE) {
    throw new AppError(
      'SHARE_TOO_MANY_LINKS',
      `ทรัพยากรนี้มีลิงก์ที่ยังใช้งานได้ครบ ${MAX_ACTIVE_LINKS_PER_RESOURCE} ลิงก์แล้ว`,
      409,
    );
  }

  const token = generateShareToken();
  const passwordHash = input.password ? await bcrypt.hash(input.password, 12) : null;

  const link = await prisma.publicShareLink.create({
    data: {
      resourceId,
      // โทเคนดิบไม่เคยไปถึงฐานข้อมูล - มันมีชีวิตอยู่ในตัวแปรนี้และใน URL ที่คืนกลับเท่านั้น
      tokenHash: hashShareToken(token),
      label: input.label?.trim() || null,
      createdById: user.id,
      expiresAt,
      allowPreview,
      allowDownload,
      passwordHash,
      maxViews,
      maxDownloads,
    },
  });

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: 'PUBLIC_SHARE_CREATED',
      resourceId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: {
        shareLinkId: link.id,
        allowPreview,
        allowDownload,
        /**
         * ตั้งใจไม่ใช้ชื่อที่มีคำว่า password
         *
         * ชั้นกันความลับของ F17 ปฏิเสธทุกคีย์ที่มีคำว่า password/hash/token อยู่ข้างใน
         * ไม่ว่าค่าจะเป็นอะไร ซึ่งถูกต้องแล้ว - กฎที่ยอมยกเว้นให้กรณีที่ "ปลอดภัยแน่นอน"
         * คือกฎที่วันหนึ่งจะยกเว้นให้กรณีที่ไม่ปลอดภัยด้วย
         *
         * ค่านี้เป็นเพียงบูลีนว่ามีรหัสผ่านหรือไม่ จึงเปลี่ยนชื่อฟิลด์แทนการผ่อนกฎ
         */
        hasAccessCode: passwordHash !== null,
        expiresAt: expiresAt?.toISOString() ?? null,
        maxViews,
        maxDownloads,
      },
    },
  });

  logger.info(`[SHARE] สร้างลิงก์แชร์ภายนอกของ "${resource.name}" โดย ${user.email}`);

  return {
    link: toShareDto(link, resource),
    url: shareUrl(env.publicBaseUrl, token),
  };
}

/* ------------------------------------------------------------------ */
/* ยกเลิก                                                             */
/* ------------------------------------------------------------------ */

export async function revokePublicShare(
  shareLinkId: string,
  user: AuthUser,
  audit: AuditContext,
): Promise<PublicShareLinkDto> {
  const link = await prisma.publicShareLink.findUnique({
    where: { id: shareLinkId },
    include: { resource: { include: resourceInclude } },
  });
  if (!link) throw notFound('SHARE_LINK_NOT_FOUND', 'ไม่พบลิงก์แชร์นี้');

  /**
   * สิทธิ์ยกเลิกผูกกับทรัพยากร ไม่ใช่กับผู้สร้าง
   *
   * คนที่สร้างลิงก์อาจลาออกไปแล้ว ถ้าผูกไว้กับตัวบุคคล จะเหลือลิงก์ที่เปิดอยู่
   * โดยไม่มีใครปิดได้ - ซึ่งแย่กว่าการที่เพื่อนร่วมงานปิดลิงก์ของกันและกันได้
   */
  const caps = capabilities(link.resource, user);
  if (!caps.canView) throw notFound('SHARE_LINK_NOT_FOUND', 'ไม่พบลิงก์แชร์นี้');
  if (!caps.canShare) {
    throw new AppError('PUBLIC_SHARE_DENIED', 'ไม่มีสิทธิ์ยกเลิกลิงก์แชร์นี้', 403);
  }

  if (link.revokedAt) return toShareDto(link, link.resource);

  const updated = await prisma.publicShareLink.update({
    where: { id: shareLinkId },
    data: { revokedAt: new Date(), revokedById: user.id },
  });

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: 'PUBLIC_SHARE_REVOKED',
      resourceId: link.resourceId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: { shareLinkId, viewCount: link.viewCount, downloadCount: link.downloadCount },
    },
  });

  logger.info(`[SHARE] ยกเลิกลิงก์แชร์ภายนอก ${shareLinkId} โดย ${user.email}`);
  return toShareDto(updated, link.resource);
}

/* ------------------------------------------------------------------ */
/* อ่านรายการ                                                          */
/* ------------------------------------------------------------------ */

export interface PublicShareLinkDto {
  id: string;
  resourceId: string;
  resourceName: string;
  resourceType: string;
  label: string | null;
  status: ShareStatus;
  allowPreview: boolean;
  allowDownload: boolean;
  passwordProtected: boolean;
  expiresAt: string | null;
  maxViews: number | null;
  viewCount: number;
  maxDownloads: number | null;
  downloadCount: number;
  createdAt: string;
  revokedAt: string | null;
  lastAccessedAt: string | null;
}

/**
 * แปลงเป็นข้อมูลที่ส่งออกได้
 *
 * **ไม่มี tokenHash และไม่มี passwordHash อยู่ในผลลัพธ์นี้เลย** ทั้งสองค่าเป็นความลับ
 * ที่ไม่มีเหตุผลใดให้ออกจากเซิร์ฟเวอร์ หน้าจอต้องการรู้แค่ว่า "มีรหัสผ่านไหม"
 * ซึ่งเป็นบูลีน ไม่ใช่ตัวค่า
 */
export function toShareDto(
  link: PublicShareLink,
  resource: (ResourceState & { name: string; type: string }) | null,
): PublicShareLinkDto {
  return {
    id: link.id,
    resourceId: link.resourceId,
    resourceName: resource?.name ?? 'ทรัพยากรถูกลบแล้ว',
    resourceType: resource?.type ?? 'UNKNOWN',
    label: link.label,
    status: shareStatus(link, resource),
    allowPreview: link.allowPreview,
    allowDownload: link.allowDownload,
    passwordProtected: link.passwordHash !== null,
    expiresAt: link.expiresAt?.toISOString() ?? null,
    maxViews: link.maxViews,
    viewCount: link.viewCount,
    maxDownloads: link.maxDownloads,
    downloadCount: link.downloadCount,
    createdAt: link.createdAt.toISOString(),
    revokedAt: link.revokedAt?.toISOString() ?? null,
    lastAccessedAt: link.lastAccessedAt?.toISOString() ?? null,
  };
}

/** ลิงก์ทั้งหมดของทรัพยากรหนึ่งชิ้น - สำหรับแผงจัดการของผู้สร้าง */
export async function listResourceShares(
  resourceId: string,
  user: AuthUser,
): Promise<PublicShareLinkDto[]> {
  const resource = await prisma.resource.findFirst({
    where: { id: resourceId },
    include: resourceInclude,
  });
  if (!resource) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');

  const caps = capabilities(resource, user);
  if (!caps.canView) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  if (!caps.canShare) {
    throw new AppError('PUBLIC_SHARE_DENIED', 'ไม่มีสิทธิ์ดูลิงก์แชร์ภายนอกของทรัพยากรนี้', 403);
  }

  const links = await prisma.publicShareLink.findMany({
    where: { resourceId },
    orderBy: { createdAt: 'desc' },
  });
  return links.map((link) => toShareDto(link, resource));
}
