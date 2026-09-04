import { ZipArchive } from 'archiver';
import type { Prisma } from '@prisma/client';
import { AppError, badRequest, notFound } from '../../core/errors.js';
import { createStoredFileStream, statStoredFile } from '../../core/file-storage.js';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { capabilities, resourceInclude, validateResourceName } from '../resources/resource.service.js';
import { getSetting } from '../system/settings.service.js';
import type { AuditContext } from './file.service.js';

const include = resourceInclude;
type ZipResource = Prisma.ResourceGetPayload<{ include: typeof include }>;

export interface ZipPlanEntry {
  resourceId: string;
  archivePath: string;
  storageKey: string | null;
  size: number;
  directory: boolean;
}

export interface ZipPlan {
  fileName: string;
  entries: ZipPlanEntry[];
  resourceIds: string[];
  totalBytes: number;
}

/** Archive path is built exclusively from validated database names, never storage keys or client paths. */
export function safeArchiveSegment(rawName: string): string {
  return validateResourceName(rawName).name;
}

function assertZipAccess(resource: ZipResource, user: AuthUser): void {
  const caps = capabilities(resource, user);
  const allowed = resource.type === 'FOLDER' ? caps.canView : resource.type === 'FILE' && caps.canDownload;
  if (!allowed) {
    throw new AppError('RESOURCE_ACCESS_DENIED', 'ไม่มีสิทธิ์ดาวน์โหลดรายการที่เลือกทั้งหมด', 403);
  }
}

export interface ZipLimits {
  maxResources: number;
  maxBytes: number;
}

export async function effectiveZipLimits(): Promise<ZipLimits> {
  const [maxResources, maxBytes] = await Promise.all([
    getSetting('ZIP_MAX_RESOURCES'),
    getSetting('ZIP_MAX_BYTES'),
  ]);
  return { maxResources, maxBytes };
}

export function assertZipLimits(entries: ZipPlanEntry[], limits: ZipLimits): number {
  if (entries.length > limits.maxResources) {
    throw new AppError('ZIP_TOO_LARGE', 'รายการที่เลือกมีขนาดใหญ่เกินกว่าจะดาวน์โหลดเป็น ZIP ได้', 413);
  }
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxBytes) {
    throw new AppError('ZIP_TOO_LARGE', 'รายการที่เลือกมีขนาดใหญ่เกินกว่าจะดาวน์โหลดเป็น ZIP ได้', 413);
  }
  return totalBytes;
}

async function loadActive(id: string): Promise<ZipResource> {
  const row = await prisma.resource.findFirst({ where: { id, deletedAt: null }, include });
  if (!row) throw notFound('RESOURCE_NOT_FOUND', 'ไม่พบทรัพยากร');
  return row;
}

/** Remove roots whose active ancestor is already selected. */
async function deduplicateRoots(roots: ZipResource[]): Promise<ZipResource[]> {
  const selected = new Set(roots.map((row) => row.id));
  const keep: ZipResource[] = [];
  for (const root of roots) {
    let parentId = root.parentId;
    let nested = false;
    const seen = new Set<string>();
    while (parentId) {
      if (seen.has(parentId)) throw badRequest('INVALID_RESOURCE_TREE', 'ตรวจพบโครงสร้างโฟลเดอร์ไม่ถูกต้อง');
      seen.add(parentId);
      if (selected.has(parentId)) {
        nested = true;
        break;
      }
      const parent = await prisma.resource.findFirst({ where: { id: parentId, deletedAt: null }, select: { parentId: true } });
      parentId = parent?.parentId ?? null;
    }
    if (!nested) keep.push(root);
  }
  return keep;
}

async function appendTree(
  root: ZipResource,
  archivePath: string,
  user: AuthUser,
  limits: ZipLimits,
  entries: ZipPlanEntry[],
  seenIds: Set<string>,
): Promise<void> {
  if (seenIds.has(root.id)) return;
  seenIds.add(root.id);
  assertZipAccess(root, user);

  if (root.type === 'FILE') {
    if (!root.storageKey || root.size === null) throw notFound('FILE_NOT_FOUND', 'ไม่พบไฟล์ในพื้นที่จัดเก็บ');
    const size = Number(root.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new AppError('FILE_METADATA_INVALID', 'ข้อมูลขนาดไฟล์ไม่ถูกต้อง', 500);
    entries.push({ resourceId: root.id, archivePath, storageKey: root.storageKey, size, directory: false });
    assertZipLimits(entries, limits);
    return;
  }

  if (root.type !== 'FOLDER') throw badRequest('ZIP_UNSUPPORTED_RESOURCE', 'ZIP รองรับเฉพาะไฟล์และโฟลเดอร์');
  entries.push({ resourceId: root.id, archivePath: `${archivePath}/`, storageKey: null, size: 0, directory: true });
  assertZipLimits(entries, limits);

  const children = await prisma.resource.findMany({
    where: { parentId: root.id, deletedAt: null },
    include,
    orderBy: { normalizedName: 'asc' },
  });
  for (const child of children) {
    await appendTree(child, `${archivePath}/${safeArchiveSegment(child.name)}`, user, limits, entries, seenIds);
  }
}

export async function createZipPlan(resourceIds: string[], user: AuthUser, folderOnly = false): Promise<ZipPlan> {
  const uniqueIds = [...new Set(resourceIds)];
  if (uniqueIds.length === 0) throw badRequest('RESOURCE_IDS_REQUIRED', 'กรุณาเลือกรายการอย่างน้อยหนึ่งรายการ');
  const limits = await effectiveZipLimits();
  if (uniqueIds.length > limits.maxResources) {
    throw new AppError('ZIP_TOO_LARGE', 'รายการที่เลือกมีขนาดใหญ่เกินกว่าจะดาวน์โหลดเป็น ZIP ได้', 413);
  }

  const roots = await Promise.all(uniqueIds.map(loadActive));
  if (folderOnly && (roots.length !== 1 || roots[0]?.type !== 'FOLDER')) {
    throw badRequest('FOLDER_REQUIRED', 'รายการนี้ไม่ใช่โฟลเดอร์');
  }
  roots.forEach((root) => assertZipAccess(root, user));
  const deduped = await deduplicateRoots(roots);
  const entries: ZipPlanEntry[] = [];
  const seenIds = new Set<string>();
  for (const root of deduped) {
    await appendTree(root, safeArchiveSegment(root.name), user, limits, entries, seenIds);
  }

  const totalBytes = assertZipLimits(entries, limits);
  const fileName = folderOnly
    ? `${safeArchiveSegment(deduped[0]!.name)}.zip`
    : `S2-NAS-Download-${new Date().toISOString().slice(0, 10)}.zip`;
  return { fileName, entries, resourceIds: deduped.map((row) => row.id), totalBytes };
}

export async function createZipStream(plan: ZipPlan) {
  const archive = new ZipArchive({ zlib: { level: 6 }, forceLocalTime: false });
  for (const entry of plan.entries) {
    if (entry.directory) {
      archive.append('', { name: entry.archivePath, date: new Date(0) });
      continue;
    }
    const stat = await statStoredFile(entry.storageKey!);
    if (!stat || stat.size !== entry.size) throw notFound('FILE_NOT_FOUND', 'ไม่พบไฟล์ในพื้นที่จัดเก็บ');
    archive.append(createStoredFileStream(entry.storageKey!), { name: entry.archivePath, date: stat.mtime });
  }
  return archive;
}

export async function logZipDownload(user: AuthUser, plan: ZipPlan, audit: AuditContext): Promise<void> {
  await prisma.activityLog.create({
    data: {
      userId: user.id,
      action: 'RESOURCE_ZIP_DOWNLOADED',
      resourceId: plan.resourceIds.length === 1 ? plan.resourceIds[0] : null,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent?.slice(0, 500),
      metadata: { resourceIds: plan.resourceIds, count: plan.entries.length, totalBytes: plan.totalBytes },
    },
  });
}
