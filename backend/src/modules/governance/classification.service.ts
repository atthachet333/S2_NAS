/**
 * การกำหนดและเปลี่ยนชั้นความลับ (F25-D)
 *
 * โมดูลนี้คือ "จุดเดียว" ที่คอลัมน์ classification ถูกเขียน ไม่มีเส้นทางอื่นที่แก้ค่านี้ได้
 * เพราะถ้ามีสองทาง ทางที่สองจะเป็นทางที่ลืมบันทึกหลักฐาน
 *
 * สิ่งที่โมดูลนี้ **ไม่ทำ** โดยเจตนา:
 *
 *   - ไม่แก้ visibility ให้เอง          การเปลี่ยน visibility คือการถอนสิทธิ์ของคนที่เคยเข้าถึงได้
 *   - ไม่ลบหรือเพิกถอนสิทธิ์ที่มีอยู่      สิทธิ์ที่เคยมอบไว้ยังอยู่ครบ แต่จะ "ใช้ไม่ได้" ตามนโยบาย
 *   - ไม่ลบลิงก์สาธารณะ                  แถวลิงก์ยังอยู่เป็นหลักฐาน แต่ shareStatus จะตอบ CLASSIFICATION_RESTRICTED
 *
 * สามข้อนี้คือหลักเดียวกัน: **การจัดชั้นความลับปิดประตู ไม่ใช่ทำลายกุญแจ**
 * ถ้าผู้ดูแลตั้งผิดแล้วแก้กลับ สิ่งที่เคยมีต้องกลับมาเองโดยไม่ต้องมานั่งสร้างใหม่
 * และผู้ตรวจสอบต้องยังเห็นว่า "เคยแชร์ให้ใครไว้บ้าง" ไม่ใช่เห็นตารางว่างเปล่า
 */
import type { ResourceClassification } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { AppError, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { capabilities, resourceInclude, toResourceDto } from '../resources/resource.service.js';
import { shareStatus } from '../sharing/public-share.service.js';
import { ancestorChain } from '../sharing/access-review.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import {
  CLASSIFICATION_LABEL,
  allowsAnonymousLink,
  allowsExternalAccess,
  isDowngrade,
  isUpgrade,
  satisfiesVisibilityInvariant,
} from './classification.policy.js';

/**
 * สิทธิ์ลดชั้นความลับ
 *
 * แยกจาก resources:write เพราะการยกชั้นกับการลดชั้นไม่ใช่การกระทำที่มีน้ำหนักเท่ากัน
 * การยกชั้นปิดช่องทาง - ผิดพลาดแล้วแค่ไม่สะดวก ส่วนการลดชั้นเปิดช่องทางออกนอกองค์กร
 * - ผิดพลาดแล้วเอกสารหลุด คนที่แก้ไขเอกสารได้ทุกคนไม่ควรลดชั้นได้โดยอัตโนมัติ
 */
export const DECLASSIFY_PERMISSION = 'system:classification:declassify';

/** เหตุผลของการลดชั้นต้องอธิบายได้จริง ไม่ใช่จุดเดียวหรือ "ok" เพื่อผ่านช่องบังคับ */
const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 500;

export function canDeclassify(user: AuthUser): boolean {
  if (user.type !== 'INTERNAL') return false;
  return user.permissions.includes(DECLASSIFY_PERMISSION);
}

/**
 * ผลกระทบของการเปลี่ยนชั้นความลับ - คำนวณก่อนเปลี่ยน เพื่อให้คนกดรู้ว่ากำลังจะปิดอะไร
 *
 * นับเฉพาะสิ่งที่ "ใช้งานได้อยู่ตอนนี้และจะใช้ไม่ได้หลังเปลี่ยน" ไม่นับลิงก์ที่หมดอายุหรือถูกเพิกถอนไปแล้ว
 * เพราะตัวเลขที่รวมของที่ตายไปแล้วทำให้คนตกใจกับสิ่งที่ไม่ได้เกิดขึ้นจริง
 */
export interface ClassificationImpact {
  level: ResourceClassification;
  /** ลิงก์สาธารณะที่ยังใช้งานได้ตอนนี้ และจะถูกปิดด้วยนโยบาย */
  publicLinksBlocked: number;
  /** สิทธิ์ที่มอบให้บัญชีภายนอกไว้ และจะใช้ไม่ได้ (แถวสิทธิ์ยังอยู่) */
  externalGrantsBlocked: number;
  /**
   * ลิงก์ของโฟลเดอร์แม่ที่ยังใช้งานได้ และจะไม่แสดงทรัพยากรนี้อีกต่อไป
   *
   * แยกจากลิงก์ตรงเพราะการแก้ต่างกันสิ้นเชิง ลิงก์ตรงจะ ตาย ทั้งลิงก์
   * ส่วนลิงก์ของโฟลเดอร์แม่ยังใช้ได้ปกติ เพียงแต่เอกสารฉบับนี้จะหายไปจากรายการ
   * ถ้ารวมเป็นตัวเลขเดียว ผู้ดูแลจะเข้าใจผิดว่ากำลังจะทำให้ลิงก์ของทั้งโฟลเดอร์ใช้ไม่ได้
   */
  ancestorLinksHidingResource: number;
  /** ชั้นนี้ต้องการการมองเห็นภายในแบบจำกัด แต่ปัจจุบันยังไม่ใช่ */
  visibilityConflict: boolean;
}

async function impactOf(
  resourceId: string,
  level: ResourceClassification,
  now = new Date(),
): Promise<ClassificationImpact> {
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: { deletedAt: true, lifecycleState: true, visibility: true },
  });
  if (!resource) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');

  let publicLinksBlocked = 0;
  if (!allowsAnonymousLink(level)) {
    const links = await prisma.publicShareLink.findMany({ where: { resourceId } });
    /*
     * ใช้ shareStatus ตัวเดียวกับที่ด่านรับแขกใช้ ไม่เขียนเงื่อนไข "ยังใช้งานได้" ขึ้นมาใหม่
     *
     * ประเมินด้วยชั้นที่ยอมให้มีลิงก์ได้ เพื่อตอบว่า "ตอนนี้ใช้ได้กี่ลิงก์" แล้วลิงก์เหล่านั้น
     * คือลิงก์ที่จะถูกปิด - ถ้าประเมินด้วยชั้นใหม่ คำตอบจะเป็นศูนย์เสมอและไร้ประโยชน์
     */
    const state = { ...resource, classification: 'PUBLIC' as ResourceClassification };
    publicLinksBlocked = links.filter((link) => shareStatus(link, state, now) === 'ACTIVE').length;
  }

  let ancestorLinksHidingResource = 0;
  if (!allowsAnonymousLink(level)) {
    /*
     * ชั้นความลับไม่สืบทอด แต่ "ถูกบังคับใช้ที่ทุกชั้นระหว่างทาง" ตอนแขกไต่ลงมา
     * การยกชั้นเอกสารฉบับหนึ่งจึงทำให้มันหายไปจากลิงก์ของโฟลเดอร์แม่ทุกอันด้วย
     * ผู้ดูแลที่ไม่รู้ข้อนี้จะงงว่าทำไมลูกค้าบอกว่าหาไฟล์ในลิงก์เดิมไม่เจอ
     */
    const chain = await ancestorChain(resourceId);
    const ancestorIds = chain.map((node) => node.id).filter((id) => id !== resourceId);
    if (ancestorIds.length > 0) {
      const ancestorLinks = await prisma.publicShareLink.findMany({
        where: { resourceId: { in: ancestorIds } },
        include: { resource: { select: { deletedAt: true, lifecycleState: true, classification: true } } },
      });
      ancestorLinksHidingResource = ancestorLinks.filter(
        (link) => shareStatus(link, link.resource, now) === 'ACTIVE',
      ).length;
    }
  }

  let externalGrantsBlocked = 0;
  if (!allowsExternalAccess(level)) {
    externalGrantsBlocked = await prisma.resourceAccess.count({
      where: { resourceId, user: { type: 'EXTERNAL' } },
    });
  }

  return {
    level,
    publicLinksBlocked,
    ancestorLinksHidingResource,
    externalGrantsBlocked,
    visibilityConflict: !satisfiesVisibilityInvariant(level, resource.visibility),
  };
}

async function loadEditable(resourceId: string, user: AuthUser) {
  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    include: resourceInclude,
  });
  if (!resource || resource.deletedAt) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');

  const caps = capabilities(resource, user);
  if (!caps.canView) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  if (!caps.canEdit) {
    throw new AppError('RESOURCE_ACCESS_DENIED', 'ไม่มีสิทธิ์แก้ไขเอกสารนี้', 403);
  }
  return resource;
}

export async function classificationImpact(
  resourceId: string,
  user: AuthUser,
  level: ResourceClassification,
): Promise<ClassificationImpact> {
  await loadEditable(resourceId, user);
  return impactOf(resourceId, level);
}

export interface SetClassificationInput {
  level: ResourceClassification;
  /** บังคับเมื่อลดชั้น - เป็นหลักฐานว่าทำไมจึงยอมเปิดเผยเอกสารได้กว้างขึ้น */
  reason?: string | null;
}

export async function setClassification(
  resourceId: string,
  user: AuthUser,
  input: SetClassificationInput,
  audit: { ipAddress?: string; userAgent?: string },
) {
  const resource = await loadEditable(resourceId, user);
  const from = resource.classification;
  const to = input.level;

  /*
   * ตั้งค่าเดิมซ้ำถือว่าไม่มีอะไรเปลี่ยน - ยกเว้นครั้งแรก
   *
   * ทรัพยากรที่ยังไม่เคยถูกจัดชั้น (classifiedAt = null) ถือค่าเริ่มต้นของระบบอยู่
   * การที่มีคนยืนยันว่า "ใช่ INTERNAL นี่แหละถูกแล้ว" เป็นการตัดสินใจที่ต้องบันทึก
   * ไม่ใช่การกดที่ไม่มีผล
   */
  if (from === to && resource.classifiedAt) {
    throw new AppError('CLASSIFICATION_UNCHANGED', 'ทรัพยากรนี้อยู่ในชั้นความลับนี้อยู่แล้ว', 409);
  }

  const reason = input.reason?.trim() ?? '';
  const downgrade = isDowngrade(from, to);

  if (downgrade) {
    if (!canDeclassify(user)) {
      throw new AppError(
        'CLASSIFICATION_DECLASSIFY_DENIED',
        `ไม่มีสิทธิ์ลดชั้นความลับจาก "${CLASSIFICATION_LABEL[from]}" เป็น "${CLASSIFICATION_LABEL[to]}"`,
        403,
      );
    }
    if (reason.length < MIN_REASON_LENGTH) {
      throw new AppError(
        'CLASSIFICATION_REASON_REQUIRED',
        `ต้องระบุเหตุผลของการลดชั้นความลับอย่างน้อย ${MIN_REASON_LENGTH} ตัวอักษร`,
        400,
      );
    }
    /*
     * Legal Hold อยู่เหนือชั้นความลับ
     *
     * ระงับไว้เพื่อการสืบสวนหรือคดี แล้วมีคนลดชั้นจนเปิดลิงก์สาธารณะได้ คือการทำลาย
     * เจตนาของ Legal Hold ทั้งหมด - ส่วนการยกชั้นไม่ถูกขวาง เพราะยิ่งเข้มงวดยิ่งสอดคล้อง
     */
    if (resource.legalHolds.length > 0) {
      throw new AppError(
        'CLASSIFICATION_BLOCKED_HOLD',
        'ลดชั้นความลับไม่ได้ เอกสารนี้อยู่ระหว่างการระงับตามกฎหมาย',
        409,
      );
    }
  }

  /*
   * ชั้นสูงสุดต้องสอดคล้องกับการจำกัดภายใน มิฉะนั้นมันจะเป็นป้ายที่ไม่ได้ทำอะไรต่างจากชั้นรองลงมา
   * ปฏิเสธพร้อมบอกว่าต้องทำอะไรก่อน แทนที่จะแก้ visibility ให้เองเงียบ ๆ
   */
  if (!satisfiesVisibilityInvariant(to, resource.visibility)) {
    throw new AppError(
      'CLASSIFICATION_VISIBILITY_CONFLICT',
      'ชั้น "จำกัดการเข้าถึง" ต้องตั้งการมองเห็นภายในเป็นแบบจำกัดก่อน',
      409,
    );
  }

  const impact = await impactOf(resourceId, to);

  await prisma.resource.update({
    where: { id: resourceId },
    data: { classification: to, classifiedAt: new Date(), updatedById: user.id },
  });

  /*
   * เหตุการณ์สามแบบแยกกันจริง ไม่ใช่แบบเดียวที่ใส่ฟิลด์ต่างกัน
   * ผู้ตรวจสอบกรอง "การลดชั้นทั้งหมดในไตรมาสนี้" ได้ทันทีโดยไม่ต้องอ่าน metadata ทีละแถว
   */
  const action = !resource.classifiedAt
    ? 'CLASSIFICATION_ASSIGNED'
    : downgrade
      ? 'CLASSIFICATION_DOWNGRADED'
      : isUpgrade(from, to)
        ? 'CLASSIFICATION_UPGRADED'
        : 'CLASSIFICATION_ASSIGNED';

  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action,
      resourceId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: {
        from,
        to,
        // เหตุผลเก็บเฉพาะตอนที่มี ไม่ใส่ค่าว่างให้ดูเหมือนมีคนกรอกมาแล้ว
        ...(reason ? { reason: reason.slice(0, MAX_REASON_LENGTH) } : {}),
        // ผลกระทบที่ประเมินไว้ตอนกด - หลักฐานว่าคนกดได้รับแจ้งอะไร ไม่ใช่สถานะปัจจุบัน
        publicLinksBlocked: impact.publicLinksBlocked,
        ancestorLinksHidingResource: impact.ancestorLinksHidingResource,
        externalGrantsBlocked: impact.externalGrantsBlocked,
      },
    },
  });

  logger.info(`[CLASSIFICATION] ${from} -> ${to} "${resource.name}"`);

  const fresh = await prisma.resource.findUnique({ where: { id: resourceId }, include: resourceInclude });
  return { resource: toResourceDto(fresh!, user), impact };
}
