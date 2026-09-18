import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { notFound } from '../../core/errors.js';
import {
  isGrantActive,
  isPortalVisibleType,
  portalRoleFor,
  type PortalRole,
} from './portal-policy.js';
import {
  PORTAL_VISIBLE_CLASSIFICATIONS,
  allowsExternalAccess,
} from '../governance/classification.policy.js';
import { mergeGrants, workflowGrantsForUser } from '../workflow/workflow-access.js';

/**
 * การหาว่าผู้ใช้ภายนอกเข้าถึงทรัพยากรชิ้นหนึ่งได้หรือไม่
 *
 * ความจริงอยู่ที่ ResourceAccess เท่านั้น ไม่มีเส้นทางอื่นที่ให้สิทธิ์ได้
 * การเข้าถึงเกิดขึ้นได้สองแบบ:
 *   1. ทรัพยากรชิ้นนั้นถูกแชร์ให้โดยตรง
 *   2. ทรัพยากรชิ้นนั้นอยู่ใต้โฟลเดอร์ที่ถูกแชร์ให้
 *
 * เมื่อมีสิทธิ์ซ้อนกันหลายชั้น สิทธิ์ที่ใกล้ตัวทรัพยากรที่สุดเป็นผู้ชนะ
 * ฝ่ายภายในจึงจำกัดโฟลเดอร์ย่อยให้แคบลงกว่าโฟลเดอร์แม่ได้ โดยไม่ต้องเลิกแชร์ทั้งต้น
 */

/** กันโครงสร้างที่ผิดปกติหรือวงจร ไม่ให้การไล่ลำดับชั้นวนไม่รู้จบ */
const MAX_DEPTH = 64;

export const portalResourceSelect = {
  id: true,
  type: true,
  name: true,
  parentId: true,
  mimeType: true,
  extension: true,
  size: true,
  externalUrl: true,
  sourceType: true,
  isLocked: true,
  deletedAt: true,
  /**
   * สองสนามนี้จำเป็นต่อการบังคับใช้นโยบาย ไม่ใช่ข้อมูลสำหรับแสดงผล (F26-A1)
   *
   * ดึงมาพร้อมแถวเดียวกันเพื่อไม่ให้ทุกการตรวจต้องยิงคำถามเพิ่ม และเพื่อให้ทุกเส้นทาง
   * ที่ใช้ select ชุดนี้มีข้อมูลพอจะตัดสินใจได้เองโดยไม่ต้องจำว่าต้องไปหาที่ไหนอีก
   */
  lifecycleState: true,
  classification: true,
  currentVersion: true,
  storageKey: true,
  storageProvider: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, displayName: true } },
  _count: { select: { children: { where: { deletedAt: null } } } },
} as const;

export type PortalResource = Prisma.ResourceGetPayload<{ select: typeof portalResourceSelect }>;

/**
 * ทรัพยากรนี้ปรากฏต่อผู้ใช้ภายนอกได้หรือไม่ (F26-A1)
 *
 * รวมสามเงื่อนไขที่ก่อนหน้านี้กระจายอยู่คนละที่และไม่ตรงกัน: อยู่ในถังขยะ อยู่ในคลัง
 * และเพดานการเปิดเผยตามชั้นความลับ
 *
 * **กฎชั้นความลับไม่ได้ถูกเขียนซ้ำที่นี่** - เรียก allowsExternalAccess ของ F25-D ตรง ๆ
 * ซึ่งเป็นเจ้าของกฎเพียงผู้เดียว ถ้าเขียนเงื่อนไขเองที่นี่ พื้นที่ลูกค้าจะกลายเป็นเมทริกซ์
 * ชุดที่สองที่ค่อย ๆ เลื่อนออกจากรายงานการตรวจสอบสิทธิ์ ซึ่งคือข้อบกพร่องที่ F26-A มาแก้พอดี
 *
 * คู่ขนานกับ resourceExposableToGuests ของช่องทางลิงก์ไม่ระบุตัวตน - คนละช่องทาง
 * คนละเพดาน แต่ถามคำถามเดียวกันและถามจากเจ้าของกฎคนเดียวกัน
 */
export function resourceExposableToPortal(
  resource: Pick<PortalResource, 'deletedAt' | 'lifecycleState' | 'classification'>,
): boolean {
  return (
    resource.deletedAt === null &&
    resource.lifecycleState === 'ACTIVE' &&
    allowsExternalAccess(resource.classification)
  );
}

/**
 * เงื่อนไขเดียวกันในรูปแบบที่ส่งให้ฐานข้อมูลกรอง
 *
 * ต้องมีคู่กับฟังก์ชันข้างบนเสมอ เพราะรายการที่กรองในหน่วยความจำหลังดึงมาแล้วจะกิน
 * โควตา take ไปกับแถวที่จะถูกทิ้ง ทำให้โฟลเดอร์ที่มีเอกสารชั้นลับอยู่ต้น ๆ แสดงว่าง
 * ทั้งที่มีของที่ลูกค้าดูได้อยู่ข้างล่าง
 */
export const PORTAL_EXPOSABLE_WHERE = {
  deletedAt: null,
  lifecycleState: 'ACTIVE',
  classification: { in: PORTAL_VISIBLE_CLASSIFICATIONS },
} as const satisfies Prisma.ResourceWhereInput;

export interface PortalAccess {
  resource: PortalResource;
  role: PortalRole;
  allowDownload: boolean;
  /** โฟลเดอร์ที่ถูกแชร์ให้ซึ่งอยู่สูงที่สุดในสาย - เส้นทางนำทางหยุดที่นี่ */
  rootId: string;
  /** เส้นทางนำทางจากรากที่ได้รับสิทธิ์ลงมาถึงทรัพยากรชิ้นนี้ */
  breadcrumb: Array<{ id: string; name: string }>;
}

interface ChainNode {
  id: string;
  name: string;
  /** ผ่านด่านการกำกับดูแลทุกข้อหรือไม่ - ไม่ได้แยกเก็บว่าตกด้วยเหตุใด ดูหมายเหตุที่จุดใช้งาน */
  exposable: boolean;
}

/**
 * สิทธิ์ที่ยังมีผลของผู้ใช้คนหนึ่ง เก็บเป็น Map เพื่อให้ตรวจสายลำดับชั้นได้ในหน่วยความจำ
 *
 * ใช้ร่วมกันระหว่างการเปิดเอกสารและการค้นหา - กติกาว่า "สิทธิ์ใดยังมีผล"
 * ต้องมีคำตอบชุดเดียว มิฉะนั้นการค้นหาอาจแสดงสิ่งที่เปิดไม่ได้ หรือซ่อนสิ่งที่เปิดได้
 *
 * **รวมสองแหล่งที่นี่ที่เดียว (F26-B1)**
 *
 * สิทธิ์ที่มอบด้วยมือ (ResourceAccess) กับสิทธิ์ที่เกิดจากคำขอความร่วมมือที่ยังเปิดอยู่
 * ถูกรวมกันตรงนี้ ซึ่งเป็นคอขวดเดียวที่ทุกเส้นทางของพื้นที่ลูกค้าผ่าน การรวมที่จุดเดียว
 * แปลว่าไม่มีเส้นทางใดที่เห็นสิทธิ์ต่างจากเส้นทางอื่นได้เลย
 *
 * คำขอ **ไม่เคยเขียนทับ** แถว ResourceAccess ทั้งสองแหล่งอยู่คนละที่และจบอายุของตัวเอง
 * แยกกัน เมื่อคำขอจบ ส่วนที่มันเพิ่มให้ก็หายไปเอง โดยไม่มีอะไรต้องกู้คืน
 */
export async function activeGrantMap(userId: string, now: Date) {
  const [grants, workflowGrants] = await Promise.all([
    prisma.resourceAccess.findMany({
      where: { userId },
      select: { resourceId: true, accessLevel: true, allowDownload: true, expiresAt: true },
    }),
    workflowGrantsForUser(userId, now),
  ]);

  const manualByResource = new Map<string, (typeof grants)[number]>();
  for (const grant of grants) {
    // สิทธิ์ที่หมดอายุถูกทิ้งตั้งแต่ตรงนี้ จึงไม่มีทางไปโผล่ที่ชั้นถัดไปได้เลย
    if (!isGrantActive(grant, now)) continue;
    manualByResource.set(grant.resourceId, grant);
  }

  const workflowByResource = new Map<string, typeof workflowGrants>();
  for (const grant of workflowGrants) {
    const list = workflowByResource.get(grant.resourceId) ?? [];
    list.push(grant);
    workflowByResource.set(grant.resourceId, list);
  }

  const map = new Map<string, { role: PortalRole; allowDownload: boolean }>();
  for (const resourceId of new Set([...manualByResource.keys(), ...workflowByResource.keys()])) {
    const merged = mergeGrants(
      manualByResource.get(resourceId) ?? null,
      workflowByResource.get(resourceId) ?? [],
    );
    if (!merged) continue;
    map.set(resourceId, {
      role: portalRoleFor(merged.accessLevel),
      allowDownload: merged.allowDownload,
    });
  }
  return map;
}

/**
 * ไล่จากทรัพยากรขึ้นไปหาราก
 *
 * คืนลำดับจากตัวทรัพยากรขึ้นไป (ตัวมันเองอยู่ตำแหน่งแรก)
 *
 * แต่ละชั้นพก `exposable` มาด้วย เพื่อให้ผู้เรียกตัดสินได้ว่าเส้นทางจากรากที่ได้รับสิทธิ์
 * ลงมาถึงปลายทางผ่านได้หรือไม่ ไม่ใช่ตรวจเฉพาะตัวปลายทางแล้วเดินผ่านชั้นที่ปิดอยู่
 */
async function ancestorChain(resourceId: string): Promise<ChainNode[]> {
  const chain: ChainNode[] = [];
  const seen = new Set<string>();
  let cursor: string | null = resourceId;

  while (cursor && chain.length < MAX_DEPTH) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    // ประกาศชนิดตรง ๆ เพราะ cursor ถูกกำหนดจากผลลัพธ์ของรอบก่อน TypeScript จึงอนุมานเองไม่ได้
    const node: {
      id: string; name: string; parentId: string | null;
      deletedAt: Date | null;
      lifecycleState: PortalResource['lifecycleState'];
      classification: PortalResource['classification'];
    } | null = await prisma.resource.findUnique({
      where: { id: cursor },
      select: {
        id: true, name: true, parentId: true,
        deletedAt: true, lifecycleState: true, classification: true,
      },
    });
    if (!node) break;
    chain.push({ id: node.id, name: node.name, exposable: resourceExposableToPortal(node) });
    cursor = node.parentId;
  }

  return chain;
}

/**
 * ไม่พบ = ไม่มีสิทธิ์ ในสายตาของผู้ใช้ภายนอก
 *
 * ข้อความและรหัสเดียวกันเสมอ ไม่ว่าทรัพยากรจะไม่มีอยู่จริง อยู่ในถังขยะ
 * หรือมีอยู่แต่ไม่ได้แชร์ให้ ผู้ใช้ภายนอกจึงเดาไม่ได้ว่ารหัสที่สุ่มมานั้นมีอยู่จริงหรือไม่
 */
export function portalNotFound(): Error {
  return notFound('PORTAL_RESOURCE_NOT_FOUND', 'ไม่พบเอกสารที่ต้องการ');
}

/**
 * ตรวจสิทธิ์ของผู้ใช้ภายนอกบนทรัพยากรหนึ่งชิ้น
 *
 * ทุกเส้นทางของพื้นที่ลูกค้าต้องผ่านฟังก์ชันนี้ก่อนเสมอ ไม่มีข้อยกเว้น
 */
export async function resolvePortalAccess(
  userId: string,
  resourceId: string,
  now: Date = new Date(),
): Promise<PortalAccess> {
  const grants = await activeGrantMap(userId, now);
  if (grants.size === 0) throw portalNotFound();

  const chain = await ancestorChain(resourceId);
  if (chain.length === 0) throw portalNotFound();

  /**
   * chain[0] คือตัวทรัพยากร ยิ่ง index น้อยยิ่งใกล้ตัว
   * สิทธิ์ที่ใกล้ที่สุดเป็นผู้ตัดสินบทบาท ส่วนสิทธิ์ที่ไกลที่สุดเป็นรากของเส้นทางนำทาง
   */
  let effective: { role: PortalRole; allowDownload: boolean } | null = null;
  let rootIndex = -1;
  for (let index = 0; index < chain.length; index += 1) {
    const grant = grants.get(chain[index]!.id);
    if (!grant) continue;
    effective ??= grant;
    rootIndex = index;
  }
  if (!effective || rootIndex < 0) throw portalNotFound();

  /**
   * ทุกชั้นตั้งแต่รากที่ได้รับสิทธิ์ลงมาถึงปลายทางต้องผ่านด่านการกำกับดูแล (F26-A1)
   *
   * ตรวจทั้งเส้นทาง ไม่ใช่เฉพาะปลายทาง เพราะการมอบสิทธิ์บนโฟลเดอร์แม่ไม่ควรกลายเป็น
   * ประตูลัดที่พาลูกค้าผ่านชั้นที่ถูกปิดไว้ลงไปข้างล่าง และในทางกลับกัน เอกสารชั้นลับ
   * ที่วางอยู่ใต้โฟลเดอร์ที่แชร์ไว้ก็ต้องไม่ถูกเปิดเพียงเพราะโฟลเดอร์แม่เปิดอยู่
   *
   * เป็นกติกาเดียวกับที่ด่านรับแขกของลิงก์ไม่ระบุตัวตนใช้ (resourceExposableToGuests)
   * ต่างกันแค่เพดานของช่องทาง
   *
   * ตอบเหมือนกรณีไม่พบทุกประการ - ลูกค้าต้องแยกไม่ออกระหว่าง "ไม่มีเอกสารนี้"
   * "เอกสารถูกเก็บเข้าคลัง" และ "เอกสารนี้ชั้นลับเกินกว่าจะเปิดออกนอกองค์กร"
   * เพราะสามคำตอบนั้นเองก็เป็นข้อมูลที่ไม่ควรหลุดออกไป
   */
  if (chain.slice(0, rootIndex + 1).some((node) => !node.exposable)) throw portalNotFound();

  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: portalResourceSelect,
  });
  if (!resource || !isPortalVisibleType(resource.type)) throw portalNotFound();
  // ตรวจซ้ำจากแถวจริงที่จะถูกส่งออกไป ไม่ใช่เชื่อผลจากการไล่สายอย่างเดียว
  if (!resourceExposableToPortal(resource)) throw portalNotFound();

  // จากรากที่ได้รับสิทธิ์ลงมาถึงตัวทรัพยากร - ชั้นที่อยู่เหนือรากถูกตัดทิ้งทั้งหมด
  const breadcrumb = chain
    .slice(0, rootIndex + 1)
    .reverse()
    .map((node) => ({ id: node.id, name: node.name }));

  return {
    resource,
    role: effective.role,
    allowDownload: effective.allowDownload,
    rootId: chain[rootIndex]!.id,
    breadcrumb,
  };
}

/** เอกสารที่ถูกแชร์ให้ผู้ใช้ภายนอกโดยตรง - จุดเริ่มต้นของพื้นที่ลูกค้า */
export async function listPortalRoots(userId: string, now: Date = new Date()) {
  const grants = await prisma.resourceAccess.findMany({
    /**
     * กรองที่ฐานข้อมูลด้วยเงื่อนไขชุดเดียวกับที่ resolvePortalAccess ใช้ (F26-A1)
     *
     * หน้าแรกต้องไม่แสดงสิ่งที่กดแล้วถูกปฏิเสธ - ลูกค้าที่เห็นรายการแล้วเปิดไม่ได้
     * จะโทรมาถามเจ้าหน้าที่ ซึ่งแปลว่าระบบเพิ่งบอกลูกค้าว่ามีเอกสารชั้นลับอยู่ฉบับหนึ่ง
     *
     * แถวสิทธิ์ยังอยู่ครบ ไม่ได้ถูกลบ - รายงานการตรวจสอบสิทธิ์ยังเห็นเป็นหลักฐานเหมือนเดิม
     */
    where: { userId, resource: PORTAL_EXPOSABLE_WHERE },
    select: {
      accessLevel: true,
      allowDownload: true,
      expiresAt: true,
      createdAt: true,
      resource: { select: portalResourceSelect },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  const manual = grants
    .filter((grant) => isGrantActive(grant, now))
    .filter((grant) => isPortalVisibleType(grant.resource.type));

  /*
   * คำขอความร่วมมืออาจให้สิทธิ์โดยไม่มีแถว ResourceAccess คู่กันเลย (F26-B1)
   *
   * ถ้าหน้าแรกอ่านแต่ ResourceAccess ผู้รับงานที่ได้สิทธิ์จากคำขออย่างเดียวจะเห็นหน้าว่าง
   * ทั้งที่ resolvePortalAccess ยอมให้เข้าถึงได้ - ซึ่งเป็นความไม่ตรงกันแบบเดียวกับ
   * ที่ F26-A1 เพิ่งไปแก้มา เพียงแต่กลับด้าน
   */
  const merged = await activeGrantMap(userId, now);
  const extraIds = [...merged.keys()].filter((id) => !manual.some((grant) => grant.resource.id === id));
  const extras = extraIds.length
    ? await prisma.resource.findMany({
        where: { id: { in: extraIds }, ...PORTAL_EXPOSABLE_WHERE },
        select: portalResourceSelect,
      })
    : [];

  return [
    ...manual.map((grant) => ({
      resource: grant.resource,
      role: merged.get(grant.resource.id)?.role ?? portalRoleFor(grant.accessLevel),
      allowDownload: merged.get(grant.resource.id)?.allowDownload ?? grant.allowDownload,
      expiresAt: grant.expiresAt,
      sharedAt: grant.createdAt,
    })),
    ...extras
      .filter((resource) => isPortalVisibleType(resource.type))
      .map((resource) => ({
        resource,
        role: merged.get(resource.id)!.role,
        allowDownload: merged.get(resource.id)!.allowDownload,
        expiresAt: null,
        sharedAt: resource.createdAt,
      })),
  ];
}
