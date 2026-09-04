import type { Readable } from 'node:stream';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { uploadFile, type AuditContext } from '../files/file.service.js';
import type { AuthUser } from '../auth/auth.service.js';
import {
  listPortalRoots,
  portalNotFound,
  portalResourceSelect,
  resolvePortalAccess,
  type PortalAccess,
  type PortalResource,
} from './portal-access.js';
import {
  EXTERNAL_AUDIT_ACTIONS,
  EXTERNAL_UPLOAD_LABEL,
  externalCapabilities,
  isGrantActive,
  isPortalVisibleType,
  portalRoleFor,
  type PortalRole,
} from './portal-policy.js';
import { searchGrantedSubtrees } from './portal-search.js';
import { snippetsFor } from '../search/content-match.js';

/**
 * พื้นที่เอกสารสำหรับลูกค้า
 *
 * ทุกฟังก์ชันในไฟล์นี้เริ่มต้นด้วยการตรวจสิทธิ์จากการแชร์เสมอ ไม่มีทางลัดใด ๆ
 * และไม่มีฟังก์ชันใดที่เปลี่ยนแปลงหรือลบทรัพยากรที่มีอยู่แล้ว - โดยตั้งใจ
 *
 * ข้อมูลที่ส่งออกถูกจำกัดไว้เท่าที่ลูกค้าจำเป็นต้องเห็น
 * ไม่มี storageKey ไม่มีเส้นทางจริงบนดิสก์ ไม่มีข้อมูลผู้ดูแลภายใน
 * ไม่มีประวัติเวอร์ชัน และไม่มีร่องรอยของทรัพยากรที่ไม่ได้ถูกแชร์ให้
 */

/* ------------------------------------------------------------------ */
/* DTO                                                                */
/* ------------------------------------------------------------------ */

export interface PortalResourceDto {
  id: string;
  type: string;
  name: string;
  mimeType: string | null;
  extension: string | null;
  size: number | null;
  externalUrl: string | null;
  /** ป้ายภาษาไทยของแหล่งที่มา - ค่าดิบของ enum ไม่ถูกส่งออก */
  sourceLabel: string | null;
  itemCount: number;
  uploadedAt: Date;
  uploadedBy: string | null;
  capabilities: ReturnType<typeof externalCapabilities>;
}

/**
 * แปลงทรัพยากรเป็นข้อมูลที่ปลอดภัยพอจะส่งให้ลูกค้า
 *
 * ผู้อัปโหลดถูกส่งออกเป็น "ชื่อที่แสดง" เท่านั้น ไม่ใช่อีเมลหรือรหัสผู้ใช้
 * เพราะลูกค้าจำเป็นต้องรู้ว่าใครส่งเอกสารมาให้ แต่ไม่จำเป็นต้องรู้ทะเบียนพนักงานภายใน
 */
export function toPortalDto(
  resource: PortalResource,
  role: PortalRole,
  allowDownload: boolean,
): PortalResourceDto {
  return {
    id: resource.id,
    type: resource.type,
    name: resource.name,
    mimeType: resource.mimeType,
    extension: resource.extension,
    size: resource.size === null ? null : Number(resource.size),
    externalUrl: resource.externalUrl,
    sourceLabel: resource.sourceType === 'EXTERNAL_UPLOAD' ? EXTERNAL_UPLOAD_LABEL : null,
    itemCount: resource._count.children,
    uploadedAt: resource.createdAt,
    uploadedBy: resource.createdBy?.displayName ?? null,
    capabilities: externalCapabilities({
      role,
      allowDownload,
      resourceType: resource.type,
      isLocked: resource.isLocked,
    }),
  };
}

async function auditExternal(
  action: string,
  user: AuthUser,
  resourceId: string | null,
  audit: AuditContext,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action,
      resourceId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      // เก็บเฉพาะรหัสอ้างอิงและผลลัพธ์ ไม่เก็บชื่อไฟล์หรือข้อมูลส่วนบุคคลลง log
      metadata: metadata as Prisma.InputJsonValue,
    },
  });
}

/* ------------------------------------------------------------------ */
/* หน้าแรกของพื้นที่ลูกค้า                                              */
/* ------------------------------------------------------------------ */

export interface PortalHome {
  shared: PortalResourceDto[];
  recentUploads: PortalResourceDto[];
  uploadFolders: PortalResourceDto[];
}

/**
 * หน้าแรก - สามส่วนที่ตอบคำถามของลูกค้าได้ครบโดยไม่ต้องเดา
 * "มีอะไรแชร์ให้ฉัน" "อะไรเพิ่งเข้ามา" และ "ฉันส่งไฟล์เข้าที่ไหนได้"
 *
 * ไม่มีสถิติรวมใด ๆ เพราะลูกค้าเห็นเพียงบางส่วนของระบบ ตัวเลขรวมจึงไม่มีความหมายจริง
 */
export async function portalHome(user: AuthUser, now: Date = new Date()): Promise<PortalHome> {
  const roots = await listPortalRoots(user.id, now);
  const shared = roots.map((root) => toPortalDto(root.resource, root.role, root.allowDownload));

  const uploadFolders = shared.filter((item) => item.capabilities.canUpload);

  /**
   * อัปโหลดล่าสุด = สิ่งที่เพิ่งถูกเพิ่มเข้ามาในโฟลเดอร์ที่แชร์ให้ลูกค้ารายนี้
   * จำกัดอยู่ในโฟลเดอร์ที่ได้รับสิทธิ์โดยตรงเท่านั้น จึงไม่ต้องไล่ลำดับชั้นทั้งระบบ
   */
  const folderIds = roots.filter((root) => root.resource.type === 'FOLDER').map((root) => root.resource.id);
  const roleByFolder = new Map(roots.map((root) => [root.resource.id, root]));

  const recent = folderIds.length
    ? await prisma.resource.findMany({
        where: { parentId: { in: folderIds }, deletedAt: null, type: 'FILE' },
        select: portalResourceSelect,
        orderBy: { createdAt: 'desc' },
        take: 10,
      })
    : [];

  const recentUploads = recent.map((item) => {
    const parent = item.parentId ? roleByFolder.get(item.parentId) : undefined;
    return toPortalDto(item, parent?.role ?? 'VIEWER', parent?.allowDownload ?? false);
  });

  return { shared, recentUploads, uploadFolders };
}

/* ------------------------------------------------------------------ */
/* เปิดโฟลเดอร์และดูรายละเอียด                                          */
/* ------------------------------------------------------------------ */

export interface PortalFolderView {
  folder: PortalResourceDto;
  breadcrumb: Array<{ id: string; name: string }>;
  items: PortalResourceDto[];
}

export async function openPortalFolder(
  user: AuthUser,
  folderId: string,
  audit: AuditContext,
  now: Date = new Date(),
): Promise<PortalFolderView> {
  const access = await resolvePortalAccess(user.id, folderId, now);
  if (access.resource.type !== 'FOLDER') throw portalNotFound();

  const children = await prisma.resource.findMany({
    where: { parentId: folderId, deletedAt: null },
    select: portalResourceSelect,
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
    take: 500,
  });

  await auditExternal(EXTERNAL_AUDIT_ACTIONS.VIEWED, user, folderId, audit, { kind: 'FOLDER' });

  return {
    folder: toPortalDto(access.resource, access.role, access.allowDownload),
    breadcrumb: access.breadcrumb,
    /**
     * สิทธิ์ของลูกภายในโฟลเดอร์สืบทอดมาจากสิทธิ์ที่มีผลบนโฟลเดอร์นี้
     * ยกเว้นชนิดที่ไม่ควรปรากฏต่อสายตาลูกค้า ซึ่งถูกกรองทิ้งทั้งหมด
     */
    items: children
      .filter((child) => isPortalVisibleType(child.type))
      .map((child) => toPortalDto(child, access.role, access.allowDownload)),
  };
}

export async function getPortalResource(
  user: AuthUser,
  resourceId: string,
  audit: AuditContext,
  now: Date = new Date(),
): Promise<{ resource: PortalResourceDto; breadcrumb: Array<{ id: string; name: string }> }> {
  const access = await resolvePortalAccess(user.id, resourceId, now);
  await auditExternal(EXTERNAL_AUDIT_ACTIONS.VIEWED, user, resourceId, audit, { kind: access.resource.type });
  return {
    resource: toPortalDto(access.resource, access.role, access.allowDownload),
    breadcrumb: access.breadcrumb,
  };
}

/* ------------------------------------------------------------------ */
/* ค้นหา                                                              */
/* ------------------------------------------------------------------ */

/** ผลการค้นหาพร้อมเส้นทางที่ปลอดภัยพอจะแสดงให้ลูกค้าเห็น */
export interface PortalSearchResultDto extends PortalResourceDto {
  /**
   * เส้นทางแบบตรรกะ เริ่มที่โฟลเดอร์ที่ถูกแชร์ให้เสมอ
   * ชั้นเหนือรากถูกตัดทิ้งตั้งแต่ชั้นค้นหา ชื่อไดร์ฟภายในจึงไม่มีทางหลุดออกมา
   */
  path: Array<{ id: string; name: string }>;
  /** ป้ายภาษาไทยบอกว่าทำไมผลลัพธ์นี้ถึงขึ้นมา */
  matchLabel: string;
  /** ข้อความล้วนรอบคำค้น - ไม่มีแท็กและไม่มีเครื่องหมายไฮไลต์ */
  contentSnippet: string | null;
}

/**
 * ค้นหาภายในขอบเขตที่ลูกค้าเข้าถึงได้เท่านั้น
 *
 * ไม่ใช้เส้นทางค้นหาภายในร่วมกันโดยตั้งใจ - การกรองผลลัพธ์ทีหลังจากชุดข้อมูลทั้งระบบ
 * เป็นรูปแบบที่พลาดง่ายและรั่วเงียบ
 *
 * การไล่ลำดับชั้นอยู่ที่ portal-search.ts ซึ่งเริ่มจากรากที่ได้รับสิทธิ์แล้วไล่ลงทุกชั้น
 * ในคำสั่งเดียว ผลลัพธ์ที่คืนกลับมาผ่านการอนุญาตแล้วทั้งหมด
 */
export async function searchPortal(
  user: AuthUser,
  term: string,
  now: Date = new Date(),
): Promise<PortalSearchResultDto[]> {
  const hits = await searchGrantedSubtrees(user.id, term, now);

  /**
   * ตัวอย่างข้อความถูกดึงหลังการอนุญาตเสร็จสิ้นแล้วเท่านั้น
   * รหัสที่ส่งเข้าไปคือรายการที่ผ่านการไล่ลำดับชั้นจากรากที่ได้รับสิทธิ์มาแล้วทั้งหมด
   */
  const contentHits = hits.filter((hit) => hit.contentMatch).map((hit) => hit.resource.id);
  const snippets = contentHits.length > 0 ? await snippetsFor(contentHits, term) : new Map<string, string>();

  return hits.map((hit) => ({
    ...toPortalDto(hit.resource, hit.role, hit.allowDownload),
    path: hit.path,
    matchLabel: hit.contentMatch ? 'ตรงกับเนื้อหาเอกสาร' : 'ตรงกับชื่อไฟล์',
    contentSnippet: hit.contentMatch ? snippets.get(hit.resource.id) ?? null : null,
  }));
}

/* ------------------------------------------------------------------ */
/* เนื้อหาและการดาวน์โหลด                                               */
/* ------------------------------------------------------------------ */

export interface PortalContent {
  storageKey: string;
  size: number;
  mimeType: string;
  fileName: string;
  resourceId: string;
}

/**
 * หาไฟล์จริงที่จะสตรีมออกไป
 *
 * เฟสนี้ให้ลูกค้าเห็นเฉพาะเวอร์ชันล่าสุด ไม่มีทางเข้าถึงประวัติเวอร์ชันภายใน
 * requireDownload = true จะบังคับใช้ allowDownload ของการแชร์
 * ซึ่งแปลว่า "เปิดดูได้ แต่บันทึกลงเครื่องไม่ได้" เป็นสถานะที่มีอยู่จริงและใช้ได้
 */
export async function resolvePortalContent(
  user: AuthUser,
  resourceId: string,
  options: { requireDownload: boolean },
  now: Date = new Date(),
): Promise<{ content: PortalContent; access: PortalAccess }> {
  const access = await resolvePortalAccess(user.id, resourceId, now);
  const resource = access.resource;

  if (resource.type !== 'FILE') throw portalNotFound();

  const caps = externalCapabilities({
    role: access.role,
    allowDownload: access.allowDownload,
    resourceType: resource.type,
    isLocked: resource.isLocked,
  });
  if (options.requireDownload && !caps.canDownload) {
    throw new AppError('DOWNLOAD_DENIED', 'เอกสารนี้เปิดดูได้ แต่ไม่อนุญาตให้ดาวน์โหลด', 403);
  }

  if (!resource.storageKey) throw portalNotFound();

  return {
    content: {
      storageKey: resource.storageKey,
      size: resource.size === null ? 0 : Number(resource.size),
      mimeType: resource.mimeType ?? 'application/octet-stream',
      fileName: resource.name,
      resourceId: resource.id,
    },
    access,
  };
}

export async function logPortalDownload(
  user: AuthUser,
  resourceId: string,
  audit: AuditContext,
  versionNumber?: number,
): Promise<void> {
  await auditExternal(
    EXTERNAL_AUDIT_ACTIONS.DOWNLOADED,
    user,
    resourceId,
    audit,
    versionNumber === undefined ? {} : { versionNumber },
  );
}

/* ------------------------------------------------------------------ */
/* มุมมองของผู้ดูแล                                                     */
/* ------------------------------------------------------------------ */

export interface ClientGrantDto {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  role: PortalRole;
  allowDownload: boolean;
  expiresAt: Date | null;
  isExpired: boolean;
  sharedAt: Date;
}

export interface ClientPortalSummary {
  googleLinked: boolean;
  activeGrants: number;
  grants: ClientGrantDto[];
}

/**
 * "ลูกค้ารายนี้เข้าถึงอะไรได้บ้าง" - คำถามที่ผู้ดูแลต้องตอบได้ในหน้าจอเดียว
 *
 * รวมสิทธิ์ที่หมดอายุแล้วไว้ด้วย เพราะการเห็นว่าเคยให้ไว้เป็นข้อมูลที่ต้องใช้ตอนตรวจสอบ
 * แต่ต้องแยกให้ชัดว่าไม่มีผลแล้ว มิฉะนั้นจะเข้าใจผิดว่าลูกค้ายังเปิดเอกสารนั้นได้อยู่
 *
 * ไม่เปิดเผยรหัสของแถวสิทธิ์ - การเพิกถอนอ้างถึงคู่ (ทรัพยากร, ผู้ใช้) ซึ่งเพียงพอแล้ว
 */
export async function clientPortalSummary(
  userId: string,
  now: Date = new Date(),
): Promise<ClientPortalSummary> {
  const [identity, grants] = await Promise.all([
    prisma.userIdentity.findUnique({
      where: { provider_userId: { provider: 'GOOGLE', userId } },
      select: { id: true },
    }),
    prisma.resourceAccess.findMany({
      where: { userId, resource: { deletedAt: null } },
      select: {
        accessLevel: true,
        allowDownload: true,
        expiresAt: true,
        createdAt: true,
        resource: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
  ]);

  const rows = grants.map((grant) => ({
    resourceId: grant.resource.id,
    resourceName: grant.resource.name,
    resourceType: grant.resource.type,
    role: portalRoleFor(grant.accessLevel),
    allowDownload: grant.allowDownload,
    expiresAt: grant.expiresAt,
    isExpired: !isGrantActive(grant, now),
    sharedAt: grant.createdAt,
  }));

  return {
    googleLinked: identity !== null,
    activeGrants: rows.filter((row) => !row.isExpired).length,
    grants: rows,
  };
}

/* ------------------------------------------------------------------ */
/* ประวัติเวอร์ชัน                                                      */
/* ------------------------------------------------------------------ */

export interface PortalVersionDto {
  /** เลขลำดับภายในไฟล์นั้น ไม่ใช่รหัสระดับระบบ - ใช้เป็นที่อยู่ของเวอร์ชันด้วย */
  versionNumber: number;
  createdAt: Date;
  size: number;
  /** ชื่อที่แสดงของผู้อัปโหลด ไม่ใช่อีเมลหรือรหัสผู้ใช้ */
  uploadedBy: string | null;
  isCurrent: boolean;
  canDownload: boolean;
}

/**
 * ประวัติเวอร์ชันที่ลูกค้าเห็นได้
 *
 * อ่านอย่างเดียวทั้งหมด ไม่มีการกู้คืน ไม่มีการลบ ไม่มีการอัปโหลดทับเวอร์ชันเดิม
 *
 * เวอร์ชันถูกอ้างถึงด้วย "เลขลำดับภายในไฟล์" ไม่ใช่รหัสของแถว ResourceVersion
 * การเดารหัสเวอร์ชันของไฟล์คนอื่นจึงเป็นไปไม่ได้เชิงโครงสร้าง ไม่ใช่แค่ถูกปฏิเสธ
 * เพราะเลขลำดับมีความหมายก็ต่อเมื่ออยู่คู่กับไฟล์ที่ตรวจสิทธิ์ผ่านแล้วเท่านั้น
 */
export async function listPortalVersions(
  user: AuthUser,
  resourceId: string,
  audit: AuditContext,
  now: Date = new Date(),
): Promise<PortalVersionDto[]> {
  const access = await resolvePortalAccess(user.id, resourceId, now);
  if (access.resource.type !== 'FILE') throw portalNotFound();

  const caps = externalCapabilities({
    role: access.role,
    allowDownload: access.allowDownload,
    resourceType: access.resource.type,
    isLocked: access.resource.isLocked,
  });

  const versions = await prisma.resourceVersion.findMany({
    where: { resourceId },
    select: {
      versionNumber: true,
      size: true,
      createdAt: true,
      createdBy: { select: { displayName: true } },
    },
    orderBy: { versionNumber: 'desc' },
    take: 100,
  });

  await auditExternal(EXTERNAL_AUDIT_ACTIONS.VIEWED, user, resourceId, audit, { kind: 'VERSIONS' });

  return versions.map((version) => ({
    versionNumber: version.versionNumber,
    createdAt: version.createdAt,
    size: Number(version.size),
    uploadedBy: version.createdBy?.displayName ?? null,
    isCurrent: version.versionNumber === access.resource.currentVersion,
    /**
     * สิทธิ์ดาวน์โหลดของเวอร์ชันเก่าเท่ากับของเวอร์ชันปัจจุบันเสมอ
     * ถ้าห้ามดาวน์โหลดไฟล์ การเปิดประวัติแล้วดาวน์โหลดของเก่าแทนต้องไม่เป็นทางออก
     */
    canDownload: caps.canDownload,
  }));
}

/**
 * หาไฟล์จริงของเวอร์ชันหนึ่งที่จะสตรีมออกไป
 *
 * สิทธิ์ถูกตรวจกับ "ไฟล์แม่" เสมอ ไม่ใช่กับตัวเวอร์ชัน
 * เวอร์ชันไม่มีสิทธิ์เป็นของตัวเอง และไม่มีทางถูกอนุญาตโดยลำพัง
 */
export async function resolvePortalVersionContent(
  user: AuthUser,
  resourceId: string,
  versionNumber: number,
  options: { requireDownload: boolean },
  now: Date = new Date(),
): Promise<{ content: PortalContent; access: PortalAccess }> {
  const access = await resolvePortalAccess(user.id, resourceId, now);
  const resource = access.resource;
  if (resource.type !== 'FILE') throw portalNotFound();

  const caps = externalCapabilities({
    role: access.role,
    allowDownload: access.allowDownload,
    resourceType: resource.type,
    isLocked: resource.isLocked,
  });
  if (options.requireDownload && !caps.canDownload) {
    throw new AppError('DOWNLOAD_DENIED', 'เอกสารนี้เปิดดูได้ แต่ไม่อนุญาตให้ดาวน์โหลด', 403);
  }

  const version = await prisma.resourceVersion.findFirst({
    where: { resourceId, versionNumber },
    select: { storageKey: true, size: true, mimeType: true, versionNumber: true },
  });
  // เวอร์ชันที่ไม่มีอยู่ใช้คำตอบเดียวกับเอกสารที่ไม่มีสิทธิ์ - ไม่มีข้อมูลรั่วจากความต่างของข้อความ
  if (!version) throw portalNotFound();

  return {
    content: {
      storageKey: version.storageKey,
      size: Number(version.size),
      mimeType: version.mimeType ?? 'application/octet-stream',
      fileName: resource.name,
      resourceId: resource.id,
    },
    access,
  };
}

/* ------------------------------------------------------------------ */
/* อัปโหลดจากฝั่งลูกค้า                                                 */
/* ------------------------------------------------------------------ */

/**
 * อัปโหลดไฟล์เข้าโฟลเดอร์ที่ลูกค้าได้รับสิทธิ์ CONTRIBUTOR
 *
 * ใช้สายการอัปโหลดเดียวกับภายในทุกประการ - ขนาดสูงสุด ลายเซ็นไฟล์จริง checksum
 * การชนกันของชื่อ และความปลอดภัยของเส้นทาง ไม่มีทางเข้าที่ตรวจน้อยกว่า
 *
 * ปลายทางถูกตัดสินจากสิทธิ์ที่ตรวจแล้วฝั่งเซิร์ฟเวอร์เท่านั้น
 * ค่า parentId ที่ client ส่งมาถูกใช้เพียงเพื่อ "ถาม" ไม่ใช่เพื่อ "สั่ง"
 */
export async function uploadToPortalFolder(
  user: AuthUser,
  folderId: string,
  source: Readable,
  input: { fileName: string; declaredMime?: string },
  audit: AuditContext,
  now: Date = new Date(),
) {
  const access = await resolvePortalAccess(user.id, folderId, now);
  const caps = externalCapabilities({
    role: access.role,
    allowDownload: access.allowDownload,
    resourceType: access.resource.type,
    isLocked: access.resource.isLocked,
  });
  if (!caps.canUpload) {
    throw new AppError('PORTAL_UPLOAD_DENIED', 'ไม่มีสิทธิ์อัปโหลดไฟล์เข้าโฟลเดอร์นี้', 403);
  }

  const result = await uploadFile(
    user,
    source,
    {
      parentId: access.resource.id,
      fileName: input.fileName,
      declaredMime: input.declaredMime,
      // ชื่อซ้ำไม่ทับของเดิม และไม่กลายเป็นเวอร์ชันใหม่ของไฟล์ภายใน
      onNameConflict: 'KEEP_BOTH',
      // เนื้อหาซ้ำไม่ควรกลายเป็นข้อผิดพลาดที่ลูกค้าแก้เองไม่ได้
      allowDuplicateContent: true,
      sourceType: 'EXTERNAL_UPLOAD',
      portalAuthorizedParentId: access.resource.id,
    },
    audit,
  );

  await auditExternal(EXTERNAL_AUDIT_ACTIONS.UPLOADED, user, result.resource.id, audit, {
    folderId: access.resource.id,
    size: result.resource.size,
  });
  logger.info('[PORTAL] ลูกค้าอัปโหลดไฟล์เข้าโฟลเดอร์ที่ได้รับสิทธิ์');

  const stored = await prisma.resource.findUnique({
    where: { id: result.resource.id },
    select: portalResourceSelect,
  });
  if (!stored) throw portalNotFound();
  return toPortalDto(stored, access.role, access.allowDownload);
}
