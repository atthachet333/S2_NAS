import type { DriveEntry } from './drive';

export type SelectionDownloadMode = 'ORIGINAL' | 'ZIP' | null;
export const ORIGINAL_DOWNLOAD_LABEL = 'ดาวน์โหลดไฟล์ต้นฉบับ';
export const VERSION_DOWNLOAD_LABEL = 'ดาวน์โหลดเวอร์ชันนี้';

export function selectionDownloadMode(entries: DriveEntry[]): SelectionDownloadMode {
  if (entries.length === 0) return null;
  if (entries.length === 1 && entries[0]?.kind === 'file') return 'ORIGINAL';
  return 'ZIP';
}

export interface MenuPosition { x: number; y: number }

export function clampContextMenuPosition(
  requested: MenuPosition,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): MenuPosition {
  return {
    x: Math.max(margin, Math.min(requested.x, viewport.width - menu.width - margin)),
    y: Math.max(margin, Math.min(requested.y, viewport.height - menu.height - margin)),
  };
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
  { id: 'google-sheet', label: 'เพิ่ม Google Sheet', disabled: true },
  { id: 'google-doc', label: 'เพิ่ม Google Doc', disabled: true },
  { id: 'google-drive', label: 'เพิ่ม Google Drive', disabled: true },
  { id: 'web-link', label: 'เพิ่มลิงก์', disabled: true },
] as const;

export function visibleResourceActions(entry: DriveEntry): string[] {
  if (entry.kind === 'folder') {
    return [
      'open',
      ...(entry.capabilities.canEdit ? ['create-folder-inside', 'upload-here'] : []),
      'download-zip',
      ...(entry.capabilities.canRename ? ['rename'] : []),
      ...(entry.capabilities.canMove ? ['move'] : []),
      ...(entry.capabilities.canTransferOwner ? ['owner'] : []),
      'details',
      ...(entry.capabilities.canDelete ? ['trash'] : []),
    ];
  }
  return [
    'preview',
    ...(entry.capabilities.canDownload ? ['download'] : []),
    ...(entry.capabilities.canUploadVersion ? ['new-version'] : []),
    ...(entry.capabilities.canRename ? ['rename'] : []),
    ...(entry.capabilities.canMove ? ['move'] : []),
    'details',
    ...(entry.capabilities.canDelete ? ['trash'] : []),
  ];
}
