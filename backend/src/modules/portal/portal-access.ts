import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { notFound } from '../../core/errors.js';
import {
  isGrantActive,
  isPortalVisibleType,
  portalRoleFor,
  type PortalRole,
} from './portal-policy.js';

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
  currentVersion: true,
  storageKey: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, displayName: true } },
  _count: { select: { children: { where: { deletedAt: null } } } },
} as const;

export type PortalResource = Prisma.ResourceGetPayload<{ select: typeof portalResourceSelect }>;

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
  deleted: boolean;
}

/**
 * สิทธิ์ที่ยังมีผลของผู้ใช้คนหนึ่ง เก็บเป็น Map เพื่อให้ตรวจสายลำดับชั้นได้ในหน่วยความจำ
 *
 * ใช้ร่วมกันระหว่างการเปิดเอกสารและการค้นหา - กติกาว่า "สิทธิ์ใดยังมีผล"
 * ต้องมีคำตอบชุดเดียว มิฉะนั้นการค้นหาอาจแสดงสิ่งที่เปิดไม่ได้ หรือซ่อนสิ่งที่เปิดได้
 */
export async function activeGrantMap(userId: string, now: Date) {
  const grants = await prisma.resourceAccess.findMany({
    where: { userId },
    select: { resourceId: true, accessLevel: true, allowDownload: true, expiresAt: true },
  });

  const map = new Map<string, { role: PortalRole; allowDownload: boolean }>();
  for (const grant of grants) {
    // สิทธิ์ที่หมดอายุถูกทิ้งตั้งแต่ตรงนี้ จึงไม่มีทางไปโผล่ที่ชั้นถัดไปได้เลย
    if (!isGrantActive(grant, now)) continue;
    map.set(grant.resourceId, {
      role: portalRoleFor(grant.accessLevel),
      allowDownload: grant.allowDownload,
    });
  }
  return map;
}

/**
 * ไล่จากทรัพยากรขึ้นไปหาราก
 *
 * คืนลำดับจากตัวทรัพยากรขึ้นไป (ตัวมันเองอยู่ตำแหน่งแรก)
 * ทรัพยากรที่อยู่ในถังขยะทำให้ทั้งสายใช้ไม่ได้ - ลูกค้าต้องไม่เห็นของที่ถูกลบไปแล้ว
 */
async function ancestorChain(resourceId: string): Promise<ChainNode[]> {
  const chain: ChainNode[] = [];
  const seen = new Set<string>();
  let cursor: string | null = resourceId;

  while (cursor && chain.length < MAX_DEPTH) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const node: { id: string; name: string; parentId: string | null; deletedAt: Date | null } | null =
      await prisma.resource.findUnique({
        where: { id: cursor },
        select: { id: true, name: true, parentId: true, deletedAt: true },
      });
    if (!node) break;
    chain.push({ id: node.id, name: node.name, deleted: node.deletedAt !== null });
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
  // ตัวทรัพยากรหรือบรรพบุรุษชั้นใดชั้นหนึ่งถูกลบ - หายไปจากพื้นที่ลูกค้าทันที
  if (chain.some((node) => node.deleted)) throw portalNotFound();

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

  const resource = await prisma.resource.findUnique({
    where: { id: resourceId },
    select: portalResourceSelect,
  });
  if (!resource || resource.deletedAt || !isPortalVisibleType(resource.type)) throw portalNotFound();

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
    where: { userId, resource: { deletedAt: null } },
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

  return grants
    .filter((grant) => isGrantActive(grant, now))
    .filter((grant) => isPortalVisibleType(grant.resource.type))
    .map((grant) => ({
      resource: grant.resource,
      role: portalRoleFor(grant.accessLevel),
      allowDownload: grant.allowDownload,
      expiresAt: grant.expiresAt,
      sharedAt: grant.createdAt,
    }));
}
