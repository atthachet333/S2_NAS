/**
 * การตรวจงาน การขอให้แก้ไข และการยกเลิกคำขอ (F26-E / F26-G)
 *
 * **ทุกการเปลี่ยนสถานะผ่านฟังก์ชันเดียว** คือ `applyTransition` ซึ่งตรวจตารางการเปลี่ยนสถานะ
 * แล้วเขียนแบบ compare-and-swap ในธุรกรรมเดียวกับบันทึกการตรวจสอบ
 *
 * ที่ต้องเป็น CAS ไม่ใช่ "อ่านแล้วค่อยเขียน" เพราะสองคนกดพร้อมกันได้จริง - ผู้ตรวจสองคน
 * กดอนุมัติกับไม่อนุมัติในวินาทีเดียวกัน หรือผู้ตรวจกดอนุมัติพอดีกับที่ผู้รับงานส่งฉบับแก้มา
 * การอ่านก่อนเขียนจะให้ทั้งคู่ผ่านด่านตรวจ แล้วคนเขียนทีหลังชนะโดยไม่มีใครรู้ว่าเกิดอะไรขึ้น
 *
 * **ไม่แตะ ResourceAccess เลย** การยกเลิกคำขอคือการเปลี่ยนสถานะ ไม่ใช่การลบสิทธิ์
 * สิทธิ์ที่ผู้ดูแลมอบด้วยมือไว้ต่างหากยังอยู่ครบ และหลักฐานว่าเคยมีคำขอนี้ก็ยังอยู่
 * (เส้นทาง revokeAccess เดิมลบแถวสิทธิ์ทิ้ง จึงห้ามใช้กับงานนี้เด็ดขาด)
 */
import type { ExternalWorkflowState } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { AppError, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { resourceExposableToPortal } from '../portal/portal-access.js';
import { assertMayManageAccess } from '../workspace/sharing.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import {
  canTransition,
  effectiveWorkflowStatus,
  normalizeOptionalReason,
  normalizeRequiredReason,
  MIN_REASON_LENGTH,
} from './workflow.policy.js';
import { currentSubmission } from './submission.service.js';

export interface AuditContext {
  ipAddress?: string;
  userAgent?: string;
}

type ReviewAction =
  | 'EXTERNAL_REVIEW_STARTED'
  | 'EXTERNAL_REVIEW_APPROVED'
  | 'EXTERNAL_REVIEW_REJECTED'
  | 'EXTERNAL_REVISION_REQUESTED'
  | 'EXTERNAL_WORKFLOW_REVOKED';

/**
 * ผู้ที่ตรวจงานได้ = ผู้ที่จัดการสิทธิ์ของโฟลเดอร์ปลายทางได้
 *
 * ใช้ด่านเดียวกับที่การแชร์และการสร้างคำขอใช้ (assertMayManageAccess) ไม่ใช่แค่
 * "เป็นบุคลากรภายใน" เพราะการอนุมัติงานคือการรับรองเอกสารที่เข้ามาอยู่ในโฟลเดอร์นั้น
 * คนที่แชร์โฟลเดอร์นั้นไม่ได้ ก็ไม่ควรตัดสินว่าเอกสารในนั้นผ่านหรือไม่ผ่าน
 *
 * ด่านนี้ตรวจทั้งการมองเห็นและสิทธิ์จัดการ จึงปิดการเข้าถึงข้ามขอบเขตไปในตัว
 */
async function loadReviewable(user: AuthUser, workflowId: string, now: Date) {
  if (user.type !== 'INTERNAL') {
    throw new AppError('WORKFLOW_REVIEW_DENIED', 'เส้นทางนี้สำหรับบุคลากรภายในเท่านั้น', 403);
  }

  const workflow = await prisma.externalWorkflowRequest.findUnique({
    where: { id: workflowId },
    include: { targetResource: true },
  });
  if (!workflow) throw notFound('WORKFLOW_NOT_FOUND', 'ไม่พบคำขอความร่วมมือ');

  // ต้องมีสิทธิ์จัดการโฟลเดอร์ปลายทาง - โยน 403/404 ตามกติกาเดิมของด่านนั้น
  await assertMayManageAccess(workflow.targetResourceId, user);

  return { workflow, status: effectiveWorkflowStatus(workflow, now) };
}

interface TransitionInput {
  workflowId: string;
  to: ExternalWorkflowState;
  action: ReviewAction;
  reason: string | null;
  /**
   * ฉบับที่ผู้ตรวจตั้งใจตัดสิน - ต้องยังเป็นฉบับล่าสุดอยู่
   *
   * ป้องกันการอนุมัติฉบับที่ล้าสมัย: ผู้ตรวจเปิดหน้าจอตอนฉบับที่ 1 เป็นฉบับปัจจุบัน
   * ระหว่างนั้นผู้รับงานส่งฉบับที่ 2 มา ถ้าตรวจแค่สถานะ การกดอนุมัติจะผ่าน
   * และประวัติจะบันทึกว่า "อนุมัติแล้ว" ทั้งที่คนอนุมัติไม่เคยเห็นสิ่งที่เพิ่งอนุมัติไป
   */
  expectedSubmissionId?: string | null;
}

/**
 * เปลี่ยนสถานะแบบ compare-and-swap พร้อมบันทึกหลักฐานในธุรกรรมเดียว
 *
 * คืนสถานะก่อนและหลัง เพื่อให้ผู้เรียกและบันทึกการตรวจสอบพูดตรงกันเสมอ
 */
async function applyTransition(
  user: AuthUser,
  input: TransitionInput,
  audit: AuditContext,
  now: Date,
) {
  const { workflow, status } = await loadReviewable(user, input.workflowId, now);

  /*
   * หมดอายุแล้วเปลี่ยนสถานะไม่ได้ ยกเว้นการยกเลิก
   *
   * การยกเลิกคำขอที่หมดอายุไปแล้วยังมีความหมาย - เป็นการประกาศว่างานนี้จบด้วยการยกเลิก
   * ไม่ใช่จบเพราะปล่อยให้เลยเวลา ซึ่งเป็นข้อเท็จจริงคนละอย่างในสายตาผู้ตรวจสอบ
   */
  if (status === 'EXPIRED' && input.to !== 'REVOKED') {
    throw new AppError('WORKFLOW_EXPIRED', 'คำขอนี้หมดอายุแล้ว', 409);
  }

  if (!canTransition(workflow.state, input.to)) {
    throw new AppError(
      'WORKFLOW_INVALID_TRANSITION',
      `เปลี่ยนสถานะจาก "${workflow.state}" เป็น "${input.to}" ไม่ได้`,
      409,
    );
  }

  const current = await currentSubmission(input.workflowId);
  if (input.expectedSubmissionId !== undefined && input.expectedSubmissionId !== null) {
    if (!current || current.id !== input.expectedSubmissionId) {
      throw new AppError(
        'WORKFLOW_REVIEW_STALE',
        'มีการส่งงานฉบับใหม่เข้ามาแล้ว กรุณาเปิดดูฉบับล่าสุดก่อนตัดสิน',
        409,
      );
    }
  }

  const from = workflow.state;

  return prisma.$transaction(async (tx) => {
    /*
     * เงื่อนไขของ CAS รวมทั้งสถานะเดิม - ผู้แพ้ได้ count = 0 และถูกปฏิเสธอย่างชัดเจน
     * ไม่ใช่เขียนทับผลของผู้ชนะเงียบ ๆ
     */
    const claimed = await tx.externalWorkflowRequest.updateMany({
      where: { id: input.workflowId, state: from },
      data: {
        state: input.to,
        /*
         * ปล่อยช่องกันคำขอซ้ำเมื่อคำขอจบแล้ว เพื่อให้สั่งงานใบใหม่บนคู่เดิมได้
         * ช่องนี้เป็นตัวกันการกดซ้ำ ไม่ใช่สถานะ - ดู workflow.policy.ts
         */
        ...(input.to === 'APPROVED' || input.to === 'REJECTED' || input.to === 'REVOKED'
          ? { activeSlot: null }
          : {}),
      },
    });
    if (claimed.count === 0) {
      throw new AppError(
        'WORKFLOW_STATE_CONFLICT',
        'สถานะของคำขอถูกเปลี่ยนโดยผู้อื่นไปแล้ว กรุณาโหลดใหม่',
        409,
      );
    }

    await tx.activityLog.create({
      data: {
        userId: user.id,
        action: input.action,
        resourceId: workflow.targetResourceId,
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent?.slice(0, 500),
        /*
         * บันทึกก่อน/หลังเสมอ ผู้ตรวจสอบต้องอ่านลำดับเหตุการณ์ได้โดยไม่ต้องเดา
         * ไม่มีเนื้อหาไฟล์ ไม่มี storageKey - อ้างด้วยรหัสแถวเท่านั้น
         */
        metadata: {
          workflowId: input.workflowId,
          fromState: from,
          toState: input.to,
          submissionId: current?.id ?? null,
          submittedResourceId: current?.resourceId ?? null,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      },
    });

    return { from, to: input.to, submissionId: current?.id ?? null };
  });
}

/* ------------------------------------------------------------------ */
/* การกระทำของผู้ตรวจ                                                   */
/* ------------------------------------------------------------------ */

export interface ReviewInput {
  reason?: string | null;
  /** ฉบับที่ผู้ตรวจกำลังตัดสิน - ส่งมาเพื่อกันการตัดสินฉบับที่ล้าสมัย */
  submissionId?: string | null;
}

function requireReason(reason: string | null | undefined, what: string): string {
  const normalized = normalizeRequiredReason(reason);
  if (!normalized) {
    throw new AppError(
      'WORKFLOW_REASON_REQUIRED',
      `ต้องระบุเหตุผลของการ${what}อย่างน้อย ${MIN_REASON_LENGTH} ตัวอักษร`,
      400,
    );
  }
  return normalized;
}

export async function startReview(user: AuthUser, workflowId: string, audit: AuditContext, now = new Date()) {
  const result = await applyTransition(
    user,
    { workflowId, to: 'UNDER_REVIEW', action: 'EXTERNAL_REVIEW_STARTED', reason: null },
    audit,
    now,
  );
  logger.info('[WORKFLOW] เริ่มตรวจงานที่ลูกค้าส่งมา');
  return result;
}

/** อนุมัติ - เหตุผลไม่บังคับ เพราะการยอมรับงานไม่ต้องอธิบายว่าทำไมจึงยอมรับ */
export async function approveWorkflow(
  user: AuthUser, workflowId: string, input: ReviewInput, audit: AuditContext, now = new Date(),
) {
  const result = await applyTransition(
    user,
    {
      workflowId, to: 'APPROVED', action: 'EXTERNAL_REVIEW_APPROVED',
      reason: normalizeOptionalReason(input.reason),
      expectedSubmissionId: input.submissionId,
    },
    audit,
    now,
  );
  logger.info('[WORKFLOW] อนุมัติงานที่ลูกค้าส่งมา');
  return result;
}

/** ไม่อนุมัติ - เหตุผลบังคับ ผู้รับงานต้องรู้ว่าทำไมงานถึงไม่ผ่าน */
export async function rejectWorkflow(
  user: AuthUser, workflowId: string, input: ReviewInput, audit: AuditContext, now = new Date(),
) {
  const reason = requireReason(input.reason, 'ไม่อนุมัติ');
  const result = await applyTransition(
    user,
    {
      workflowId, to: 'REJECTED', action: 'EXTERNAL_REVIEW_REJECTED', reason,
      expectedSubmissionId: input.submissionId,
    },
    audit,
    now,
  );
  logger.info('[WORKFLOW] ไม่อนุมัติงานที่ลูกค้าส่งมา');
  return result;
}

/** ขอให้แก้ไข - เหตุผลบังคับ เพราะมันคือคำสั่งงานรอบถัดไป ไม่ใช่แค่การปฏิเสธ */
export async function requestRevision(
  user: AuthUser, workflowId: string, input: ReviewInput, audit: AuditContext, now = new Date(),
) {
  const reason = requireReason(input.reason, 'ขอให้แก้ไข');
  const result = await applyTransition(
    user,
    {
      workflowId, to: 'REVISION_REQUESTED', action: 'EXTERNAL_REVISION_REQUESTED', reason,
      expectedSubmissionId: input.submissionId,
    },
    audit,
    now,
  );
  logger.info('[WORKFLOW] ขอให้ลูกค้าแก้ไขงาน');
  return result;
}

/**
 * ยกเลิกคำขอ (F26-G)
 *
 * เปลี่ยนสถานะอย่างเดียว - ไม่ลบแถวคำขอ ไม่ลบแถวการส่งงาน ไม่ลบไฟล์ ไม่แตะ ResourceAccess
 * สิทธิ์ที่มาจากคำขอหยุดออกฤทธิ์ทันทีเพราะ REVOKED ไม่อยู่ในสถานะที่ให้สิทธิ์
 * ส่วนสิทธิ์ที่ผู้ดูแลมอบด้วยมือไว้ไม่เกี่ยวข้องและไม่ถูกแตะ
 */
export async function revokeWorkflow(
  user: AuthUser, workflowId: string, input: { reason?: string | null }, audit: AuditContext, now = new Date(),
) {
  const reason = requireReason(input.reason, 'ยกเลิก');
  const result = await applyTransition(
    user,
    { workflowId, to: 'REVOKED', action: 'EXTERNAL_WORKFLOW_REVOKED', reason },
    audit,
    now,
  );
  logger.info('[WORKFLOW] ยกเลิกคำขอความร่วมมือ');
  return result;
}

/* ------------------------------------------------------------------ */
/* ประวัติของคำขอ (F26-G §25)                                           */
/* ------------------------------------------------------------------ */

export interface WorkflowHistoryEntry {
  action: string;
  at: Date;
  actor: { id: string; displayName: string } | null;
  fromState: string | null;
  toState: string | null;
  reason: string | null;
  sequence: number | null;
}

const HISTORY_ACTIONS = [
  'EXTERNAL_WORKFLOW_CREATED',
  'EXTERNAL_SUBMISSION_CREATED',
  'EXTERNAL_REVIEW_STARTED',
  'EXTERNAL_REVIEW_APPROVED',
  'EXTERNAL_REVIEW_REJECTED',
  'EXTERNAL_REVISION_REQUESTED',
  'EXTERNAL_WORKFLOW_REVOKED',
];

/**
 * ลำดับเหตุการณ์ของคำขอหนึ่งใบ - **อ่านจากบันทึกการตรวจสอบ ไม่เก็บซ้ำ**
 *
 * ประวัติที่เก็บแยกอีกชุดคือประวัติที่จะไม่ตรงกับบันทึกจริงในวันที่มีเส้นทางใดลืมเขียนลงทั้งสองที่
 * บันทึกการตรวจสอบเป็นของที่แก้ไม่ได้อยู่แล้ว จึงเป็นแหล่งที่ถูกต้องกว่าโดยธรรมชาติ
 */
export async function workflowHistory(
  user: AuthUser,
  workflowId: string,
  now = new Date(),
): Promise<WorkflowHistoryEntry[]> {
  await loadReviewable(user, workflowId, now);

  const logs = await prisma.activityLog.findMany({
    where: { action: { in: HISTORY_ACTIONS } },
    include: { user: { select: { id: true, displayName: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 500,
  });

  return logs
    .filter((log) => (log.metadata as Record<string, unknown> | null)?.workflowId === workflowId)
    .map((log) => {
      const metadata = (log.metadata ?? {}) as Record<string, unknown>;
      return {
        action: log.action,
        at: log.createdAt,
        actor: log.user ? { id: log.user.id, displayName: log.user.displayName } : null,
        fromState: typeof metadata.fromState === 'string' ? metadata.fromState : null,
        toState: typeof metadata.toState === 'string' ? metadata.toState : null,
        reason: typeof metadata.reason === 'string' ? metadata.reason : null,
        sequence: typeof metadata.sequence === 'number' ? metadata.sequence : null,
      };
    });
}

/** เปิดเผยด่านตรวจให้เส้นทางอื่นใช้ร่วม - ไม่ให้ใครเขียนเงื่อนไขของตัวเองขึ้นมาใหม่ */
export { loadReviewable as assertMayReviewWorkflow };

/** ตรวจว่าโฟลเดอร์ปลายทางยังเปิดออกนอกองค์กรได้ - เพดานยังอยู่เหนือทุกสถานะ */
export function targetStillExposable(resource: Parameters<typeof resourceExposableToPortal>[0]): boolean {
  return resourceExposableToPortal(resource);
}
