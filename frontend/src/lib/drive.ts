import { resourceApi, type ResourceCapabilities, type ResourceDto, type TagDto } from './api';

export type DriveEntryKind = 'folder' | 'file';
export type SharePermission = 'OWNER' | 'EDITOR' | 'VIEWER';
export interface DriveEntry {
  id: string; kind: DriveEntryKind; resourceType: ResourceDto['type']; name: string;
  extension?: string; sizeBytes?: number; itemCount?: number;
  ownerId: string; ownerName: string; ownerEmail: string; modifiedAt: string; createdAt: string;
  mimeType: string | null;
  /** ผู้อัปโหลดตามประวัติ แยกจากผู้ดูแลพื้นที่ (owner) อย่างชัดเจน */
  uploadedBy: { id: string; displayName: string; email: string } | null;
  currentVersion: number | null;
  visibility: 'ORGANIZATION' | 'RESTRICTED';
  favorite: boolean; pinned: boolean; parentId: string | null; remark?: string; isLocked: boolean;
  tags: TagDto[];
  lockReason: string | null;
  lockedAt: string | null;
  lockedByName: string | null;
  source?: import('@/components/files/ResourceSourceBadge').ResourceSource;
  capabilities: ResourceCapabilities;
  location?: string; sharedBy?: string; sharedAt?: string; permission?: SharePermission;
  deletedBy?: string; deletedAt?: string;
}
export interface BreadcrumbNode { id: string | null; name: string }
export type DriveScope = 'files' | 'shared' | 'recent' | 'favorites' | 'trash';
export interface DriveListing { entries: DriveEntry[]; breadcrumb: BreadcrumbNode[] }

const SOURCE_MAP: Record<ResourceDto['sourceType'], import('@/components/files/ResourceSourceBadge').ResourceSource> = {
  MANUAL: 'MANUAL', GOOGLE: 'GOOGLE', S2_PAYROLL: 'S2_PAYROLL', S2_ERP: 'S2_ERP',
  S2_LINE_BOT: 'S2_LINE_BOT', EXTERNAL_UPLOAD: 'EXTERNAL_UPLOAD', SYSTEM: 'SYSTEM',
};

export function toDriveEntry(resource: ResourceDto): DriveEntry {
  return {
    id: resource.id, kind: resource.type === 'FOLDER' ? 'folder' : 'file', resourceType: resource.type,
    name: resource.name, extension: resource.extension ?? undefined, sizeBytes: resource.size ?? undefined,
    itemCount: resource.type === 'FOLDER' ? resource.itemCount : undefined,
    ownerId: resource.owner.id, ownerName: resource.owner.displayName, ownerEmail: resource.owner.email,
    modifiedAt: resource.updatedAt, createdAt: resource.createdAt, parentId: resource.parentId,
    favorite: false, pinned: false,
    tags: resource.tags ?? [],
    lockReason: resource.lockReason ?? null,
    lockedAt: resource.lockedAt ?? null,
    lockedByName: resource.lockedBy?.displayName ?? null,
    mimeType: resource.mimeType, uploadedBy: resource.uploadedBy ?? null,
    currentVersion: resource.currentVersion ?? null, visibility: resource.visibility ?? 'ORGANIZATION',
    remark: resource.remark ?? undefined, isLocked: resource.isLocked,
    source: SOURCE_MAP[resource.sourceType], capabilities: resource.capabilities,
  };
}

export async function listDrive(scope: DriveScope, folderId?: string, sort = 'name', direction: 'asc' | 'desc' = 'asc'): Promise<DriveListing> {
  // /recent ใช้ปลายทางเฉพาะที่เรียงตามเวลาแก้ไขล่าสุดแล้ว
  if (scope === 'recent') {
    const recent = await resourceApi.recent(50);
    return { entries: recent.data.map(toDriveEntry), breadcrumb: [] };
  }
  if (scope !== 'files') return { entries: [], breadcrumb: [] };
  const params = new URLSearchParams({ sort, direction, limit: '100' });
  if (folderId) params.set('parentId', folderId);
  const [listing, crumbs] = await Promise.all([
    resourceApi.list(params),
    folderId ? resourceApi.breadcrumb(folderId) : Promise.resolve({ success: true as const, data: [] }),
  ]);
  return { entries: listing.data.items.map(toDriveEntry), breadcrumb: crumbs.data };
}

/**
 * ติดธง "โปรด" และ "ปักหมุด" ให้รายการที่แสดงอยู่
 *
 * สองอย่างนี้เป็นข้อมูลรายบุคคล ไม่ได้อยู่ใน DTO ของทรัพยากร จึงโหลดแยกครั้งเดียว
 * แล้วนำมาประกบทีหลัง เพื่อไม่ให้ทุกการ list ต้องยิงคำถามซ้ำต่อรายการ
 */
export function applyMarks(entries: DriveEntry[], favorites: Set<string>, pins: Set<string>): DriveEntry[] {
  return entries.map((entry) => ({ ...entry, favorite: favorites.has(entry.id), pinned: pins.has(entry.id) }));
}
