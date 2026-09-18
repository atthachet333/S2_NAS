/**
 * การส่งงานผ่านคำขอความร่วมมือ (F26-D)
 *
 * **ปลายทางถูกตรึงไว้ที่ฝั่งเซิร์ฟเวอร์เสมอ** ผู้เรียกส่งมาได้เพียงรหัสคำขอกับตัวไฟล์
 * โฟลเดอร์ปลายทางอ่านจากแถวคำขอ ไม่เคยรับจากผู้เรียก เส้นทางที่รับปลายทางจากผู้เรียก
 * แล้วค่อยตรวจทีหลัง คือเส้นทางที่พลาดครั้งเดียวก็เขียนไฟล์ลงที่ที่ไม่ควรลง
 *
 * **ลำดับของการทำงานถูกเลือกมาเพื่อไม่ให้เหลือสถานะกำกวม**
 *
 *   1. ตรวจนโยบายครั้งแรก (ก่อนรับไบต์ - ไม่รับของถ้ารู้อยู่แล้วว่าจะปฏิเสธ)
 *   2. อัปโหลดผ่านเส้นทางปกติทั้งหมด (checksum เวอร์ชัน ที่เก็บ การตรวจชนิด/ขนาด)
 *   3. **ตรวจนโยบายซ้ำ** - ระหว่างที่ไฟล์กำลังไหล คำขออาจหมดอายุ ถูกยกเลิก
 *      หรือโฟลเดอร์อาจถูกยกชั้นความลับ การตรวจครั้งเดียวตอนเริ่มจึงไม่พอ
 *   4. ผูกการส่งกับคำขอในธุรกรรมเดียว พร้อมเปลี่ยนสถานะแบบ compare-and-swap
 *   5. ถ้าขั้นใดหลังอัปโหลดล้ม → ลบทั้งแถวและไบต์ที่เพิ่งเขียนไป ไม่ทิ้งขยะไว้
 *
 * ขั้นที่ 4 เป็นตัวเลือกผู้ชนะเมื่อมีคนกดส่งพร้อมกัน - ฐานข้อมูลเป็นผู้ตัดสิน ไม่ใช่ปุ่มที่ถูกกดปิด
 */
import type { Readable } from 'node:stream';
import { prisma } from '../../core/prisma.js';
import { AppError, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { deleteStoredFile, removeResourceDirectory } from '../../core/file-storage.js';
import { uploadToPortalFolder } from '../portal/portal.service.js';
import { resourceExposableToPortal } from '../portal/portal-access.js';
import type { AuthUser } from '../auth/auth.service.js';
import {
  SUBMITTABLE_STATES,
  canTransition,
  effectiveWorkflowStatus,
  type EffectiveWorkflowStatus,
} from './workflow.policy.js';

export interface AuditContext {
  ipAddress?: string;
  userAgent?: string;
}

/**
 * สถานะที่รับการส่งงานได้ (F26-F)
 *
 * OPEN = ส่งครั้งแรก · REVISION_REQUESTED = ส่งฉบับแก้
 * ทั้งสองกรณีใช้เส้นทางเดียวกันทุกประการ ต่างกันเพียงลำดับที่ได้และสถานะเดิมที่ CAS เทียบ
 */
const SUBMITTABLE_STATUSES: readonly EffectiveWorkflowStatus[] = [...SUBMITTABLE_STATES];

/**
 * ฉบับปัจจุบันของคำขอ = ลำดับสูงสุด - **แหล่งความจริงเดียว**
 *
 * ไม่เก็บ currentSubmissionId ที่แก้ไขได้ไว้อีกที่ เพราะสองแหล่งที่บอกว่า "ฉบับไหนคือฉบับล่าสุด"
 * จะไม่ตรงกันในวันที่เส้นทางใดลืมอัปเดตอันหนึ่ง แล้วผู้ตรวจจะตัดสินฉบับผิดโดยไม่มีใครรู้
 */
export async function currentSubmission(workflowId: string) {
  return prisma.externalWorkflowSubmission.findFirst({
    where: { workflowRequestId: workflowId },
    orderBy: { sequence: 'desc' },
  });
}

export interface SubmissionDto {
  id: string;
  sequence: number;
  submittedAt: Date;
  file: { id: string; name: string; size: number | null; mimeType: string | null };
}

/**
 * ตรวจว่าคำขอนี้รับงานได้จริง ณ เวลานี้
 *
 * ใช้ทั้งก่อนอัปโหลดและหลังอัปโหลด - ฟังก์ชันเดียว ผลลัพธ์เดียว ไม่มีทางที่สองครั้งนั้น
 * จะใช้เกณฑ์ต่างกัน ซึ่งเป็นช่องว่างที่ผู้โจมตีอาศัยจังหวะได้
 *
 * ตอบเหมือนกรณีไม่พบสำหรับทุกเหตุผลที่เกี่ยวกับการมองเห็น เพื่อไม่ให้ผู้รับงานเดาได้ว่า
 * โฟลเดอร์นั้นมีอยู่จริงหรือไม่ ส่วนเหตุผลที่เกี่ยวกับ "งานนี้ยังทำได้ไหม" บอกได้
 * เพราะผู้รับงานรู้อยู่แล้วว่ามีงานใบนี้อยู่
 */
async function assertSubmittable(user: AuthUser, workflowId: string, now: Date) {
  const workflow = await prisma.externalWorkflowRequest.findUnique({
    where: { id: workflowId },
    include: { targetResource: true },
  });

  // ไม่ใช่ของตัวเอง = ไม่มีอยู่ ในสายตาผู้เรียก
  if (!workflow || workflow.externalUserId !== user.id) {
    throw notFound('WORKFLOW_NOT_FOUND', 'ไม่พบงานที่ได้รับมอบหมาย');
  }
  // โฟลเดอร์ถูกปิดด้วยชั้นความลับหรือวงจรชีวิต - ไม่เปิดเผยว่าเกิดอะไรขึ้นกับมัน
  if (!resourceExposableToPortal(workflow.targetResource)) {
    throw notFound('WORKFLOW_NOT_FOUND', 'ไม่พบงานที่ได้รับมอบหมาย');
  }

  const status = effectiveWorkflowStatus(workflow, now);
  if (!SUBMITTABLE_STATUSES.includes(status)) {
    throw new AppError(
      'WORKFLOW_NOT_SUBMITTABLE',
      status === 'EXPIRED'
        ? 'งานนี้หมดเวลาส่งแล้ว'
        : status === 'REVOKED'
          ? 'งานนี้ถูกยกเลิกแล้ว'
          : 'งานนี้ส่งเพิ่มไม่ได้ในสถานะปัจจุบัน',
      409,
    );
  }

  /*
   * สิทธิ์ของ "งาน" ไม่ใช่สิทธิ์ของ "พื้นที่" (§12)
   *
   * ต้องดู workflow.allowUpload ตรง ๆ ไม่ใช่ดูว่าผู้รับงานอัปโหลดเข้าโฟลเดอร์นี้ได้ไหม
   * ถ้าดูอย่างหลัง สิทธิ์ EDITOR ที่ผู้ดูแลเคยมอบไว้ด้วยมือจะเปลี่ยนงานประเภท "อ่านอย่างเดียว"
   * ให้กลายเป็นงานที่ส่งไฟล์ได้ ทั้งที่คนสั่งงานตั้งใจไม่ให้ส่ง
   */
  if (!workflow.allowUpload) {
    throw new AppError('WORKFLOW_UPLOAD_NOT_ALLOWED', 'งานนี้ไม่ได้เปิดให้ส่งไฟล์', 403);
  }

  return workflow;
}

export async function submitToWorkflow(
  user: AuthUser,
  workflowId: string,
  source: Readable,
  input: { fileName: string; declaredMime?: string },
  audit: AuditContext,
  now: Date = new Date(),
): Promise<SubmissionDto> {
  if (user.type !== 'EXTERNAL') {
    throw new AppError('WORKFLOW_DENIED', 'เส้นทางนี้สำหรับผู้รับงานภายนอกเท่านั้น', 403);
  }

  // (1) ตรวจก่อนรับไบต์ - ไม่รับของถ้ารู้อยู่แล้วว่าจะปฏิเสธ
  const workflow = await assertSubmittable(user, workflowId, now);
  /*
   * จำสถานะที่เห็นตอนเริ่มไว้ เพื่อใช้เป็นเงื่อนไขของ CAS ตอนผูก
   *
   * ต้องเป็นค่านี้ ไม่ใช่ 'OPEN' ตายตัว เพราะการส่งฉบับแก้เริ่มจาก REVISION_REQUESTED
   * และผู้แพ้ในการแข่งกันส่งต้องเป็นคนที่สถานะเปลี่ยนไปแล้วระหว่างทาง
   */
  const stateAtStart = workflow.state;

  /*
   * (2) อัปโหลดผ่านเส้นทางปกติของพื้นที่ลูกค้าทั้งหมด
   *
   * ปลายทางมาจาก workflow.targetResourceId ที่อ่านจากฐานข้อมูล ไม่ใช่จากผู้เรียก
   * เส้นทางนี้ให้ checksum การตรวจชนิดและขนาด กติกาชื่อซ้ำ ที่เก็บแบบ provider-neutral
   * เจ้าของที่ถูกต้อง (สืบทอดจากโฟลเดอร์) และบันทึก EXTERNAL_FILE_UPLOADED มาครบ
   * และมันยังตรวจสิทธิ์ของพื้นที่ซ้ำอีกชั้นด้วย ซึ่งไม่เสียหายที่จะตรวจซ้ำ
   */
  const uploaded = await uploadToPortalFolder(
    user,
    workflow.targetResourceId,
    source,
    input,
    audit,
    now,
  );

  const compensate = async (reason: string) => {
    /*
     * ชดเชยเมื่อผูกไม่สำเร็จ - ลบทั้งแถวและไบต์
     *
     * ต้องอ่าน storageKey ก่อนลบแถว มิฉะนั้นจะไม่มีทางรู้ว่าไฟล์อยู่ที่ไหนอีกเลย
     * และมันจะกลายเป็นไบต์กำพร้าที่ไม่มีใครตามไปเก็บได้
     */
    try {
      const versions = await prisma.resourceVersion.findMany({
        where: { resourceId: uploaded.id },
        select: { storageKey: true, storageProvider: true },
      });
      await prisma.resource.deleteMany({ where: { id: uploaded.id } });
      for (const version of versions) {
        await deleteStoredFile(version.storageKey, version.storageProvider);
        await removeResourceDirectory(uploaded.id, version.storageProvider);
      }
    } catch (error) {
      /*
       * การชดเชยเองล้มเหลว - ไบต์ยังอยู่บนที่เก็บโดยไม่มีแถวใดอ้างถึง (F26-G §26)
       *
       * เดิมจุดนี้เขียน log แล้วจบ ซึ่งแปลว่าไฟล์กำพร้าจะหายไปจากความสนใจของทุกคน
       * ทันทีที่ log หมุนรอบ ตอนนี้บันทึกเป็นแถวถาวรที่ค้นหาได้ เพื่อให้ผู้ดูแลตามเก็บได้
       * และเพื่อให้ auditStorage (ซึ่งมีการตรวจหาวัตถุกำพร้าอยู่แล้ว) มีจุดอ้างอิงว่า
       * ของชิ้นนั้นมาจากไหนและเมื่อไร
       *
       * ตั้งใจไม่สร้างคิวงานหรือระบบลองใหม่อัตโนมัติ - สิ่งที่ขาดคือ "มองเห็นและตามเก็บได้"
       * ไม่ใช่ "หายเองโดยไม่มีใครดู" การลองใหม่อัตโนมัติขณะที่ที่เก็บล่มอยู่ยังล้มเหมือนเดิม
       */
      logger.error({ err: error }, '[WORKFLOW] ชดเชยการส่งงานที่ล้มเหลวไม่สำเร็จ');
      try {
        await prisma.activityLog.create({
          data: {
            userId: user.id,
            action: 'STORAGE_CLEANUP_FAILED',
            resourceId: null,
            metadata: {
              workflowId,
              orphanedResourceId: uploaded.id,
              stage: 'WORKFLOW_SUBMISSION_COMPENSATION',
              reason,
            },
          },
        });
      } catch (logError) {
        logger.error({ err: logError }, '[WORKFLOW] บันทึกร่องรอยการชดเชยที่ล้มเหลวไม่ได้');
      }
    }
    logger.warn(`[WORKFLOW] ยกเลิกการส่งงานและลบไฟล์ที่อัปโหลดไปแล้ว: ${reason}`);
  };

  try {
    // (3) ตรวจนโยบายซ้ำ - สถานะอาจเปลี่ยนไปแล้วระหว่างที่ไฟล์กำลังไหล
    await assertSubmittable(user, workflowId, new Date());

    // (4) ผูกการส่งและเปลี่ยนสถานะในธุรกรรมเดียว
    const submission = await prisma.$transaction(async (tx) => {
      /*
       * compare-and-swap บนสถานะ - ฐานข้อมูลเป็นผู้เลือกผู้ชนะเมื่อกดส่งพร้อมกัน
       *
       * ผู้แพ้ได้ count = 0 และจะถูกชดเชยไป ไม่ต้องพึ่งการปิดปุ่มบนหน้าจอ
       * และไม่ต้องพึ่งจังหวะของการอ่านก่อนเขียน ซึ่งแพ้การกดพร้อมกันเสมอ
       */
      if (!canTransition(stateAtStart, 'SUBMITTED')) {
        throw new AppError('WORKFLOW_INVALID_TRANSITION', 'สถานะนี้ส่งงานไม่ได้', 409);
      }
      const claimed = await tx.externalWorkflowRequest.updateMany({
        where: { id: workflowId, state: stateAtStart },
        data: { state: 'SUBMITTED' },
      });
      if (claimed.count === 0) {
        throw new AppError('WORKFLOW_ALREADY_SUBMITTED', 'งานนี้ถูกส่งไปแล้ว', 409);
      }

      /*
       * ลำดับถัดไป - อ่านภายในธุรกรรมเดียวกับที่เขียน
       *
       * ถ้าสองคนแข่งกันส่งฉบับแก้ คนที่สองจะได้ลำดับเดียวกันแล้วชนดัชนี unique
       * (workflowRequestId, sequence) ซึ่งทำให้ธุรกรรมล้มและถูกชดเชย
       * ตัว CAS ข้างบนกันไว้ชั้นหนึ่งแล้ว ดัชนีนี้เป็นชั้นที่สองที่ฐานข้อมูลรับประกันเอง
       */
      const previous = await tx.externalWorkflowSubmission.findFirst({
        where: { workflowRequestId: workflowId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });

      const row = await tx.externalWorkflowSubmission.create({
        data: {
          workflowRequestId: workflowId,
          resourceId: uploaded.id,
          submittedById: user.id,
          sequence: (previous?.sequence ?? 0) + 1,
        },
      });

      await tx.activityLog.create({
        data: {
          userId: user.id,
          action: 'EXTERNAL_SUBMISSION_CREATED',
          resourceId: uploaded.id,
          ipAddress: audit.ipAddress,
          userAgent: audit.userAgent?.slice(0, 500),
          // ไม่มีเนื้อหาไฟล์ ไม่มี storageKey ไม่มีโทเคน
          metadata: { workflowId, submissionId: row.id, sequence: row.sequence },
        },
      });

      return row;
    });

    logger.info('[WORKFLOW] ผู้รับงานส่งไฟล์เข้าคำขอที่ได้รับมอบหมาย');
    return {
      id: submission.id,
      sequence: submission.sequence,
      submittedAt: submission.submittedAt,
      file: { id: uploaded.id, name: uploaded.name, size: uploaded.size, mimeType: uploaded.mimeType },
    };
  } catch (error) {
    // (5) ล้มหลังอัปโหลดแล้ว - เก็บกวาดให้หมด ไม่เหลือทั้งแถวและไบต์
    await compensate(error instanceof AppError ? error.code : 'unexpected');
    throw error;
  }
}

/**
 * ไฟล์ที่ส่งไปแล้วของคำขอหนึ่งใบ
 *
 * **ไม่ตรวจสิทธิ์ซ้ำที่นี่** ผู้เรียกต้องผ่านด่านของตัวเองมาก่อน ฟังก์ชันนี้เป็นเพียง
 * การอ่านที่ถูกเรียกหลังจากรู้แล้วว่าผู้เรียกเห็นคำขอใบนี้ได้
 */
export async function listSubmissions(workflowId: string): Promise<SubmissionDto[]> {
  const rows = await prisma.externalWorkflowSubmission.findMany({
    where: { workflowRequestId: workflowId },
    include: { resource: { select: { id: true, name: true, size: true, mimeType: true, deletedAt: true } } },
    orderBy: [{ sequence: 'asc' }],
  });

  return rows
    // ไฟล์ที่ถูกลบไปแล้วไม่แสดง แต่แถวการส่งยังอยู่เป็นหลักฐานว่าเคยส่ง
    .filter((row) => row.resource.deletedAt === null)
    .map((row) => ({
      id: row.id,
      sequence: row.sequence,
      submittedAt: row.submittedAt,
      file: {
        id: row.resource.id,
        name: row.resource.name,
        size: row.resource.size === null ? null : Number(row.resource.size),
        mimeType: row.resource.mimeType,
      },
    }));
}

/**
 * การส่งงานของคำขอหลายใบพร้อมกัน - ใช้โดยหน้ารายการฝั่งภายใน
 *
 * มีไว้เพื่อไม่ให้หน้ารายการยิงคำสั่งต่อแถว ซึ่งเป็นรูปแบบที่ช้าลงเรื่อย ๆ
 * ตามจำนวนงานโดยไม่มีใครสังเกตจนกว่าจะมีงานหลายร้อยใบ
 */
export async function listSubmissionsForWorkflows(
  workflowIds: string[],
): Promise<Map<string, SubmissionDto[]>> {
  const grouped = new Map<string, SubmissionDto[]>();
  if (workflowIds.length === 0) return grouped;

  const rows = await prisma.externalWorkflowSubmission.findMany({
    where: { workflowRequestId: { in: workflowIds } },
    include: { resource: { select: { id: true, name: true, size: true, mimeType: true, deletedAt: true } } },
    orderBy: [{ sequence: 'asc' }],
  });

  for (const row of rows) {
    if (row.resource.deletedAt !== null) continue;
    const list = grouped.get(row.workflowRequestId) ?? [];
    list.push({
      id: row.id,
      sequence: row.sequence,
      submittedAt: row.submittedAt,
      file: {
        id: row.resource.id,
        name: row.resource.name,
        size: row.resource.size === null ? null : Number(row.resource.size),
        mimeType: row.resource.mimeType,
      },
    });
    grouped.set(row.workflowRequestId, list);
  }
  return grouped;
}
