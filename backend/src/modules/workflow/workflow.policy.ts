import type { ExternalWorkflowState, ResourceAccessLevel } from '@prisma/client';
import type { PortalRole } from '../portal/portal-policy.js';

/**
 * นโยบายของคำขอความร่วมมือจากภายนอก (F26-B)
 *
 * โมดูลนี้เป็นฟังก์ชันบริสุทธิ์ล้วน ไม่แตะฐานข้อมูล ด้วยเหตุผลเดียวกับ portal-policy.ts
 * คือกติกาที่ตัดสินการเข้าถึงต้องทดสอบได้ครบทุกทางโดยไม่ต้องพึ่งข้อมูลจริง
 *
 * **คำขอไม่ใช่แหล่งสิทธิ์** สิทธิ์จริงอยู่ที่ ResourceAccess เสมอ คำขอเป็นเพียงคำอธิบาย
 * ว่าทำไมสิทธิ์นั้นจึงมีอยู่ และเป็นตัวกำหนดว่าเมื่อใดควรหยุด
 */

/**
 * สถานะที่คำนวณแล้ว - เพิ่ม EXPIRED ซึ่งไม่เคยถูกเก็บลงฐานข้อมูล
 *
 * แยกชนิดจาก ExternalWorkflowState ของ Prisma โดยตั้งใจ เพื่อให้ตัวแปลภาษาเตือนทันที
 * ถ้ามีใครพยายามเขียนค่า EXPIRED ลงคอลัมน์ state
 */
export type EffectiveWorkflowStatus = ExternalWorkflowState | 'EXPIRED';

export interface WorkflowTiming {
  state: ExternalWorkflowState;
  expiresAt: Date | null;
}

/**
 * สถานะที่มีผลจริง ณ เวลาที่ถาม - **แหล่งความจริงเดียว**
 *
 * ทุกเส้นทางที่ต้องรู้ว่าคำขอยังใช้ได้ไหมต้องเรียกฟังก์ชันนี้ ห้ามเขียนเงื่อนไข
 * `expiresAt < now` ซ้ำที่อื่น เพราะวันที่กติกาเปลี่ยน จะมีที่หนึ่งที่ลืมแก้เสมอ
 * และที่ลืมแก้นั้นคือที่ที่ยังปล่อยให้ผู้ใช้ภายนอกทำงานต่อได้หลังหมดอายุ
 *
 * ลำดับการตัดสินมีความหมาย: การเพิกถอนเป็นการตัดสินใจของคน จึงชนะการหมดอายุ
 * ซึ่งเป็นเพียงการผ่านไปของเวลา ถ้าสลับลำดับ คำขอที่ถูกเพิกถอนเพราะเหตุร้ายแรง
 * จะถูกรายงานว่า "หมดอายุตามปกติ" ซึ่งกลบเหตุผลที่แท้จริงจากผู้ตรวจสอบ
 */
export function effectiveWorkflowStatus(
  workflow: WorkflowTiming,
  now: Date = new Date(),
): EffectiveWorkflowStatus {
  if (workflow.state === 'REVOKED') return 'REVOKED';
  if (workflow.expiresAt && workflow.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return workflow.state;
}

/**
 * สถานะที่ถือว่า "จบแล้ว" - ไม่มีใครต้องทำอะไรต่อ
 *
 * ใช้ตัดสินว่าคำขอยังกินช่องกันซ้ำอยู่หรือไม่ ไม่ได้ใช้ตัดสินการเข้าถึง
 */
const TERMINAL_STATES: readonly ExternalWorkflowState[] = ['APPROVED', 'REJECTED', 'REVOKED'];

export function isTerminalState(state: ExternalWorkflowState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * คำขอนี้ยังเปิดใช้งานอยู่หรือไม่
 *
 * "เปิดใช้งาน" = ยังไม่จบ ยังไม่ถูกเพิกถอน และยังไม่หมดอายุ
 * ใช้ทั้งกับการกันคำขอซ้ำและกับการตัดสินว่าสิทธิ์ที่ผูกอยู่ควรใช้ได้หรือไม่
 */
export function isWorkflowActive(workflow: WorkflowTiming, now: Date = new Date()): boolean {
  const status = effectiveWorkflowStatus(workflow, now);
  return status !== 'EXPIRED' && !isTerminalState(status as ExternalWorkflowState);
}

/**
 * ค่ากันคำขอซ้ำ - ประกอบจากเอกสารปลายทางกับผู้รับงาน
 *
 * คืน null เมื่อคำขอไม่ได้เปิดใช้งานแล้ว เพื่อให้ปล่อยช่องคืน ดัชนี unique ของ MySQL
 * ยอมให้ null ซ้ำกันได้ คำขอที่จบไปแล้วนับร้อยรายการจึงอยู่ร่วมกันได้โดยไม่ชนกัน
 */
export function activeSlotFor(targetResourceId: string, externalUserId: string): string {
  return `${targetResourceId}:${externalUserId}`;
}

export const WORKFLOW_STATUS_LABEL: Record<EffectiveWorkflowStatus, string> = {
  OPEN: 'รอดำเนินการ',
  SUBMITTED: 'ส่งงานแล้ว',
  UNDER_REVIEW: 'กำลังตรวจ',
  REVISION_REQUESTED: 'ขอให้แก้ไข',
  APPROVED: 'อนุมัติแล้ว',
  REJECTED: 'ไม่อนุมัติ',
  REVOKED: 'ถูกยกเลิก',
  EXPIRED: 'หมดอายุ',
};

/**
 * แปลงธงสิทธิ์ของคำขอเป็นระดับสิทธิ์ของ ResourceAccess
 *
 * **ไม่สร้างความหมายใหม่** แค่เลือกค่าที่มีอยู่แล้วให้ตรงกับเจตนา เพราะฝั่งพื้นที่ลูกค้า
 * แปลง EDITOR เป็น CONTRIBUTOR (อัปโหลดได้ แก้ของเดิมไม่ได้) และ VIEWER เป็นดูอย่างเดียว
 * อยู่แล้ว การเพิ่มระดับใหม่ที่นี่จะกลายเป็นระบบสิทธิ์ชุดที่สองทันที
 */
export function accessLevelForWorkflow(allowUpload: boolean): Extract<ResourceAccessLevel, 'EDITOR' | 'VIEWER'> {
  return allowUpload ? 'EDITOR' : 'VIEWER';
}

export function portalRoleForWorkflow(allowUpload: boolean): PortalRole {
  return allowUpload ? 'CONTRIBUTOR' : 'VIEWER';
}

/* ------------------------------------------------------------------ */
/* ตารางการเปลี่ยนสถานะ (F26-E)                                         */
/* ------------------------------------------------------------------ */

/**
 * **ตารางเดียวที่ตัดสินว่าอะไรเปลี่ยนเป็นอะไรได้**
 *
 * ประกาศเป็นข้อมูล ไม่ใช่กระจายเป็น if ตามเส้นทางต่าง ๆ เพราะกติกาที่กระจายอยู่
 * คือกติกาที่จะขัดกันเองในวันที่มีคนเพิ่มเส้นทางใหม่แล้วลืมดูของเดิม
 *
 * สถานะปลายทาง (APPROVED, REJECTED, REVOKED) ไม่มีทางออก - ตั้งใจให้เป็นอย่างนั้น
 * การ "เปิดคำขอที่ปิดไปแล้วใหม่" ทำให้ประวัติอ่านไม่ออกว่าตกลงงานนี้จบหรือยัง
 * ถ้าต้องทำงานต่อ ให้สั่งงานใบใหม่ ซึ่งมีร่องรอยของตัวเองชัดเจน
 *
 * EXPIRED ไม่อยู่ในตารางนี้เลย เพราะไม่เคยถูกเก็บ - มันคำนวณจากเวลาเสมอ
 * และคำขอที่หมดอายุแล้วถูกปฏิเสธก่อนถึงขั้นตรวจตารางนี้
 */
export const WORKFLOW_TRANSITIONS: Record<ExternalWorkflowState, readonly ExternalWorkflowState[]> = {
  OPEN: ['SUBMITTED', 'REVOKED'],
  SUBMITTED: ['UNDER_REVIEW', 'APPROVED', 'REJECTED', 'REVISION_REQUESTED', 'REVOKED'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED', 'REVISION_REQUESTED', 'REVOKED'],
  REVISION_REQUESTED: ['SUBMITTED', 'REVOKED'],
  APPROVED: [],
  REJECTED: [],
  REVOKED: [],
};

export function canTransition(from: ExternalWorkflowState, to: ExternalWorkflowState): boolean {
  return WORKFLOW_TRANSITIONS[from].includes(to);
}

/** สถานะที่ยอมให้ผู้รับงานส่งไฟล์ - ครั้งแรกและตอนถูกขอให้แก้ไข */
export const SUBMITTABLE_STATES: readonly ExternalWorkflowState[] = ['OPEN', 'REVISION_REQUESTED'];

/**
 * สถานะที่สิทธิ์จากคำขอยัง "ออกฤทธิ์" อยู่ (F26-G §21)
 *
 * ทุกสถานะที่งานยังเดินอยู่ต้องให้สิทธิ์ต่อ เพราะผู้รับงานยังต้องเปิดดูสิ่งที่ตัวเองส่งไป
 * และยังต้องรอฟังผล ส่วนสถานะที่จบแล้วต้องหยุดให้สิทธิ์ทันที
 *
 * SUBMITTED และ UNDER_REVIEW ยังให้สิทธิ์อยู่โดยตั้งใจ - ถ้าตัดตอนส่งเสร็จ ผู้รับงาน
 * จะเห็นหน้าว่างทันทีที่กดส่ง ซึ่งดูเหมือนงานหาย ทั้งที่งานอยู่ระหว่างการตรวจตามปกติ
 *
 * ค่านี้คือ isTerminalState กลับด้าน ประกาศแยกไว้เพื่อให้เอกสารและเทสต์อ้างถึงได้ตรง ๆ
 */
export const ACCESS_CONTRIBUTING_STATES: readonly ExternalWorkflowState[] = [
  'OPEN',
  'SUBMITTED',
  'UNDER_REVIEW',
  'REVISION_REQUESTED',
];

/* ------------------------------------------------------------------ */
/* เหตุผลประกอบการตัดสิน                                                */
/* ------------------------------------------------------------------ */

/** เหตุผลต้องอธิบายได้จริง ไม่ใช่จุดเดียวหรือช่องว่างเพื่อผ่านช่องบังคับ */
export const MIN_REASON_LENGTH = 10;
export const MAX_REASON_LENGTH = 500;

/**
 * ตรวจเหตุผล - ตัดช่องว่างหัวท้ายก่อนวัดเสมอ
 *
 * ช่องว่างล้วนยาวสามสิบตัวอักษรไม่ใช่เหตุผล และการยอมรับมันแปลว่าช่องบังคับนี้
 * ไม่ได้บังคับอะไรเลย คืนค่าที่ตัดแล้วเพื่อให้ผู้เรียกเก็บค่าเดียวกับที่ตรวจ
 */
export function normalizeRequiredReason(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed.length < MIN_REASON_LENGTH) return null;
  return trimmed.slice(0, MAX_REASON_LENGTH);
}

export function normalizeOptionalReason(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, MAX_REASON_LENGTH);
}
