import { Lock, MoreVertical } from 'lucide-react';
import type { DriveEntry } from '@/lib/drive';
import { FileTypeIcon } from './FileTypeIcon';
import { getFileTypeStyle } from '@/lib/file-types';
import { cn, formatBytes, formatDateTime, formatRelativeTime } from '@/lib/utils';
import { ResourceSourceBadge, sourceLabel } from './ResourceSourceBadge';
import { OwnerChip } from './OwnerIdentity';

export interface ListColumn {
  key: 'owner' | 'source' | 'modified' | 'size' | 'type' | 'sharedBy' | 'permission' | 'sharedAt' | 'deletedBy' | 'deletedAt';
  label: string;
}

const DEFAULT_COLUMNS: ListColumn[] = [
  { key: 'owner', label: 'เจ้าของ' },
  { key: 'source', label: 'ต้นทาง' },
  { key: 'modified', label: 'แก้ไขล่าสุด' },
  { key: 'size', label: 'ขนาด' },
];

function cellValue(entry: DriveEntry, key: ListColumn['key']): string {
  switch (key) {
    case 'owner':
      return entry.ownerName;
    case 'modified':
      return formatRelativeTime(entry.modifiedAt);
    case 'source':
      return sourceLabel(entry.source);
    case 'size':
      // โฟลเดอร์ไม่มีขนาดรวมที่เชื่อถือได้ จึงแสดงขีดแทนการเดา
      return entry.kind === 'folder' ? '—' : formatBytes(entry.sizeBytes);
    case 'type':
      return entry.kind === 'folder' ? 'โฟลเดอร์' : getFileTypeStyle(entry.name).label;
    case 'sharedBy':
      return entry.sharedBy ?? '-';
    case 'permission':
      return entry.permission ?? '-';
    case 'sharedAt':
      return formatDateTime(entry.sharedAt);
    case 'deletedBy':
      return entry.deletedBy ?? '-';
    case 'deletedAt':
      return formatDateTime(entry.deletedAt);
    default:
      return '-';
  }
}

export function FileList({
  entries,
  columns = DEFAULT_COLUMNS,
  selectedId,
  onSelect,
  onOpen,
  onContextMenu,
  onKeyboardContextMenu,
  selectedIds = new Set<string>(),
  onToggleSelection,
}: {
  entries: DriveEntry[];
  columns?: ListColumn[];
  selectedId?: string | null;
  onSelect: (entry: DriveEntry) => void;
  onOpen: (entry: DriveEntry) => void;
  onContextMenu: (event: React.MouseEvent, entry: DriveEntry) => void;
  onKeyboardContextMenu: (entry: DriveEntry, anchor: HTMLElement) => void;
  selectedIds?: Set<string>;
  onToggleSelection?: (entry: DriveEntry) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-[var(--s2-card-border)] bg-[var(--s2-layer-card)]">
      <table className="w-full min-w-[640px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line text-[11px] uppercase tracking-wide text-navy-400">
            {onToggleSelection ? <th scope="col" className="w-10 px-3 py-2.5"><span className="sr-only">เลือก</span></th> : null}
            <th scope="col" className="px-4 py-2.5 font-medium">
              ชื่อ
            </th>
            {columns.map((column) => (
              <th key={column.key} scope="col" className="px-4 py-2.5 font-medium">
                {column.label}
              </th>
            ))}
            <th scope="col" className="w-10 px-2 py-2.5">
              <span className="sr-only">ตัวเลือก</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={entry.id}
              tabIndex={0}
              onClick={() => onSelect(entry)}
              onDoubleClick={() => onOpen(entry)}
              onContextMenu={(event) => onContextMenu(event, entry)}
              onKeyDown={(event) => {
                if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
                  event.preventDefault();
                  onKeyboardContextMenu(entry, event.currentTarget);
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  onOpen(entry);
                }
              }}
              className={cn(
                'group cursor-default border-b border-line transition-colors last:border-b-0 hover:bg-[var(--s2-surface-soft)]',
                (selectedId === entry.id || selectedIds.has(entry.id)) && 'bg-brand-50',
              )}
            >
              {onToggleSelection ? (
                <td className="px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(entry.id)}
                    onChange={() => onToggleSelection(entry)}
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`เลือก ${entry.name}`}
                    className="h-4 w-4 accent-[var(--s2-primary)]"
                  />
                </td>
              ) : null}
              <td className="px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <FileTypeIcon name={entry.name} kind={entry.kind} size="sm" mimeType={entry.mimeType} resourceId={entry.id} sizeBytes={entry.sizeBytes} showThumbnail />
                  <span className="truncate text-[13px] font-medium text-navy-900">{entry.name}</span>
                  {entry.isLocked ? (
                    <Lock className="h-3.5 w-3.5 shrink-0 text-navy-300" aria-label="ถูกล็อกไว้" />
                  ) : null}
                </div>
              </td>
              {columns.map((column) => (
                <td key={column.key} className="whitespace-nowrap px-4 py-3 text-[12px] text-navy-500">
                  {column.key === 'source' ? (
                    <ResourceSourceBadge source={entry.source} />
                  ) : column.key === 'owner' ? (
                    <OwnerChip owner={{ displayName: entry.ownerName, email: entry.ownerEmail }} />
                  ) : (
                    cellValue(entry, column.key)
                  )}
                </td>
              ))}
              <td className="px-2 py-2.5">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onContextMenu(event, entry);
                  }}
                  className="rounded-md p-1 text-navy-300 opacity-0 hover:bg-navy-50 hover:text-navy-600 focus-visible:opacity-100 group-hover:opacity-100"
                  aria-label={`ตัวเลือกของ ${entry.name}`}
                >
                  <MoreVertical className="h-4 w-4" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
