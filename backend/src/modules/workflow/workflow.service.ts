/**
 * คำขอความร่วมมือจากภายนอก - การสร้างและการอ่าน (F26-B)
 *
 * **หลักที่ห้ามละเมิด: คำขอไม่แตะสิทธิ์ที่มีอยู่เดิมแม้แต่ฟิลด์เดียว (F26-B1)**
 *
 * คำขอเป็นแหล่งสิทธิ์ชั่วคราวที่ "ทับ" อยู่ข้างบน ไม่ใช่ตัวเขียนทับแถว ResourceAccess
 * สิทธิ์ที่ผู้ดูแลมอบด้วยมือยังเป็นความจริงที่ไม่ถูกแตะต้องตลอดอายุของคำขอ
 * และยังอยู่ครบหลังคำขอจบ โดยไม่ต้องกู้คืนอะไร - ดู workflow-access.ts
 *
 * แหล่งนี้ไม่ได้มองไม่เห็น: รายงานสิทธิ์ของ F25-C อ่านมันด้วยและแสดงแยกเป็นหลักฐาน
 * คนละชิ้น ผู้ตรวจสอบจึงเห็นว่าผลลัพธ์รวมมาจากที่ใดบ้าง
 *
 * เฟสนี้ทำเฉพาะการสร้างและการอ่าน การส่งงาน การตรวจ และการเพิกถอน อยู่ในเฟสถัดไป
 */
import type { ExternalWorkflowRequest, Prisma, Resource, User } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { AppError, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import {
  PORTAL_VISIBLE_CLASSIFICATIONS,
  allowsExternalAccess,
} from '../governance/classification.policy.js';
import { resourceExposableToPortal } from '../portal/portal-access.js';
import { assertMayManageAccess, normalizeExpiry } from '../workspace/sharing.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import { listSubmissions, listSubmissionsForWorkflows, type SubmissionDto } from './submission.service.js';
import {
  SUBMITTABLE_STATES,
  accessLevelForWorkflow,
  activeSlotFor,
  effectiveWorkflowStatus,
  isWorkflowActive,
  portalRoleForWorkflow,
  type EffectiveWorkflowStatus,
} from './workflow.policy.js';

export interface AuditContext {
  ipAddress?: string;
  userAgent?: string;
}

/* ------------------------------------------------------------------ */
/* DTO                                                                 */
/* ------------------------------------------------------------------ */

/**
 * รูปที่ส่งออกไปข้างนอก
 *
 * ไม่มี storageKey ไม่มีผู้ให้บริการที่เก็บ ไม่มีเส้นทางในเครื่อง และไม่มีโทเคนใด ๆ
 * เพราะคำขอไม่เคยถือของเหล่านั้นตั้งแต่แรก - มันชี้ไปที่ทรัพยากร ไม่ได้ถือไบต์
 */
export interface WorkflowDto {
  id: string;
  title: string;
  instructions: string | null;
  /** สถานะที่คำนวณแล้ว - อาจเป็น EXPIRED ซึ่งไม่เคยถูกเก็บลงฐานข้อมูล */
  status: EffectiveWorkflowStatus;
  /** สถานะดิบที่เก็บอยู่จริง - ผู้ตรวจสอบต้องแยกออกว่าอะไรถูกเก็บ อะไรถูกคำนวณ */
  storedState: ExternalWorkflowRequest['state'];
  target: { id: string; name: string; type: Resource['type'] };
  assignee: { id: string; displayName: string; email: string; organizationName: string | null };
  permissions: { allowUpload: boolean; allowDownload: boolean; portalRole: 'VIEWER' | 'CONTRIBUTOR' };
  expiresAt: Date | null;
  dueAt: Date | null;
  createdBy: { id: string; displayName: string } | null;
  createdAt: Date;
  updatedAt: Date;
  /** ไฟล์ที่ลูกค้าส่งมาแล้ว - ผู้ตรวจต้องเห็นทุกฉบับ ไม่ใช่เฉพาะฉบับล่าสุด (F26-E) */
  submissions: SubmissionDto[];
}

const workflowInclude = {
  targetResource: { select: { id: true, name: true, type: true } },
  externalUser: { select: { id: true, displayName: true, email: true, organizationName: true } },
  createdBy: { select: { id: true, displayName: true } },
} as const;

type WorkflowRow = Prisma.ExternalWorkflowRequestGetPayload<{ include: typeof workflowInclude }>;

export function toWorkflowDto(row: WorkflowRow, submissions: SubmissionDto[], now: Date = new Date()): WorkflowDto {
  return {
    id: row.id,
    title: row.title,
    instructions: row.instructions,
    status: effectiveWorkflowStatus(row, now),
    storedState: row.state,
    target: row.targetResource,
    assignee: row.externalUser,
    permissions: {
      allowUpload: row.allowUpload,
      allowDownload: row.allowDownload,
      portalRole: portalRoleForWorkflow(row.allowUpload),
    },
    expiresAt: row.expiresAt,
    dueAt: row.dueAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    submissions,
  };
}

/* ------------------------------------------------------------------ */
/* การตรวจก่อนสร้าง                                                     */
/* ------------------------------------------------------------------ */

/**
 * ผู้รับงานต้องเป็นบัญชีภายนอกที่เปิดใช้งานอยู่
 *
 * ไม่รับบัญชีภายในเพราะคำขอนี้คือ "งานที่ส่งออกไปนอกองค์กร" การมอบให้เพื่อนร่วมงาน
 * มีเส้นทางของตัวเองอยู่แล้ว และไม่รับบัญชีของระบบเชื่อมต่อเพราะมันไม่ใช่คน
 * ที่จะรับผิดชอบงานได้
 */
async function assertExternalAssignee(client: Prisma.TransactionClient, userId: string): Promise<User> {
  const target = await client.user.findUnique({ where: { id: userId } });
  if (!target || target.status !== 'ACTIVE') {
    throw new AppError('WORKFLOW_ASSIGNEE_INACTIVE', 'ผู้รับงานต้องเป็นบัญชีที่เปิดใช้งานอยู่', 400);
  }
  if (target.type !== 'EXTERNAL') {
    throw new AppError(
      'WORKFLOW_ASSIGNEE_NOT_EXTERNAL',
      'คำขอความร่วมมือมอบหมายให้บัญชีภายนอกเท่านั้น',
      400,
    );
  }
  return target;
}

/**
 * เอกสารปลายทางต้องรับงานจากภายนอกได้จริง
 *
 * ตรวจครบทั้งการมีอยู่ ชนิด วงจรชีวิต และเพดานการเปิดเผยตามชั้นความลับ
 * ชั้นความลับใช้กฎของ F25-D ตรง ๆ ผ่าน resourceExposableToPortal ที่ F26-A1 วางไว้
 * ไม่มีการเขียนเมทริกซ์ชุดใหม่ที่นี่
 *
 * **ไม่สร้างสิทธิ์ที่ใช้ไม่ได้** ถ้าชั้นความลับปิดช่องทางภายนอกอยู่ การสร้างคำขอแล้ว
 * มอบสิทธิ์ให้ จะได้สิทธิ์ที่ด่านพื้นที่ลูกค้าปฏิเสธทุกครั้ง - ผู้รับงานเห็นว่ามีงานเข้ามา
 * แต่เปิดไม่ได้ และไม่มีใครอธิบายได้ว่าทำไม
 */
async function assertUsableTarget(resource: Resource): Promise<void> {
  /*
   * เฟสนี้จำกัดที่โฟลเดอร์
   *
   * งานที่ส่งออกไปข้างนอกเกือบทั้งหมดจบด้วยการรับไฟล์กลับมา ซึ่งต้องมีที่ลง
   * การรองรับคำขอระดับไฟล์ตั้งแต่ต้นแปลว่าต้องตอบว่า "ส่งกลับมาแล้วไปไว้ไหน"
   * ตั้งแต่ตอนนี้ ทั้งที่ยังไม่มีข้อกำหนดของการส่งงานให้ยึด
   */
  if (resource.type !== 'FOLDER') {
    throw new AppError('WORKFLOW_TARGET_NOT_FOLDER', 'คำขอความร่วมมือกำหนดปลายทางเป็นโฟลเดอร์เท่านั้น', 400);
  }
  if (!resourceExposableToPortal(resource)) {
    /*
     * ข้อความแยกสองกรณีให้เจ้าหน้าที่ภายใน - ต่างจากฝั่งลูกค้าที่ตอบกลาง ๆ เสมอ
     * คนภายในเห็นเอกสารนี้อยู่แล้ว การบอกเหตุผลจึงไม่ได้เปิดเผยอะไรเพิ่ม
     * และถ้าไม่บอก เจ้าหน้าที่จะไม่รู้ว่าต้องไปแก้อะไรก่อน
     */
    if (!allowsExternalAccess(resource.classification)) {
      throw new AppError(
        'WORKFLOW_TARGET_CLASSIFICATION_BLOCKED',
        'ชั้นความลับของโฟลเดอร์นี้ไม่อนุญาตให้เปิดออกนอกองค์กร',
        409,
      );
    }
    throw new AppError(
      'WORKFLOW_TARGET_UNAVAILABLE',
      'โฟลเดอร์ปลายทางไม่พร้อมใช้งาน (อยู่ในถังขยะหรือคลังเอกสาร)',
      409,
    );
  }
}

/**
 * ธงสิทธิ์ต้องเป็นชุดที่มีความหมายจริง
 *
 * "ดาวน์โหลดไม่ได้และอัปโหลดไม่ได้" คือคำขอที่ผู้รับงานเปิดดูได้อย่างเดียวและทำอะไรไม่ได้เลย
 * ซึ่งอาจตั้งใจจริง (ให้อ่านคำชี้แจง) จึงไม่ห้าม แต่ค่าที่เป็นไปไม่ได้ต้องถูกปฏิเสธ
 * ไม่ใช่ถูกแก้ให้เงียบ ๆ เพราะการแก้ให้เองแปลว่าคนสั่งงานเข้าใจสิ่งที่ตัวเองสั่งผิดไปตลอด
 */
function assertPermissionCombination(input: { allowUpload: boolean; allowDownload: boolean }): void {
  if (typeof input.allowUpload !== 'boolean' || typeof input.allowDownload !== 'boolean') {
    throw new AppError('WORKFLOW_INVALID_PERMISSIONS', 'ค่าสิทธิ์ของคำขอไม่ถูกต้อง', 400);
  }
}

/** กำหนดส่งต้องไม่เลยวันหมดอายุ - งานที่ครบกำหนดหลังประตูปิดแล้วส่งไม่ได้ตลอดกาล */
function assertDueWithinExpiry(dueAt: Date | null, expiresAt: Date | null, now: Date): void {
  if (!dueAt) return;
  if (Number.isNaN(dueAt.getTime())) {
    throw new AppError('WORKFLOW_INVALID_DUE_DATE', 'กำหนดส่งไม่ถูกต้อง', 400);
  }
  if (dueAt.getTime() <= now.getTime()) {
    throw new AppError('WORKFLOW_INVALID_DUE_DATE', 'กำหนดส่งต้องอยู่ในอนาคต', 400);
  }
  if (expiresAt && dueAt.getTime() > expiresAt.getTime()) {
    throw new AppError(
      'WORKFLOW_DUE_AFTER_EXPIRY',
      'กำหนดส่งต้องไม่เลยวันหมดอายุของคำขอ',
      400,
    );
  }
}

/* ------------------------------------------------------------------ */
/* สร้าง                                                               */
/* ------------------------------------------------------------------ */

export interface CreateWorkflowInput {
  title: string;
  instructions?: string | null;
  targetResourceId: string;
  externalUserId: string;
  expiresAt?: Date | null;
  dueAt?: Date | null;
  allowUpload?: boolean;
  allowDownload?: boolean;
}

export async function createWorkflowRequest(
  user: AuthUser,
  input: CreateWorkflowInput,
  audit: AuditContext,
  now: Date = new Date(),
): Promise<WorkflowDto> {
  /*
   * ตรวจสิทธิ์ของผู้สั่งงาน "ก่อน" เปิดธุรกรรม
   *
   * ด่านนี้เป็นตัวเดียวกับที่การแชร์ปกติใช้ - ผู้ที่แชร์เอกสารนี้ไม่ได้ ก็สั่งงานภายนอก
   * บนเอกสารนี้ไม่ได้เช่นกัน มิฉะนั้นคำขอความร่วมมือจะกลายเป็นทางอ้อมรอบด่านการแชร์
   */
  const resource = await assertMayManageAccess(input.targetResourceId, user);
  await assertUsableTarget(resource);

  const title = input.title.trim();
  if (title.length === 0) {
    throw new AppError('WORKFLOW_TITLE_REQUIRED', 'ต้องระบุชื่อเรื่องของคำขอ', 400);
  }

  const allowUpload = input.allowUpload ?? false;
  const allowDownload = input.allowDownload ?? false;
  assertPermissionCombination({ allowUpload, allowDownload });

  // ใช้กติกาวันหมดอายุของการแชร์ตัวเดิม รวมถึงเพดานอายุสูงสุด
  const expiresAt = normalizeExpiry(input.expiresAt ?? null, now);
  const dueAt = input.dueAt ?? null;
  assertDueWithinExpiry(dueAt, expiresAt, now);

  const slot = activeSlotFor(input.targetResourceId, input.externalUserId);

  /*
   * แถวคำขอ แถวสิทธิ์ และบันทึกการตรวจสอบ ต้องเกิดพร้อมกันหรือไม่เกิดเลย (§18)
   *
   * ถ้าเกิดครึ่งเดียวจะได้อย่างใดอย่างหนึ่งเสมอ: คำขอที่ผู้รับงานเปิดไม่ได้ หรือสิทธิ์ที่
   * ไม่มีใครอธิบายได้ว่ามาจากไหน อย่างหลังอันตรายกว่า เพราะมันคือสิทธิ์กำพร้าที่
   * ไม่มีเจ้าของเหตุผล และไม่มีใครกล้าเพิกถอนเพราะไม่รู้ว่าใครกำลังใช้อยู่
   */
  const created = await prisma.$transaction(async (tx) => {
    const assignee = await assertExternalAssignee(tx, input.externalUserId);

    if (assignee.id === resource.ownerId) {
      throw new AppError('WORKFLOW_INVALID_ASSIGNEE', 'ผู้ดูแลหลักมีสิทธิ์เต็มอยู่แล้ว', 400);
    }

    /*
     * ปล่อยช่องกันซ้ำของคำขอเดิมที่ "จบไปแล้วแต่ยังถือช่องอยู่"
     *
     * เกิดได้กรณีเดียวคือคำขอเดิมหมดอายุ เพราะการหมดอายุไม่เขียนสถานะ จึงไม่มีจังหวะใด
     * ที่จะปล่อยช่องคืนได้เอง ตรงนี้คือจังหวะนั้น และอยู่ในธุรกรรมเดียวกับการสร้างคำขอใหม่
     *
     * ช่องกันซ้ำไม่ใช่สถานะ - EXPIRED ยังคงคำนวณจากเวลาเหมือนเดิมทุกประการ
     */
    const holder = await tx.externalWorkflowRequest.findUnique({ where: { activeSlot: slot } });
    if (holder) {
      if (isWorkflowActive(holder, now)) {
        throw new AppError(
          'WORKFLOW_ALREADY_ACTIVE',
          'มีคำขอที่ยังเปิดใช้งานอยู่สำหรับโฟลเดอร์และผู้รับงานคู่นี้แล้ว',
          409,
        );
      }
      await tx.externalWorkflowRequest.update({ where: { id: holder.id }, data: { activeSlot: null } });
    }

    /*
     * ไม่มีการเขียน ResourceAccess ที่นี่โดยเจตนา (F26-B1)
     *
     * เดิมจุดนี้ upsert ทับแถวสิทธิ์ ซึ่งลบระดับสิทธิ์ สิทธิ์ดาวน์โหลด และวันหมดอายุ
     * ที่ผู้ดูแลเคยตั้งไว้ด้วยมือทิ้งอย่างเงียบ ๆ ตอนนี้คำขอถือเงื่อนไขของตัวเองไว้ในแถวนี้
     * และถูกนำไปรวมตอนอ่านที่ activeGrantMap
     */
    const row = await tx.externalWorkflowRequest.create({
      data: {
        title,
        instructions: input.instructions?.trim() || null,
        targetResourceId: resource.id,
        externalUserId: assignee.id,
        state: 'OPEN',
        expiresAt,
        dueAt,
        allowUpload,
        allowDownload,
        activeSlot: slot,
        createdById: user.id,
      },
      include: workflowInclude,
    });

    await tx.activityLog.create({
      data: {
        userId: user.id,
        action: 'EXTERNAL_WORKFLOW_CREATED',
        resourceId: resource.id,
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent?.slice(0, 500),
        /*
         * เก็บเฉพาะสิ่งที่อธิบายการตัดสินใจได้ ไม่เก็บคำชี้แจงซึ่งเป็นข้อความอิสระ
         * ที่อาจมีรายละเอียดของงานหรือของลูกค้าอยู่ ตัวคำชี้แจงอยู่ในแถวคำขออยู่แล้ว
         */
        metadata: {
          workflowId: row.id,
          assigneeUserId: assignee.id,
          allowUpload,
          allowDownload,
          accessLevel: accessLevelForWorkflow(allowUpload),
          expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
          dueAt: dueAt === null ? null : dueAt.toISOString(),
        },
      },
    });

    return row;
  });

  logger.info(`[WORKFLOW] สร้างคำขอความร่วมมือบน "${resource.name}"`);
  return toWorkflowDto(created, [], now);
}

/* ------------------------------------------------------------------ */
/* อ่าน                                                                */
/* ------------------------------------------------------------------ */

/**
 * ผู้ที่ดูคำขอของทั้งระบบได้
 *
 * ใช้สิทธิ์การจัดการการแชร์เป็นเกณฑ์ เพราะคำขอคือการแชร์ออกนอกองค์กรที่มีเรื่องราวกำกับ
 * ผู้ที่ดูรายการนี้ได้จะเห็นว่าเอกสารใดถูกส่งออกไปให้ใครบ้าง ซึ่งเป็นข้อมูลระดับเดียวกัน
 */
function assertMayListWorkflows(user: AuthUser): void {
  if (user.type !== 'INTERNAL') {
    throw new AppError('WORKFLOW_DENIED', 'ไม่มีสิทธิ์ดูคำขอความร่วมมือ', 403);
  }
  const allowed =
    user.roles.includes('ADMIN') ||
    user.roles.includes('SUPER_ADMIN') ||
    user.permissions.includes('resources:share');
  if (!allowed) {
    throw new AppError('WORKFLOW_DENIED', 'ไม่มีสิทธิ์ดูคำขอความร่วมมือ', 403);
  }
}

export interface WorkflowListFilter {
  status?: EffectiveWorkflowStatus;
  targetResourceId?: string;
  externalUserId?: string;
  limit?: number;
}

export async function listWorkflowRequests(
  user: AuthUser,
  filter: WorkflowListFilter = {},
  now: Date = new Date(),
): Promise<WorkflowDto[]> {
  assertMayListWorkflows(user);

  const rows = await prisma.externalWorkflowRequest.findMany({
    where: {
      ...(filter.targetResourceId ? { targetResourceId: filter.targetResourceId } : {}),
      ...(filter.externalUserId ? { externalUserId: filter.externalUserId } : {}),
    },
    include: workflowInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(filter.limit ?? 100, 200),
  });

  /*
   * ดึงการส่งงานของทุกคำขอในคำสั่งเดียว แล้วจัดกลุ่มในหน่วยความจำ
   * ถ้ายิงต่อแถว รายการร้อยใบจะกลายเป็นร้อยคำสั่ง ซึ่งช้าขึ้นตามจำนวนงานเสมอ
   */
  const allSubmissions = await listSubmissionsForWorkflows(rows.map((row) => row.id));
  const items = rows.map((row) => toWorkflowDto(row, allSubmissions.get(row.id) ?? [], now));
  /*
   * กรองสถานะหลังคำนวณ ไม่ใช่ในคำสั่ง SQL
   *
   * เพราะ EXPIRED ไม่มีอยู่ในคอลัมน์ การกรองในฐานข้อมูลจะหาไม่เจอเลย และที่แย่กว่าคือ
   * การกรอง OPEN ในฐานข้อมูลจะคืนคำขอที่หมดอายุไปแล้วปนมาด้วย
   */
  return filter.status ? items.filter((item) => item.status === filter.status) : items;
}

export async function getWorkflowRequest(
  user: AuthUser,
  id: string,
  now: Date = new Date(),
): Promise<WorkflowDto> {
  assertMayListWorkflows(user);
  const row = await prisma.externalWorkflowRequest.findUnique({ where: { id }, include: workflowInclude });
  if (!row) throw notFound('WORKFLOW_NOT_FOUND', 'ไม่พบคำขอความร่วมมือ');
  return toWorkflowDto(row, await listSubmissions(row.id), now);
}

/* ------------------------------------------------------------------ */
/* ฝั่งผู้รับงาน - รองรับ F26-C                                          */
/* ------------------------------------------------------------------ */

/**
 * คำขอของผู้รับงานคนปัจจุบัน
 *
 * คืนเฉพาะของตัวเองเสมอ โดยกรองจาก userId ของผู้เรียกโดยตรง ไม่รับรหัสผู้ใช้จากภายนอก
 * มาเป็นพารามิเตอร์ - พารามิเตอร์ที่รับรหัสผู้ใช้ได้คือพารามิเตอร์ที่วันหนึ่งจะถูกส่งค่า
 * ของคนอื่นเข้ามา
 *
 * ไม่คืนคำชี้แจงภายใน ผู้สั่งงาน หรือรหัสสิทธิ์ - ผู้รับงานต้องรู้แค่ว่าต้องทำอะไร
 * ที่ไหน ภายในเมื่อใด
 */
export interface AssignedWorkflowDto {
  id: string;
  title: string;
  instructions: string | null;
  status: EffectiveWorkflowStatus;
  target: { id: string; name: string };
  permissions: { allowUpload: boolean; allowDownload: boolean };
  dueAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  /** จำนวนไฟล์ที่ส่งไปแล้ว - ผู้รับงานต้องรู้ว่าส่งไปหรือยังโดยไม่ต้องกดเข้าไปดู */
  submissionCount: number;
}

/** หน้ารายละเอียดของผู้รับงาน - เพิ่มรายการไฟล์ที่ส่งไปแล้วจากรายการย่อ */
export interface AssignedWorkflowDetailDto extends AssignedWorkflowDto {
  submissions: SubmissionDto[];
  /** ส่งไฟล์ได้ตอนนี้ไหม - คำนวณฝั่งเซิร์ฟเวอร์ หน้าจอไม่ตีความสถานะเอง */
  canSubmit: boolean;
  /**
   * เหตุผลของการตัดสินล่าสุดที่ผู้รับงานควรได้รู้ (F26-F §15)
   *
   * มีเฉพาะการตัดสินที่เป็นคำสั่งถึงผู้รับงานโดยตรง - ขอให้แก้ไข ไม่อนุมัติ และยกเลิก
   * ไม่ส่งบันทึกภายในอื่นใดออกไป และไม่ส่งชื่อผู้ตัดสิน เพราะผู้รับงานต้องรู้ว่า
   * "ต้องทำอะไรต่อ" ไม่ใช่ "ใครในองค์กรเป็นคนตัดสิน"
   */
  latestDecision: { status: EffectiveWorkflowStatus; reason: string | null; at: Date } | null;
}

export async function listAssignedWorkflows(
  user: AuthUser,
  now: Date = new Date(),
): Promise<AssignedWorkflowDto[]> {
  if (user.type !== 'EXTERNAL') {
    throw new AppError('WORKFLOW_DENIED', 'เส้นทางนี้สำหรับผู้รับงานภายนอกเท่านั้น', 403);
  }

  const rows = await prisma.externalWorkflowRequest.findMany({
    where: {
      externalUserId: user.id,
      /*
       * เอกสารปลายทางต้องยังเปิดให้ผู้ใช้ภายนอกได้อยู่ (F26-A1)
       *
       * ถ้าโฟลเดอร์ถูกยกชั้นความลับหรือถูกเก็บเข้าคลังหลังจากสั่งงานไปแล้ว คำขอนั้น
       * ต้องหายไปจากสายตาผู้รับงานด้วย ไม่ใช่ค้างอยู่เป็นรายการที่กดแล้วถูกปฏิเสธ
       */
      targetResource: {
        deletedAt: null,
        lifecycleState: 'ACTIVE',
        classification: { in: PORTAL_VISIBLE_CLASSIFICATIONS },
      },
    },
    include: workflowInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 200,
  });

  const counts = await prisma.externalWorkflowSubmission.groupBy({
    by: ['workflowRequestId'],
    where: { workflowRequestId: { in: rows.map((row) => row.id) } },
    _count: { _all: true },
  });
  const countBy = new Map(counts.map((row) => [row.workflowRequestId, row._count._all]));

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    instructions: row.instructions,
    status: effectiveWorkflowStatus(row, now),
    target: { id: row.targetResource.id, name: row.targetResource.name },
    permissions: { allowUpload: row.allowUpload, allowDownload: row.allowDownload },
    dueAt: row.dueAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    submissionCount: countBy.get(row.id) ?? 0,
  }));
}

/**
 * เหตุผลของการตัดสินล่าสุดที่ถึงตัวผู้รับงาน
 *
 * อ่านจากบันทึกการตรวจสอบ ไม่เก็บซ้ำในแถวคำขอ - ประวัติที่เก็บสองที่คือประวัติที่
 * จะไม่ตรงกันในวันหนึ่ง และบันทึกการตรวจสอบเป็นของที่แก้ไม่ได้อยู่แล้ว
 */
async function latestDecisionFor(
  workflowId: string,
  status: EffectiveWorkflowStatus,
): Promise<{ status: EffectiveWorkflowStatus; reason: string | null; at: Date } | null> {
  const ACTION_FOR: Partial<Record<EffectiveWorkflowStatus, string>> = {
    REVISION_REQUESTED: 'EXTERNAL_REVISION_REQUESTED',
    REJECTED: 'EXTERNAL_REVIEW_REJECTED',
    REVOKED: 'EXTERNAL_WORKFLOW_REVOKED',
  };
  const action = ACTION_FOR[status];
  if (!action) return null;

  const logs = await prisma.activityLog.findMany({
    where: { action },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 50,
  });
  const log = logs.find((row) => (row.metadata as Record<string, unknown> | null)?.workflowId === workflowId);
  if (!log) return null;

  const metadata = (log.metadata ?? {}) as Record<string, unknown>;
  return {
    status,
    reason: typeof metadata.reason === 'string' ? metadata.reason : null,
    at: log.createdAt,
  };
}

/**
 * รายละเอียดงานหนึ่งใบสำหรับผู้รับงาน (F26-C)
 *
 * **ตอบเหมือนกรณีไม่พบทุกกรณีที่เกี่ยวกับการมองเห็น** ไม่ว่าจะเป็นงานของคนอื่น
 * งานที่ไม่มีอยู่ หรืองานที่โฟลเดอร์ปลายทางถูกปิดไปแล้ว ผู้รับงานต้องแยกสามอย่างนี้ไม่ออก
 * มิฉะนั้นการสุ่มรหัสจะกลายเป็นเครื่องมือยืนยันว่ามีเอกสารอะไรอยู่ในระบบบ้าง
 *
 * ส่วนสถานะของงานเอง (หมดอายุ ถูกยกเลิก ส่งไปแล้ว) บอกได้ตามปกติ เพราะผู้รับงาน
 * รู้อยู่แล้วว่ามีงานใบนี้ และการรู้สถานะของงานตัวเองไม่ได้เปิดเผยอะไรของคนอื่น
 */
export async function getAssignedWorkflow(
  user: AuthUser,
  workflowId: string,
  now: Date = new Date(),
): Promise<AssignedWorkflowDetailDto> {
  if (user.type !== 'EXTERNAL') {
    throw new AppError('WORKFLOW_DENIED', 'เส้นทางนี้สำหรับผู้รับงานภายนอกเท่านั้น', 403);
  }

  const row = await prisma.externalWorkflowRequest.findUnique({
    where: { id: workflowId },
    include: { ...workflowInclude, targetResource: true },
  });

  const hidden = notFound('WORKFLOW_NOT_FOUND', 'ไม่พบงานที่ได้รับมอบหมาย');
  if (!row || row.externalUserId !== user.id) throw hidden;
  if (!resourceExposableToPortal(row.targetResource)) throw hidden;

  const status = effectiveWorkflowStatus(row, now);
  return {
    id: row.id,
    title: row.title,
    instructions: row.instructions,
    status,
    target: { id: row.targetResource.id, name: row.targetResource.name },
    permissions: { allowUpload: row.allowUpload, allowDownload: row.allowDownload },
    dueAt: row.dueAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    submissions: await listSubmissions(row.id),
    submissionCount: await prisma.externalWorkflowSubmission.count({ where: { workflowRequestId: row.id } }),
    /*
     * เงื่อนไขเดียวกับที่ submitToWorkflow บังคับใช้จริง (SUBMITTABLE_STATES)
     * หน้าจอจึงไม่มีทางเสนอปุ่มที่กดแล้วถูกปฏิเสธ และไม่มีทางซ่อนปุ่มที่กดได้จริง
     */
    canSubmit: SUBMITTABLE_STATES.includes(row.state) && row.allowUpload && status !== 'EXPIRED',
    latestDecision: await latestDecisionFor(row.id, status),
  };
}
