/**
 * ด่านตรวจของวงจรชีวิตเอกสาร
 *
 * ที่นี่คือ **จุดเดียว** ที่ตัดสินว่า "การทำลายข้อมูลชิ้นนี้ทำได้หรือไม่"
 *
 * ทุกเส้นทางที่ทำลายข้อมูลต้องผ่านฟังก์ชันในไฟล์นี้ ไม่ว่าจะเป็นผู้ใช้กดลบเอง
 * งานเก็บกวาดถังขยะตามอายุ หรือการลบเวอร์ชันเก่า
 *
 * เหตุผลที่ต้องรวมไว้ที่เดียว: กติกาการเก็บรักษาที่มีสองชุดจะเพี้ยนจากกันเสมอ
 * และในงานลักษณะนี้ "เพี้ยน" แปลว่าเอกสารที่กฎหมายบังคับให้เก็บถูกลบไปแล้ว
 * ซึ่งกู้กลับไม่ได้และอธิบายกับผู้ตรวจสอบไม่ได้
 *
 * ลำดับการตรวจ (สำคัญ - ตรวจอันที่แข็งที่สุดก่อน):
 *   1. Legal Hold        - แข็งที่สุด ไม่มีวันหมดอายุเอง
 *   2. เก็บถาวร           - ไม่มีวันหมดอายุเช่นกัน แต่เปลี่ยนนโยบายได้
 *   3. ยังไม่ถึงกำหนด      - มีวันหมด บอกวันได้
 */
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';

/** เหตุผลที่การทำลายข้อมูลถูกปฏิเสธ */
export type BlockReason =
  | { kind: 'LEGAL_HOLD' }
  | { kind: 'RETAIN_FOREVER' }
  | { kind: 'RETENTION_ACTIVE'; until: Date };

export interface GovernanceState {
  /** มี Legal Hold ที่ยังมีผลอยู่หรือไม่ */
  onLegalHold: boolean;
  retentionUntil: Date | null;
  retentionForever: boolean;
  /** ลบถาวรได้หรือยัง */
  canPermanentlyDelete: boolean;
  blockedBy: BlockReason | null;
}

/**
 * วันที่ใช้เทียบ
 *
 * รับเข้ามาได้เพื่อให้ชุดทดสอบกำหนดเวลาเองได้ โดยไม่ต้องรอให้เวลาผ่านไปจริง
 */
export function evaluateGovernance(
  input: {
    onLegalHold: boolean;
    retentionUntil: Date | null;
    retentionForever: boolean;
  },
  now: Date = new Date(),
): GovernanceState {
  const base = {
    onLegalHold: input.onLegalHold,
    retentionUntil: input.retentionUntil,
    retentionForever: input.retentionForever,
  };

  if (input.onLegalHold) {
    return { ...base, canPermanentlyDelete: false, blockedBy: { kind: 'LEGAL_HOLD' } };
  }
  if (input.retentionForever) {
    return { ...base, canPermanentlyDelete: false, blockedBy: { kind: 'RETAIN_FOREVER' } };
  }
  if (input.retentionUntil && input.retentionUntil > now) {
    return {
      ...base,
      canPermanentlyDelete: false,
      blockedBy: { kind: 'RETENTION_ACTIVE', until: input.retentionUntil },
    };
  }

  /**
   * หมดอายุการเก็บรักษาแล้ว = "ลบได้ถ้ากติกาอื่นอนุญาต" ไม่ใช่ "ต้องลบเดี๋ยวนี้"
   * การลบยังต้องผ่านเงื่อนไขอื่นของระบบ เช่น ต้องอยู่ในถังขยะก่อน และต้องมีสิทธิ์
   */
  return { ...base, canPermanentlyDelete: true, blockedBy: null };
}

/** วันที่ในรูปแบบไทยสำหรับข้อความที่ผู้ใช้อ่าน */
function thaiDate(value: Date): string {
  return value.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * ข้อความอธิบายที่ปลอดภัย
 *
 * ไม่เปิดเผยเหตุผลของ Legal Hold - เหตุผลมักเกี่ยวกับคดีหรือการตรวจสอบภายใน
 * และผู้ที่กดลบอาจไม่ใช่คนที่ควรรู้ว่ากำลังมีการตรวจสอบอะไรอยู่
 */
export function blockMessage(reason: BlockReason): { code: string; message: string } {
  switch (reason.kind) {
    case 'LEGAL_HOLD':
      return {
        code: 'LEGAL_HOLD_ACTIVE',
        message: 'เอกสารนี้ถูกระงับการลบตาม Legal Hold',
      };
    case 'RETAIN_FOREVER':
      return {
        code: 'RETENTION_ACTIVE',
        message: 'เอกสารนี้ถูกกำหนดให้เก็บรักษาโดยไม่มีกำหนด',
      };
    case 'RETENTION_ACTIVE':
      return {
        code: 'RETENTION_ACTIVE',
        message: `เอกสารนี้ยังอยู่ภายใต้นโยบายการเก็บรักษา สามารถลบถาวรได้หลัง ${thaiDate(reason.until)}`,
      };
  }
}

/**
 * อ่านสถานะของทรัพยากรหลายชิ้นพร้อมกัน
 *
 * รับหลายรหัสเพราะการลบโฟลเดอร์คือการลบทั้งกิ่ง - ต้องตรวจทุกใบในกิ่งนั้น
 * ไม่ใช่ตรวจแค่โฟลเดอร์ตัวบนสุด มิฉะนั้นเอกสารที่ถูกระงับการลบจะหายไป
 * พร้อมโฟลเดอร์แม่ที่ไม่มีใครระงับไว้
 */
export async function governanceForResources(
  resourceIds: string[],
  now: Date = new Date(),
): Promise<Map<string, GovernanceState>> {
  const result = new Map<string, GovernanceState>();
  if (resourceIds.length === 0) return result;

  const [rows, holds] = await Promise.all([
    prisma.resource.findMany({
      where: { id: { in: resourceIds } },
      select: { id: true, retentionUntil: true, retentionForever: true },
    }),
    prisma.legalHold.findMany({
      where: { resourceId: { in: resourceIds }, isActive: true },
      select: { resourceId: true },
    }),
  ]);

  const held = new Set(holds.map((row) => row.resourceId));
  for (const row of rows) {
    result.set(
      row.id,
      evaluateGovernance(
        {
          onLegalHold: held.has(row.id),
          retentionUntil: row.retentionUntil,
          retentionForever: row.retentionForever,
        },
        now,
      ),
    );
  }
  return result;
}

/**
 * ปฏิเสธการทำลายข้อมูลถ้ามีสิ่งใดในกิ่งนี้ถูกคุ้มครองอยู่
 *
 * โยน AppError พร้อมรหัสและข้อความที่ปลอดภัย ผู้เรียกไม่ต้องรู้รายละเอียดของกติกา
 *
 * คืนรายการที่ถูกบล็อกออกมาด้วยเมื่อผู้เรียกต้องการรายงานผลแบบไม่โยน (เช่น งานหลายรายการ)
 */
export async function assertDestructionAllowed(
  resourceIds: string[],
  now: Date = new Date(),
): Promise<void> {
  const states = await governanceForResources(resourceIds, now);

  /**
   * Legal Hold มาก่อนเสมอเมื่อมีทั้งสองอย่างในกิ่งเดียวกัน
   * เพราะเป็นเหตุผลที่หนักกว่าและผู้ใช้ควรรู้เหตุนั้นก่อน
   */
  const ordered: BlockReason['kind'][] = ['LEGAL_HOLD', 'RETAIN_FOREVER', 'RETENTION_ACTIVE'];
  for (const kind of ordered) {
    for (const state of states.values()) {
      if (state.blockedBy?.kind === kind) {
        const { code, message } = blockMessage(state.blockedBy);
        throw new AppError(code, message, 409);
      }
    }
  }
}

/** มี Legal Hold ที่ยังมีผลอยู่บนทรัพยากรใดในรายการหรือไม่ */
export async function hasActiveLegalHold(resourceIds: string[]): Promise<boolean> {
  if (resourceIds.length === 0) return false;
  const count = await prisma.legalHold.count({
    where: { resourceId: { in: resourceIds }, isActive: true },
  });
  return count > 0;
}
