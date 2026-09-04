import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { activeGrantMap, portalResourceSelect } from './portal-access.js';
import { externalCapabilities, portalRoleFor, type PortalRole } from './portal-policy.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * ประวัติการอัปโหลดของลูกค้า
 *
 * ตอบสามคำถาม: ฉันอัปโหลดอะไรไปแล้ว · เมื่อไร · ไว้ที่ไหน
 *
 * ประวัติไม่ใช่ช่องทางเข้าถึงที่สอง
 * ---------------------------------
 * รายการในประวัติถูกตัดสินจาก "ใครเป็นผู้อัปโหลด" ซึ่งเป็นข้อเท็จจริงที่เปลี่ยนไม่ได้
 * แต่การเปิดดูและการดาวน์โหลดถูกตัดสินจาก "สิทธิ์ที่มีอยู่ตอนนี้" เสมอ
 *
 * ผลคือไฟล์ที่เคยอัปโหลดไว้แล้วถูกเจ้าหน้าที่ย้ายออกไปนอกขอบเขต หรือถูกลบ หรือสิทธิ์หมดอายุ
 * จะยังปรากฏในประวัติว่าเคยส่งไป แต่เปิดไม่ได้อีกต่อไป
 * การเคยอัปโหลดไฟล์หนึ่งไม่ได้ทำให้ได้สิทธิ์ถาวรกับไฟล์นั้น
 */

/** สถานะที่ปลอดภัยพอจะบอกลูกค้าได้ */
export type UploadHistoryState = 'AVAILABLE' | 'MANAGED_BY_STAFF' | 'UNAVAILABLE';

export const UPLOAD_STATE_LABEL: Record<UploadHistoryState, string> = {
  AVAILABLE: 'พร้อมใช้งาน',
  /**
   * ไฟล์ยังอยู่ในระบบ แต่ถูกย้ายไปนอกขอบเขตที่ลูกค้าเข้าถึงได้
   * ห้ามบอกตำแหน่งใหม่เด็ดขาด - นั่นคือการเปิดเผยโครงสร้างภายในขององค์กร
   */
  MANAGED_BY_STAFF: 'เจ้าหน้าที่รับเรื่องแล้ว',
  UNAVAILABLE: 'ไฟล์นี้ไม่สามารถเข้าถึงได้แล้ว',
};

export interface UploadHistoryItem {
  id: string;
  name: string;
  mimeType: string | null;
  extension: string | null;
  size: number | null;
  uploadedAt: Date;
  state: UploadHistoryState;
  stateLabel: string;
  /** เส้นทางปลายทาง - มีค่าเฉพาะเมื่อยังอยู่ในขอบเขตที่ลูกค้าเข้าถึงได้ */
  destination: Array<{ id: string; name: string }> | null;
  canPreview: boolean;
  canDownload: boolean;
}

export interface UploadHistoryPage {
  items: UploadHistoryItem[];
  nextCursor: string | null;
  total: number;
}

export interface UploadHistoryFilter {
  q?: string;
  extension?: string;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: string;
}

/**
 * ไล่หาบรรพบุรุษของทรัพยากรหลายชิ้นพร้อมกัน
 *
 * ทำเป็นชั้น ๆ จากล่างขึ้นบน หนึ่งคำสั่งต่อหนึ่งชั้น
 * ไม่ใช่หนึ่งคำสั่งต่อหนึ่งไฟล์ ซึ่งจะกลายเป็น N+1 ทันทีที่ประวัติยาวขึ้น
 */
async function ancestorPaths(resourceIds: string[]): Promise<Map<string, Array<{ id: string; name: string }>>> {
  const paths = new Map<string, Array<{ id: string; name: string }>>();
  if (resourceIds.length === 0) return paths;

  const nodes = new Map<string, { id: string; name: string; parentId: string | null }>();
  let frontier = resourceIds;

  for (let depth = 0; depth < 64 && frontier.length > 0; depth += 1) {
    const rows = await prisma.resource.findMany({
      where: { id: { in: frontier } },
      select: { id: true, name: true, parentId: true },
    });
    const next: string[] = [];
    for (const row of rows) {
      if (nodes.has(row.id)) continue;
      nodes.set(row.id, row);
      if (row.parentId && !nodes.has(row.parentId)) next.push(row.parentId);
    }
    frontier = next;
  }

  for (const id of resourceIds) {
    const chain: Array<{ id: string; name: string }> = [];
    let cursor: string | null = id;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const node = nodes.get(cursor);
      if (!node) break;
      chain.unshift({ id: node.id, name: node.name });
      cursor = node.parentId;
    }
    paths.set(id, chain);
  }

  return paths;
}

/**
 * ประวัติการอัปโหลดของลูกค้าคนหนึ่ง
 *
 * ขอบเขตของรายการคือ createdById = ตัวเอง และ sourceType = EXTERNAL_UPLOAD
 * ไม่มีทางเห็นของลูกค้ารายอื่น เพราะเงื่อนไขผูกกับรหัสผู้ใช้ในคำสั่งฐานข้อมูลโดยตรง
 */
export async function listUploadHistory(
  user: AuthUser,
  filter: UploadHistoryFilter,
  now: Date = new Date(),
): Promise<UploadHistoryPage> {
  const where: Prisma.ResourceWhereInput = {
    createdById: user.id,
    sourceType: 'EXTERNAL_UPLOAD',
    ...(filter.q ? { name: { contains: filter.q.trim() } } : {}),
    ...(filter.extension ? { extension: filter.extension.toLowerCase().replace(/^\./, '') } : {}),
    ...(filter.from || filter.to
      ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
      : {}),
  };

  const rows = await prisma.resource.findMany({
    where,
    select: portalResourceSelect,
    // ใหม่สุดก่อน - ลูกค้ามองหาสิ่งที่เพิ่งส่งไปเป็นอันดับแรกเสมอ
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: filter.limit + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  });

  const page = rows.slice(0, filter.limit);
  const grants = await activeGrantMap(user.id, now);
  const paths = await ancestorPaths(page.map((row) => row.id));

  const items = page.map((row) => {
    const chain = paths.get(row.id) ?? [];

    /**
     * สิทธิ์ปัจจุบันของไฟล์นี้ - หาจากสิทธิ์ที่ใกล้ที่สุดในสายบรรพบุรุษ
     * เงื่อนไขเดียวกับ resolvePortalAccess ทุกประการ
     */
    let effective: { role: PortalRole; allowDownload: boolean } | undefined;
    let rootIndex = -1;
    for (let index = 0; index < chain.length; index += 1) {
      const grant = grants.get(chain[index]!.id);
      if (!grant) continue;
      if (rootIndex < 0) rootIndex = index;
      effective = grant;
    }

    const trashed = row.deletedAt !== null;
    let state: UploadHistoryState;
    if (trashed) {
      // ถูกลบแล้ว - ประวัติยังบอกว่าเคยส่งไป แต่ไฟล์เข้าถึงไม่ได้ และไม่มีทางไปถังขยะ
      state = 'UNAVAILABLE';
    } else if (!effective) {
      /**
       * ไฟล์ยังอยู่ แต่อยู่นอกขอบเขตที่ลูกค้าเข้าถึงได้แล้ว
       * ไม่บอกตำแหน่งใหม่ ไม่บอกว่าถูกย้ายไปไหน บอกเพียงว่าเรื่องถึงมือเจ้าหน้าที่แล้ว
       */
      state = 'MANAGED_BY_STAFF';
    } else {
      state = 'AVAILABLE';
    }

    const caps = effective
      ? externalCapabilities({
          role: effective.role,
          allowDownload: effective.allowDownload,
          resourceType: row.type,
          isLocked: row.isLocked,
        })
      : null;

    return {
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      extension: row.extension,
      size: row.size === null ? null : Number(row.size),
      uploadedAt: row.createdAt,
      state,
      stateLabel: UPLOAD_STATE_LABEL[state],
      // เส้นทางถูกตัดให้เริ่มที่รากที่ได้รับสิทธิ์ และไม่แสดงเลยเมื่อเข้าถึงไม่ได้แล้ว
      destination: state === 'AVAILABLE' && rootIndex >= 0 ? chain.slice(rootIndex, -1) : null,
      canPreview: state === 'AVAILABLE',
      canDownload: state === 'AVAILABLE' && (caps?.canDownload ?? false),
    };
  });

  return {
    items,
    nextCursor: rows.length > filter.limit ? page[page.length - 1]?.id ?? null : null,
    total: await prisma.resource.count({ where }),
  };
}

/** ชนิดไฟล์ที่ลูกค้ารายนี้เคยส่งมา - ใช้เป็นตัวเลือกของตัวกรอง */
export async function uploadHistoryExtensions(user: AuthUser): Promise<string[]> {
  const rows = await prisma.resource.groupBy({
    by: ['extension'],
    where: { createdById: user.id, sourceType: 'EXTERNAL_UPLOAD', extension: { not: null } },
    _count: { _all: true },
  });
  return rows
    .map((row) => row.extension)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => a.localeCompare(b));
}
