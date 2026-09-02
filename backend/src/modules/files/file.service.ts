import type { Readable } from 'node:stream';
import { prisma } from '../../core/prisma.js';
import { AppError, forbidden, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import {
  commitStagedFile,
  deleteStoredFile,
  discardStagedFile,
  removeResourceDirectory,
  stageUpload,
  type StagedFile,
} from '../../core/file-storage.js';
import { capabilities, toResourceDto, validateResourceName } from '../resources/resource.service.js';
import { resolveMimeType, sanitizeFileName } from './file-security.js';
import type { AuthUser } from '../auth/auth.service.js';

const ownerSelect = { id: true, displayName: true, email: true } as const;
const resourceInclude = {
  owner: { select: ownerSelect },
  createdBy: { select: ownerSelect },
  access: { select: { userId: true, accessLevel: true, allowDownload: true } },
  _count: { select: { children: { where: { deletedAt: null } } } },
} as const;

export type NameConflictPolicy = 'FAIL' | 'NEW_VERSION' | 'KEEP_BOTH';

export interface UploadInput {
  parentId: string | null;
  fileName: string;
  declaredMime?: string;
  remark?: string | null;
  /** ผู้ใช้ตัดสินใจแล้วว่าจะทำอย่างไรเมื่อชื่อซ้ำ */
  onNameConflict?: NameConflictPolicy;
  /** ผู้ใช้ยืนยันว่าจะอัปโหลดต่อแม้เนื้อหาซ้ำกับไฟล์ที่มีอยู่ */
  allowDuplicateContent?: boolean;
}

export interface AuditContext {
  ipAddress?: string;
  userAgent?: string;
}

/* ------------------------------------------------------------------ */
/* ตัวช่วยภายใน                                                        */
/* ------------------------------------------------------------------ */

async function loadResource(id: string) {
  const resource = await prisma.resource.findFirst({ where: { id }, include: resourceInclude });
  if (!resource) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  return resource;
}

function siblingKey(parentId: string | null, normalizedName: string): string {
  return `${parentId ?? 'ROOT'}:${normalizedName}`;
}

/** โฟลเดอร์ปลายทางต้องมีอยู่ ยังไม่ถูกลบ และผู้ใช้ต้องมีสิทธิ์สร้างในนั้น */
async function assertUploadTarget(parentId: string | null, user: AuthUser) {
  if (!parentId) {
    if (!user.permissions.includes('resources:write')) {
      throw forbidden('ไม่มีสิทธิ์อัปโหลดไฟล์ในระดับราก');
    }
    return null;
  }

  const parent = await loadResource(parentId);
  if (parent.deletedAt) throw notFound('FOLDER_NOT_FOUND', 'ไม่พบโฟลเดอร์ปลายทาง');
  if (parent.type !== 'FOLDER') throw notFound('FOLDER_NOT_FOUND', 'ปลายทางไม่ใช่โฟลเดอร์');
  if (!capabilities(parent, user).canEdit) {
    throw new AppError('RESOURCE_ACCESS_DENIED', 'ไม่มีสิทธิ์อัปโหลดไฟล์ในโฟลเดอร์นี้', 403);
  }
  return parent;
}

/** ชื่อไฟล์ที่ไม่ชนกับพี่น้องเดิม เช่น report.pdf → report (2).pdf */
async function findAvailableName(parentId: string | null, fileName: string): Promise<string> {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const suffix = dot > 0 ? fileName.slice(dot) : '';

  for (let counter = 2; counter < 200; counter += 1) {
    const candidate = `${stem} (${counter})${suffix}`;
    const normalized = validateResourceName(candidate).normalizedName;
    const taken = await prisma.resource.findFirst({
      where: { siblingKey: siblingKey(parentId, normalized), deletedAt: null },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  throw new AppError('FILE_NAME_EXISTS', 'มีไฟล์ชื่อนี้อยู่แล้วจำนวนมากเกินไป', 409);
}

/* ------------------------------------------------------------------ */
/* อัปโหลดไฟล์ใหม่                                                     */
/* ------------------------------------------------------------------ */

export interface UploadResult {
  status: 'CREATED' | 'VERSION_ADDED';
  resource: ReturnType<typeof toResourceDto>;
  /** แจ้งเมื่อพบไฟล์อื่นที่เนื้อหาเหมือนกัน แต่ผู้ใช้ยืนยันอัปโหลดต่อแล้ว */
  duplicateOf?: { id: string; name: string };
}

/**
 * อัปโหลดไฟล์ใหม่เข้าโฟลเดอร์
 *
 * ลำดับการทำงานแบบ atomic:
 *   1. ตรวจสิทธิ์และชื่อไฟล์
 *   2. สตรีมลงพื้นที่ชั่วคราว พร้อมคำนวณ SHA-256 และขนาดจริง
 *   3. ตรวจเนื้อหาซ้ำและชื่อซ้ำ
 *   4. ย้ายไฟล์เข้าตำแหน่งจริง
 *   5. สร้าง Resource + ResourceVersion + ActivityLog ใน transaction เดียว
 *
 * ถ้าขั้นตอนใดล้มเหลวหลังไฟล์ลงดิสก์แล้ว ไฟล์นั้นจะถูกลบทิ้งเสมอ
 * จึงไม่มีทางเกิด metadata ที่ไม่มีไฟล์จริง หรือไฟล์จริงที่ไม่มี metadata
 */
export async function uploadFile(
  user: AuthUser,
  source: Readable,
  input: UploadInput,
  audit: AuditContext,
): Promise<UploadResult> {
  const parent = await assertUploadTarget(input.parentId, user);
  const { name, extension } = sanitizeFileName(input.fileName);
  const { normalizedName } = validateResourceName(name);

  let staged: StagedFile | null = null;

  try {
    staged = await stageUpload(source);

    // ตรวจชนิดไฟล์จากลายเซ็นจริง ไม่เชื่อค่าที่เบราว์เซอร์ประกาศมา
    const { createReadStream } = await import('node:fs');
    const head = await readHead(createReadStream(staged.tempPath, { start: 0, end: 63 }));
    const mime = resolveMimeType(head, extension, input.declaredMime);

    // เนื้อหาซ้ำ: แจ้งให้ผู้ใช้ตัดสินใจ ไม่เงียบ ๆ ทิ้งไฟล์
    const duplicate = await prisma.resource.findFirst({
      where: { checksum: staged.checksum, size: BigInt(staged.size), deletedAt: null, type: 'FILE' },
      select: { id: true, name: true },
    });
    if (duplicate && !input.allowDuplicateContent) {
      await discardStagedFile(staged);
      throw new AppError('DUPLICATE_CONTENT', 'พบไฟล์ที่มีเนื้อหาเหมือนกันในระบบแล้ว', 409, {
        existing: duplicate,
      });
    }

    // ชื่อซ้ำในโฟลเดอร์เดียวกัน
    const existing = await prisma.resource.findFirst({
      where: { siblingKey: siblingKey(input.parentId, normalizedName), deletedAt: null },
      include: resourceInclude,
    });

    if (existing) {
      const policy = input.onNameConflict ?? 'FAIL';

      if (policy === 'FAIL') {
        await discardStagedFile(staged);
        throw new AppError('FILE_NAME_EXISTS', `มีไฟล์ชื่อ ${name} อยู่แล้ว`, 409, {
          existing: { id: existing.id, name: existing.name, type: existing.type },
        });
      }

      if (policy === 'NEW_VERSION') {
        if (existing.type !== 'FILE') {
          await discardStagedFile(staged);
          throw new AppError('FILE_NAME_EXISTS', 'มีโฟลเดอร์ชื่อเดียวกันอยู่แล้ว', 409);
        }
        const resource = await addVersionFromStaged(user, existing.id, staged, mime.mimeType, input.remark ?? null, audit);
        staged = null;
        return { status: 'VERSION_ADDED', resource, ...(duplicate ? { duplicateOf: duplicate } : {}) };
      }
    }

    const finalName = existing ? await findAvailableName(input.parentId, name) : name;
    const finalNormalized = validateResourceName(finalName).normalizedName;

    const resourceId = crypto.randomUUID();
    const stored = await commitStagedFile(staged, resourceId);
    staged = null; // ไฟล์ถูกย้ายเข้าที่แล้ว ไม่ต้องลบ temp ซ้ำ

    try {
      const created = await prisma.$transaction(async (tx) => {
        const resource = await tx.resource.create({
          data: {
            id: resourceId,
            type: 'FILE',
            name: finalName,
            normalizedName: finalNormalized,
            siblingKey: siblingKey(input.parentId, finalNormalized),
            parentId: input.parentId,
            // ความรับผิดชอบของไฟล์ผูกกับผู้ดูแลพื้นที่ ไม่ใช่ผู้อัปโหลด
            ownerId: parent?.ownerId ?? user.id,
            createdById: user.id,
            updatedById: user.id,
            sourceType: 'MANUAL',
            // สืบทอดนโยบายการมองเห็นจากโฟลเดอร์แม่
            visibility: parent?.visibility ?? 'ORGANIZATION',
            mimeType: mime.mimeType,
            extension,
            size: BigInt(stored.size),
            storageKey: stored.storageKey,
            checksum: stored.checksum,
            currentVersion: 1,
            remark: input.remark ?? null,
          },
          include: resourceInclude,
        });

        await tx.resourceVersion.create({
          data: {
            resourceId: resource.id,
            versionNumber: 1,
            storageKey: stored.storageKey,
            size: BigInt(stored.size),
            checksum: stored.checksum,
            mimeType: mime.mimeType,
            createdById: user.id,
            remark: input.remark ?? null,
          },
        });

        await tx.activityLog.create({
          data: {
            userId: user.id,
            action: 'RESOURCE_UPLOADED',
            resourceId: resource.id,
            ipAddress: audit.ipAddress,
            userAgent: audit.userAgent?.slice(0, 500),
            metadata: { parentId: input.parentId, size: stored.size, mimeConfidence: mime.confidence },
          },
        });

        return resource;
      });

      logger.info(`[UPLOAD] "${finalName}" (${stored.size} bytes)`);
      return {
        status: 'CREATED',
        resource: toResourceDto(created, user),
        ...(duplicate ? { duplicateOf: duplicate } : {}),
      };
    } catch (error) {
      // ชดเชย: ฐานข้อมูลล้มเหลวหลังไฟล์ลงดิสก์แล้ว ต้องลบไฟล์ทิ้งไม่ให้เป็นขยะ
      await deleteStoredFile(stored.storageKey);
      await removeResourceDirectory(resourceId);
      logger.error({ err: error }, '[UPLOAD] บันทึกฐานข้อมูลไม่สำเร็จ ลบไฟล์ที่เขียนไปแล้ว');
      throw new AppError('FILE_UPLOAD_FAILED', 'บันทึกข้อมูลไฟล์ไม่สำเร็จ', 500);
    }
  } finally {
    if (staged) await discardStagedFile(staged);
  }
}

async function readHead(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------ */
/* เวอร์ชันใหม่ของไฟล์เดิม                                              */
/* ------------------------------------------------------------------ */

export async function uploadVersion(
  user: AuthUser,
  resourceId: string,
  source: Readable,
  input: { remark?: string | null; declaredMime?: string },
  audit: AuditContext,
): Promise<ReturnType<typeof toResourceDto>> {
  const resource = await loadResource(resourceId);
  if (resource.deletedAt) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  if (resource.type !== 'FILE') throw new AppError('INVALID_RESOURCE_TYPE', 'อัปโหลดเวอร์ชันได้เฉพาะไฟล์', 400);
  if (!capabilities(resource, user).canUploadVersion) {
    throw new AppError('RESOURCE_ACCESS_DENIED', 'ไม่มีสิทธิ์อัปโหลดเวอร์ชันใหม่ของไฟล์นี้', 403);
  }

  let staged: StagedFile | null = null;
  try {
    staged = await stageUpload(source);
    const { createReadStream } = await import('node:fs');
    const head = await readHead(createReadStream(staged.tempPath, { start: 0, end: 63 }));
    const mime = resolveMimeType(head, resource.extension, input.declaredMime);

    const dto = await addVersionFromStaged(user, resourceId, staged, mime.mimeType, input.remark ?? null, audit);
    staged = null;
    return dto;
  } finally {
    if (staged) await discardStagedFile(staged);
  }
}

/**
 * สร้างเวอร์ชันใหม่จากไฟล์ที่ staged ไว้แล้ว
 * เลขเวอร์ชันถูกกำหนดภายใน transaction และมี unique constraint (resourceId, versionNumber)
 * กันการอัปโหลดพร้อมกันไม่ให้ได้เลขซ้ำ
 */
async function addVersionFromStaged(
  user: AuthUser,
  resourceId: string,
  staged: StagedFile,
  mimeType: string,
  remark: string | null,
  audit: AuditContext,
): Promise<ReturnType<typeof toResourceDto>> {
  const stored = await commitStagedFile(staged, resourceId);

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const latest = await tx.resourceVersion.findFirst({
        where: { resourceId },
        orderBy: { versionNumber: 'desc' },
        select: { versionNumber: true },
      });
      const versionNumber = (latest?.versionNumber ?? 0) + 1;

      await tx.resourceVersion.create({
        data: {
          resourceId,
          versionNumber,
          storageKey: stored.storageKey,
          size: BigInt(stored.size),
          checksum: stored.checksum,
          mimeType,
          createdById: user.id,
          remark,
        },
      });

      const resource = await tx.resource.update({
        where: { id: resourceId },
        data: {
          // Resource สะท้อน metadata ล่าสุดเพื่อให้ listing เร็ว
          size: BigInt(stored.size),
          checksum: stored.checksum,
          mimeType,
          storageKey: stored.storageKey,
          currentVersion: versionNumber,
          updatedById: user.id,
        },
        include: resourceInclude,
      });

      await tx.activityLog.create({
        data: {
          userId: user.id,
          action: 'RESOURCE_VERSION_CREATED',
          resourceId,
          ipAddress: audit.ipAddress,
          userAgent: audit.userAgent?.slice(0, 500),
          metadata: { versionNumber, size: stored.size },
        },
      });

      return resource;
    });

    logger.info(`[UPLOAD] เวอร์ชันใหม่ของ "${updated.name}" (v${updated.currentVersion})`);
    return toResourceDto(updated, user);
  } catch (error) {
    await deleteStoredFile(stored.storageKey);
    logger.error({ err: error }, '[UPLOAD] สร้างเวอร์ชันไม่สำเร็จ ลบไฟล์ที่เขียนไปแล้ว');
    if (error instanceof AppError) throw error;
    throw new AppError('VERSION_CONFLICT', 'สร้างเวอร์ชันใหม่ไม่สำเร็จ', 409);
  }
}

/* ------------------------------------------------------------------ */
/* อ่านเวอร์ชันและเนื้อหา                                               */
/* ------------------------------------------------------------------ */

export async function listVersions(resourceId: string, user: AuthUser) {
  const resource = await loadResource(resourceId);
  const caps = capabilities(resource, user);
  if (!caps.canView) throw forbidden('ไม่มีสิทธิ์ดูทรัพยากรนี้');

  const versions = await prisma.resourceVersion.findMany({
    where: { resourceId },
    include: { createdBy: { select: ownerSelect } },
    orderBy: { versionNumber: 'desc' },
  });

  return versions.map((version) => ({
    id: version.id,
    versionNumber: version.versionNumber,
    size: Number(version.size),
    checksum: version.checksum,
    mimeType: version.mimeType,
    remark: version.remark,
    createdAt: version.createdAt,
    createdBy: version.createdBy,
    isCurrent: version.versionNumber === resource.currentVersion,
    canDownload: caps.canDownload,
  }));
}

export interface ResolvedContent {
  storageKey: string;
  size: number;
  mimeType: string;
  fileName: string;
  resourceId: string;
  versionNumber: number | null;
}

/**
 * หาไฟล์จริงที่จะสตรีมออกไป พร้อมตรวจสิทธิ์เสมอ
 * เซิร์ฟเวอร์เป็นผู้ตัดสิน ไม่ใช่การซ่อนปุ่มบนหน้าจอ
 */
export async function resolveContent(
  resourceId: string,
  user: AuthUser,
  options: { versionNumber?: number; requireDownload?: boolean } = {},
): Promise<ResolvedContent> {
  const resource = await loadResource(resourceId);
  if (resource.deletedAt) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  if (resource.type !== 'FILE') throw new AppError('INVALID_RESOURCE_TYPE', 'ทรัพยากรนี้ไม่ใช่ไฟล์', 400);

  const caps = capabilities(resource, user);
  if (!caps.canView) throw forbidden('ไม่มีสิทธิ์ดูไฟล์นี้');
  if (options.requireDownload && !caps.canDownload) {
    throw new AppError('DOWNLOAD_DENIED', 'ไม่มีสิทธิ์ดาวน์โหลดไฟล์นี้', 403);
  }

  if (options.versionNumber !== undefined) {
    const version = await prisma.resourceVersion.findFirst({
      where: { resourceId, versionNumber: options.versionNumber },
    });
    if (!version) throw notFound('VERSION_NOT_FOUND', 'ไม่พบเวอร์ชันที่ระบุ');
    return {
      storageKey: version.storageKey,
      size: Number(version.size),
      mimeType: version.mimeType ?? 'application/octet-stream',
      fileName: resource.name,
      resourceId: resource.id,
      versionNumber: version.versionNumber,
    };
  }

  if (!resource.storageKey) throw notFound('FILE_NOT_FOUND', 'ไฟล์นี้ยังไม่มีเนื้อหาในระบบ');

  return {
    storageKey: resource.storageKey,
    size: resource.size === null ? 0 : Number(resource.size),
    mimeType: resource.mimeType ?? 'application/octet-stream',
    fileName: resource.name,
    resourceId: resource.id,
    versionNumber: resource.currentVersion,
  };
}

export async function logDownload(
  user: AuthUser,
  resourceId: string,
  versionNumber: number | null,
  audit: AuditContext,
): Promise<void> {
  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: 'RESOURCE_DOWNLOADED',
      resourceId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: versionNumber === null ? undefined : { versionNumber },
    },
  });
}

/** ขนาดรวมของไฟล์ที่ S2 NAS ดูแลอยู่จริง แยกจากพื้นที่ดิสก์ของทั้ง volume */
export async function getManagedStorageBytes(): Promise<number> {
  const result = await prisma.resource.aggregate({
    where: { type: 'FILE', deletedAt: null },
    _sum: { size: true },
  });
  return result._sum.size === null ? 0 : Number(result._sum.size);
}
