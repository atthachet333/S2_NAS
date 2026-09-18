/**
 * สิทธิ์ที่เกิดจากคำขอความร่วมมือ - ชั้นทับ ไม่ใช่การเขียนทับ (F26-B1)
 *
 * **ปัญหาที่โมดูลนี้แก้**
 *
 * ResourceAccess มีได้แถวเดียวต่อ (ทรัพยากร, ผู้ใช้) เดิม F26-B สร้างคำขอแล้วเขียนแถวนั้น
 * ทับไปเลย ถ้าผู้รับงานเคยได้รับสิทธิ์ด้วยมือไว้ก่อน ระดับสิทธิ์ สิทธิ์ดาวน์โหลด และวันหมดอายุ
 * ของเดิมจะถูกลบทิ้งอย่างเงียบ ๆ และไม่มีทางกู้กลับ เพราะไม่มีใครเก็บค่าเดิมไว้
 *
 * **ทางที่เลือก: คำขอไม่แตะ ResourceAccess เลยแม้แต่แถวเดียว**
 *
 * แถวคำขอถือเงื่อนไขของตัวเองอยู่แล้ว (allowUpload, allowDownload, expiresAt)
 * จึงเป็นแหล่งสิทธิ์ได้ด้วยตัวเองโดยไม่ต้องมีตารางใหม่ ส่วนสิทธิ์ที่มอบด้วยมือยังเป็น
 * ความจริงที่ไม่ถูกแตะต้อง ผลลัพธ์คือ:
 *
 *   - เริ่มคำขอ  → สิทธิ์เดิมไม่เปลี่ยนแม้แต่ฟิลด์เดียว
 *   - จบคำขอ    → ส่วนที่คำขอเพิ่มให้หายไปเอง ไม่ต้องกู้คืนอะไร
 *   - แก้สิทธิ์เดิมระหว่างคำขอยังเปิดอยู่ → มีผลทันที และไม่ถูกย้อนกลับตอนคำขอจบ
 *
 * ข้อสุดท้ายคือเหตุผลที่ไม่เลือกวิธี "ถ่ายรูปค่าเดิมไว้แล้วคืนทีหลัง" - ภาพถ่ายนั้น
 * จะเก่าทันทีที่ผู้ดูแลแก้สิทธิ์ระหว่างทาง แล้วการคืนค่าจะกลายเป็นการย้อนการตัดสินใจ
 * ล่าสุดของคนกลับไปเป็นค่าที่ไม่มีใครต้องการอีกแล้ว
 *
 * **ไม่ใช่ระบบสิทธิ์ที่มองไม่เห็น** รายงานการตรวจสอบสิทธิ์ของ F25-C อ่านแหล่งนี้ด้วย
 * และแสดงแยกเป็นหลักฐานคนละชิ้นกับสิทธิ์ที่มอบด้วยมือ ผู้ตรวจสอบจึงเห็นทั้งสองที่มา
 * และเห็นว่าผลลัพธ์รวมมาจากอะไรบ้าง
 */
import type { ResourceAccessLevel } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { isWorkflowActive } from './workflow.policy.js';

/**
 * สิทธิ์ที่คำขอหนึ่งใบมอบให้ ณ ทรัพยากรหนึ่งชิ้น
 *
 * ใช้ระดับสิทธิ์ชุดเดียวกับ ResourceAccess เพื่อให้ผู้ใช้ปลายทางรวมสองแหล่งได้
 * โดยไม่ต้องแปลงคำศัพท์ - คำศัพท์ที่ต้องแปลงคือคำศัพท์ที่จะแปลผิดในวันหนึ่ง
 */
export interface WorkflowGrant {
  workflowId: string;
  resourceId: string;
  userId: string;
  accessLevel: ResourceAccessLevel;
  allowDownload: boolean;
  expiresAt: Date | null;
}

const ACTIVE_WORKFLOW_SELECT = {
  id: true,
  targetResourceId: true,
  externalUserId: true,
  state: true,
  allowUpload: true,
  allowDownload: true,
  expiresAt: true,
} as const;

function toWorkflowGrant(row: {
  id: string;
  targetResourceId: string;
  externalUserId: string;
  allowUpload: boolean;
  allowDownload: boolean;
  expiresAt: Date | null;
}): WorkflowGrant {
  return {
    workflowId: row.id,
    resourceId: row.targetResourceId,
    userId: row.externalUserId,
    // ตรงกับ accessLevelForWorkflow - อัปโหลดได้คือ EDITOR ซึ่งพื้นที่ลูกค้าลดรูปเป็น CONTRIBUTOR
    accessLevel: row.allowUpload ? 'EDITOR' : 'VIEWER',
    allowDownload: row.allowDownload,
    expiresAt: row.expiresAt,
  };
}

/**
 * สิทธิ์จากคำขอที่ยังเปิดใช้งานของผู้ใช้คนหนึ่ง
 *
 * คัดด้วย isWorkflowActive ในหน่วยความจำ ไม่ใช่ใน SQL เพราะ EXPIRED ไม่มีอยู่ในคอลัมน์
 * การกรอง state ในฐานข้อมูลจะคืนคำขอที่หมดอายุแล้วปนมาเสมอ ซึ่งคือสิทธิ์ที่ไม่ควรมีอีกแล้ว
 */
export async function workflowGrantsForUser(userId: string, now: Date): Promise<WorkflowGrant[]> {
  const rows = await prisma.externalWorkflowRequest.findMany({
    where: { externalUserId: userId },
    select: ACTIVE_WORKFLOW_SELECT,
  });
  return rows.filter((row) => isWorkflowActive(row, now)).map(toWorkflowGrant);
}

/** สิทธิ์จากคำขอที่ยังเปิดใช้งานบนทรัพยากรชุดหนึ่ง - ใช้โดยรายงานการตรวจสอบสิทธิ์ */
export async function workflowGrantsForResources(
  resourceIds: string[],
  now: Date,
): Promise<WorkflowGrant[]> {
  if (resourceIds.length === 0) return [];
  const rows = await prisma.externalWorkflowRequest.findMany({
    where: { targetResourceId: { in: resourceIds } },
    select: ACTIVE_WORKFLOW_SELECT,
  });
  return rows.filter((row) => isWorkflowActive(row, now)).map(toWorkflowGrant);
}

/* ------------------------------------------------------------------ */
/* การรวมสองแหล่ง                                                       */
/* ------------------------------------------------------------------ */

const LEVEL_RANK: Record<ResourceAccessLevel, number> = { VIEWER: 1, EDITOR: 2, OWNER: 3 };

export interface MergedGrant {
  accessLevel: ResourceAccessLevel;
  allowDownload: boolean;
  /** null = ไม่หมดอายุ เพราะมีแหล่งใดแหล่งหนึ่งที่ไม่หมดอายุ */
  expiresAt: Date | null;
  fromManual: boolean;
  fromWorkflow: boolean;
}

/**
 * รวมสิทธิ์จากหลายแหล่งเป็นผลลัพธ์เดียว - **รวมแบบผ่อนปรน โดยเจตนา**
 *
 * เหตุผลไม่ใช่ความสะดวก แต่มาจากกติกาที่ตั้งไว้ว่า "การสร้างคำขอต้องไม่ลดทอนสิทธิ์
 * ที่มีอยู่โดยอิสระจากคำขอนั้น" ถ้ารวมแบบเข้มงวด (เอาค่าที่จำกัดกว่า) การสั่งงานหนึ่งครั้ง
 * จะกลายเป็นการถอนสิทธิ์ดาวน์โหลดที่ลูกค้าเคยมีมาตลอด ทั้งที่ไม่มีใครตั้งใจถอน
 *
 * **คำขอเพิ่มสิทธิ์ได้ ลดไม่ได้** allowDownload=false ในคำขอไม่ได้แปลว่า "ห้ามดาวน์โหลด"
 * แต่แปลว่า "งานนี้ไม่ต้องการสิทธิ์ดาวน์โหลด" การจำกัดสิทธิ์ที่มีอยู่เป็นการตัดสินใจของ
 * ผู้ดูแล ซึ่งทำผ่านการแก้สิทธิ์ที่มอบด้วยมือ ไม่ใช่ผลข้างเคียงของการสั่งงาน
 *
 * **ที่ทำแบบนี้ได้อย่างปลอดภัยเพราะยังมีเพดานอยู่เหนือขึ้นไป** ชั้นความลับ (F25-D)
 * และวงจรชีวิตเอกสาร ถูกบังคับใช้ที่ด่านพื้นที่ลูกค้าหลังจากรวมสิทธิ์เสร็จแล้ว
 * การรวมแบบผ่อนปรนจึงไม่มีทางทะลุเพดานนั้นออกไปได้
 *
 * แหล่งที่หมดอายุแล้วต้องถูกคัดทิ้ง **ก่อน** เรียกฟังก์ชันนี้ - ที่นี่ไม่ดูเวลา
 */
export function mergeGrants(
  manual: { accessLevel: ResourceAccessLevel; allowDownload: boolean; expiresAt: Date | null } | null,
  workflows: WorkflowGrant[],
): MergedGrant | null {
  if (!manual && workflows.length === 0) return null;

  const sources = [
    ...(manual ? [manual] : []),
    ...workflows.map((item) => ({
      accessLevel: item.accessLevel,
      allowDownload: item.allowDownload,
      expiresAt: item.expiresAt,
    })),
  ];

  let accessLevel: ResourceAccessLevel = 'VIEWER';
  let allowDownload = false;
  /*
   * วันหมดอายุที่ไกลที่สุดชนะ และ "ไม่หมดอายุ" ชนะทุกอย่าง
   *
   * เพราะแต่ละแหล่งถูกตรวจอายุของตัวเองมาแล้วก่อนถึงตรงนี้ ค่านี้จึงมีไว้เพื่อ
   * แสดงผลและเพื่อรายงาน ไม่ได้เป็นตัวตัดสินการเข้าถึงซ้ำอีกชั้น
   */
  let expiresAt: Date | null = sources[0]!.expiresAt;
  let neverExpires = false;

  for (const source of sources) {
    if (LEVEL_RANK[source.accessLevel] > LEVEL_RANK[accessLevel]) accessLevel = source.accessLevel;
    if (source.allowDownload) allowDownload = true;
    if (source.expiresAt === null) neverExpires = true;
    else if (expiresAt && source.expiresAt.getTime() > expiresAt.getTime()) expiresAt = source.expiresAt;
  }

  return {
    accessLevel,
    allowDownload,
    expiresAt: neverExpires ? null : expiresAt,
    fromManual: manual !== null,
    fromWorkflow: workflows.length > 0,
  };
}
