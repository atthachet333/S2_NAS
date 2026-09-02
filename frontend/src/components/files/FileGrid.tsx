import { Lock, MoreVertical } from 'lucide-react';
import type { DriveEntry } from '@/lib/drive';
import { FileTypeIcon } from './FileTypeIcon';
import { OwnerAvatar, ownerLabel } from './OwnerIdentity';
import { ResourceSourceBadge } from './ResourceSourceBadge';
import { getFileTypeStyle } from '@/lib/file-types';
import { cn, formatBytes, formatRelativeTime } from '@/lib/utils';
import { externalResourceLabel, isExternalEntry } from '@/lib/external-resources';

/**
 * การ์ดทรัพยากร V3
 *
 * ลำดับการอ่าน: ไอคอน → ชื่อ → ผู้ดูแล → เวลาแก้ไข
 * ผู้ดูแลอยู่ในระดับเดียวกับชื่อเสมอ เพราะเป็นข้อมูลที่ S2 NAS ต้องการให้เห็นก่อนเพื่อน
 */
export function FileGrid({
  entries,
  selectedId,
  onSelect,
  onOpen,
  onContextMenu,
  onKeyboardContextMenu,
  selectedIds = new Set<string>(),
  onToggleSelection,
}: {
  entries: DriveEntry[];
  selectedId?: string | null;
  onSelect: (entry: DriveEntry) => void;
  onOpen: (entry: DriveEntry) => void;
  onContextMenu: (event: React.MouseEvent, entry: DriveEntry) => void;
  onKeyboardContextMenu: (entry: DriveEntry, anchor: HTMLElement) => void;
  selectedIds?: Set<string>;
  onToggleSelection?: (entry: DriveEntry) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {entries.map((entry) => {
        const isFolder = entry.kind === 'folder';
        const isExternal = isExternalEntry(entry);
        const selected = selectedId === entry.id || selectedIds.has(entry.id);

        return (
          <article
            key={entry.id}
            tabIndex={0}
            role="button"
            aria-label={`${isFolder ? 'โฟลเดอร์' : isExternal ? 'ลิงก์ภายนอก' : 'ไฟล์'} ${entry.name} ผู้ดูแล ${entry.ownerName}`}
            data-selected={selected}
            onClick={() => onSelect(entry)}
            onDoubleClick={() => onOpen(entry)}
            onKeyDown={(event) => {
              if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
                event.preventDefault();
                onKeyboardContextMenu(entry, event.currentTarget);
                return;
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                onOpen(entry);
                return;
              }
              // เลื่อนโฟกัสระหว่างการ์ดด้วยลูกศร ไม่ผูกปุ่มลบไว้กับคีย์บอร์ดเพื่อความปลอดภัย
              const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
              if (step === 0) return;
              event.preventDefault();
              const cards = Array.from(
                event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="button"]') ?? [],
              );
              const next = cards[cards.indexOf(event.currentTarget) + step];
              next?.focus();
            }}
            onContextMenu={(event) => onContextMenu(event, entry)}
            className={cn('s2-resource-card group cursor-default p-4', isFolder && 's2-folder-accent')}
          >
            <div className="flex items-start justify-between gap-2">
              <FileTypeIcon name={entry.name} kind={entry.kind} resourceType={entry.resourceType} size="lg" mimeType={entry.mimeType} resourceId={entry.id} sizeBytes={entry.sizeBytes} showThumbnail />

              <div className="flex items-center gap-1">
                {onToggleSelection ? (
                  <input
                    type="checkbox"
                    checked={selectedIds.has(entry.id)}
                    onChange={() => onToggleSelection(entry)}
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`เลือก ${entry.name}`}
                    className="h-4 w-4 accent-[var(--s2-primary)]"
                  />
                ) : null}
                {entry.isLocked ? (
                  <span title="ถูกล็อกไว้" className="text-navy-300">
                    <Lock className="h-3.5 w-3.5" aria-hidden />
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onContextMenu(event, entry);
                  }}
                  className="rounded-md p-1 text-navy-300 opacity-0 transition-opacity hover:bg-navy-50 hover:text-navy-700 focus-visible:opacity-100 group-hover:opacity-100"
                  aria-label={`ตัวเลือกของ ${entry.name}`}
                >
                  <MoreVertical className="h-4 w-4" />
                </button>
              </div>
            </div>

            <p className="mt-3.5 truncate text-[14px] font-semibold tracking-[-0.01em] text-navy-900" title={entry.name}>
              {entry.name}
            </p>

            <p className="mt-0.5 truncate text-[11px] text-navy-400">
              {isExternal ? `${externalResourceLabel(entry.resourceType)} · ลิงก์ภายนอก` : isFolder
                ? entry.itemCount === undefined
                  ? 'โฟลเดอร์'
                  : `${entry.itemCount} รายการ`
                : `${getFileTypeStyle(entry.name).label} · ${formatBytes(entry.sizeBytes)}`}
            </p>

            <div className="mt-3 flex items-end justify-between gap-2 border-t border-line pt-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <OwnerAvatar owner={{ displayName: entry.ownerName, email: entry.ownerEmail }} size="sm" />
                <span className="min-w-0 leading-tight">
                  <span className="block truncate text-[11.5px] font-semibold text-navy-800">
                    {ownerLabel({ displayName: entry.ownerName, email: entry.ownerEmail })}
                  </span>
                  <span className="block text-[9.5px] text-navy-400">ผู้ดูแลหลัก</span>
                </span>
              </div>
              <ResourceSourceBadge source={entry.source} hideManual />
              {isExternal ? <span className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[9px] text-navy-500">{externalResourceLabel(entry.resourceType)}</span> : null}
            </div>

            <p className="mt-2 truncate text-[10.5px] text-navy-400">
              แก้ไข {formatRelativeTime(entry.modifiedAt)}
            </p>
          </article>
        );
      })}
    </div>
  );
}
