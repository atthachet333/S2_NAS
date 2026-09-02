import type { DriveEntry } from './drive';
import { isExternalEntry } from './external-resources';

export type SelectionDownloadMode = 'ORIGINAL' | 'ZIP' | null;
export const ORIGINAL_DOWNLOAD_LABEL = 'ดาวน์โหลดไฟล์ต้นฉบับ';
export const VERSION_DOWNLOAD_LABEL = 'ดาวน์โหลดเวอร์ชันนี้';

export function selectionDownloadMode(entries: DriveEntry[]): SelectionDownloadMode {
  if (entries.length === 0) return null;
  if (entries.some(isExternalEntry)) return null;
  if (entries.length === 1 && entries[0]?.kind === 'file') return 'ORIGINAL';
  return 'ZIP';
}

export interface MenuPosition { x: number; y: number }
export const CONTEXT_MENU_VIEWPORT_MARGIN = 10;

export function contextMenuMaxHeight(viewportHeight: number, margin = CONTEXT_MENU_VIEWPORT_MARGIN): number {
  return Math.max(0, viewportHeight - margin * 2);
}

export function clampContextMenuPosition(
  requested: MenuPosition,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = CONTEXT_MENU_VIEWPORT_MARGIN,
): MenuPosition {
  return {
    x: Math.max(margin, Math.min(requested.x, viewport.width - menu.width - margin)),
    y: Math.max(margin, Math.min(requested.y, viewport.height - menu.height - margin)),
  };
}

export interface FocusableMenuItem {
  focus(): void;
  scrollIntoView(options?: ScrollIntoViewOptions): void;
}

/** ให้รายการที่รับ focus จากคีย์บอร์ดเลื่อนเข้ามาในพื้นที่เมนูที่มองเห็นเสมอ */
export function focusMenuItem(items: FocusableMenuItem[], index: number): void {
  const item = items[index];
  if (!item) return;
  item.focus();
  item.scrollIntoView({ block: 'nearest' });
}

export function nextMenuIndex(current: number, key: string, count: number): number {
  if (count <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return (current + 1 + count) % count;
  if (key === 'ArrowUp') return (current - 1 + count) % count;
  return current;
}

export const EMPTY_WORKSPACE_ACTIONS = [
  { id: 'create-folder', label: 'สร้างโฟลเดอร์', disabled: false },
  { id: 'upload-here', label: 'อัปโหลดไฟล์', disabled: false },
  { id: 'upload-folder', label: 'อัปโหลดโฟลเดอร์', disabled: true },
  { id: 'google-sheet', label: 'เพิ่ม Google Sheet', disabled: false },
  { id: 'google-doc', label: 'เพิ่ม Google Doc', disabled: false },
  { id: 'google-drive', label: 'เพิ่ม Google Drive', disabled: false },
  { id: 'web-link', label: 'เพิ่มลิงก์', disabled: false },
] as const;

/**
 * เมนูส่วนตัว: โปรดและปักหมุดเป็นของผู้ใช้แต่ละคน ใครก็ตามที่เปิดดูได้ย่อมทำได้
 * จึงไม่ผูกกับสิทธิ์แก้ไข และแสดงทั้งกับโฟลเดอร์และไฟล์เสมอ
 */
function personalActions(entry: DriveEntry): string[] {
  return [entry.favorite ? 'unfavorite' : 'favorite', entry.pinned ? 'unpin' : 'pin'];
}

/** เมนูจัดการข้อมูลกำกับ ขึ้นกับสิทธิ์จริงที่เซิร์ฟเวอร์คำนวณมาให้ */
function metadataActions(entry: DriveEntry): string[] {
  return [
    ...(entry.capabilities.canEdit ? ['tags', 'remark'] : []),
    ...(entry.capabilities.canShare ? ['share'] : []),
    ...(entry.capabilities.canLock ? [entry.isLocked ? 'unlock' : 'lock'] : []),
  ];
}

export function visibleResourceActions(entry: DriveEntry): string[] {
  if (entry.kind === 'folder') {
    return [
      'open',
      ...(entry.capabilities.canEdit ? ['create-folder-inside', 'upload-here'] : []),
      'download-zip',
      ...personalActions(entry),
      ...(entry.capabilities.canRename ? ['rename'] : []),
      ...(entry.capabilities.canMove ? ['move'] : []),
      ...metadataActions(entry),
      ...(entry.capabilities.canTransferOwner ? ['owner'] : []),
      'details',
      'activity',
      ...(entry.capabilities.canDelete ? ['trash'] : []),
    ];
  }
  if (isExternalEntry(entry)) {
    return [
      'open-external', 'copy-external-link',
      ...personalActions(entry),
      ...(entry.capabilities.canRename ? ['rename'] : []),
      ...(entry.capabilities.canMove ? ['move'] : []),
      ...metadataActions(entry),
      ...(entry.capabilities.canEdit ? ['edit-external'] : []),
      'details', 'activity',
      ...(entry.capabilities.canDelete ? ['trash'] : []),
    ];
  }
  return [
    'preview',
    ...(entry.capabilities.canDownload ? ['download'] : []),
    ...(entry.capabilities.canUploadVersion ? ['new-version'] : []),
    ...personalActions(entry),
    ...(entry.capabilities.canRename ? ['rename'] : []),
    ...(entry.capabilities.canMove ? ['move'] : []),
    ...metadataActions(entry),
    'details',
    'activity',
    ...(entry.capabilities.canDelete ? ['trash'] : []),
  ];
}
