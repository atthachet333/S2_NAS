import { useRef, useState, type ReactNode } from 'react';
import { UploadCloud } from 'lucide-react';
import { FileGrid } from './FileGrid';
import { FileList, type ListColumn } from './FileList';
import { ContextMenu, useContextMenu } from './ContextMenu';
import { GridSkeleton, ListSkeleton, ErrorState } from '@/components/ui/States';
import { useDriveUi } from '@/hooks/useDriveUi';
import { useToast } from '@/hooks/useToast';
import { useUploadQueue } from '@/hooks/useUploadQueue';
import type { DriveEntry } from '@/lib/drive';
import { cn } from '@/lib/utils';
import { isExternalEntry, openExternalUrl } from '@/lib/external-resources';

/**
 * พื้นที่ทำงานกับไฟล์
 * รวมมุมมอง grid/list, คลิกขวา, ลากไฟล์มาวาง และสถานะ loading/empty/error
 */
export function DriveWorkspace({
  entries,
  isLoading = false,
  isError = false,
  onRetry,
  emptyState,
  columns,
  allowUpload = true,
  allowContextMenu = true,
  onResourceAction,
  uploadTarget,
  selectedIds = new Set<string>(),
  onToggleSelection,
}: {
  entries: DriveEntry[];
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  emptyState: ReactNode;
  columns?: ListColumn[];
  allowUpload?: boolean;
  allowContextMenu?: boolean;
  onResourceAction?: (action: string, entry: DriveEntry | null) => void;
  /** ปลายทางของการลากไฟล์มาวาง ต้องระบุชื่อให้ผู้ใช้เห็นเสมอ */
  uploadTarget?: { parentId: string | null; parentName: string };
  selectedIds?: Set<string>;
  onToggleSelection?: (entry: DriveEntry) => void;
}) {
  const { viewMode, selected, select, openDetails } = useDriveUi();
  const { notify } = useToast();
  const { enqueue } = useUploadQueue();
  const { state, openAt, openForEntry, close } = useContextMenu();

  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  /** ส่งไฟล์ที่ผู้ใช้ลากมาเข้าคิวอัปโหลดจริง */
  const acceptFiles = (files: FileList | null) => {
    if (!uploadTarget) {
      notify({ tone: 'info', title: 'ตำแหน่งนี้ยังไม่รองรับการอัปโหลด' });
      return;
    }
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    enqueue(list, uploadTarget);
  };

  const onAction = (action: string, entry: DriveEntry | null) => {
    if (entry && ((action === 'open' && isExternalEntry(entry)) || action === 'open-external')) {
      if (!entry.externalUrl || !openExternalUrl(entry.externalUrl)) notify({ tone: 'error', title: 'ลิงก์ไม่ถูกต้อง' });
      return;
    }
    if (action === 'copy-external-link' && entry?.externalUrl) {
      void navigator.clipboard.writeText(entry.externalUrl)
        .then(() => notify({ tone: 'success', title: 'คัดลอกลิงก์แล้ว' }))
        .catch(() => notify({ tone: 'error', title: 'คัดลอกลิงก์ไม่สำเร็จ' }));
      return;
    }
    if (action === 'details') {
      if (entry) select(entry);
      openDetails();
      return;
    }
    if (
      onResourceAction &&
      ['open', 'create-folder', 'create-folder-inside', 'create-google-sheet', 'create-google-doc', 'create-google-drive', 'create-web-link', 'rename', 'move', 'owner', 'trash', 'preview', 'download', 'download-zip', 'new-version', 'edit-external'].includes(action)
    ) {
      onResourceAction(action, entry);
      return;
    }
    if (action === 'upload-here') {
      onResourceAction?.('upload-here', entry);
      return;
    }
    notify({
      tone: 'info',
      title: 'ฟีเจอร์นี้ยังไม่เปิดใช้งาน',
      description: 'การจัดการไฟล์และโฟลเดอร์จะเปิดใช้งานใน Phase 3',
    });
  };

  const dropHandlers = allowUpload
    ? {
        onDragEnter: (event: React.DragEvent) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          dragDepth.current += 1;
          setDragging(true);
        },
        onDragOver: (event: React.DragEvent) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        },
        onDragLeave: () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        },
        onDrop: (event: React.DragEvent) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          acceptFiles(event.dataTransfer.files);
        },
      }
    : {};

  return (
    <section
      aria-label="พื้นที่จัดการไฟล์"
      className={cn(
        'relative rounded-panel transition-colors',
        dragging && 'outline outline-2 outline-dashed outline-brand-400 outline-offset-4',
      )}
      onContextMenu={allowContextMenu ? (event) => openAt(event, null) : undefined}
      {...dropHandlers}
    >
      {isError ? (
        <ErrorState message="ไม่สามารถโหลดรายการไฟล์ได้" onRetry={onRetry} />
      ) : isLoading ? (
        viewMode === 'grid' ? (
          <GridSkeleton />
        ) : (
          <ListSkeleton />
        )
      ) : entries.length === 0 ? (
        emptyState
      ) : viewMode === 'grid' ? (
        <FileGrid
          entries={entries}
          selectedId={selected?.id ?? null}
          onSelect={select}
          onOpen={(entry) => onAction('open', entry)}
          onContextMenu={allowContextMenu ? openAt : () => undefined}
          onKeyboardContextMenu={openForEntry}
          selectedIds={selectedIds}
          onToggleSelection={onToggleSelection}
        />
      ) : (
        <FileList
          entries={entries}
          columns={columns}
          selectedId={selected?.id ?? null}
          onSelect={select}
          onOpen={(entry) => onAction('open', entry)}
          onContextMenu={allowContextMenu ? openAt : () => undefined}
          onKeyboardContextMenu={openForEntry}
          selectedIds={selectedIds}
          onToggleSelection={onToggleSelection}
        />
      )}

      {dragging ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-panel bg-brand-50/90">
          <UploadCloud className="h-8 w-8 text-brand-600" aria-hidden />
          <p className="text-[13px] text-brand-700">วางไฟล์เพื่ออัปโหลดไปยัง</p>
          <p className="max-w-[80%] truncate text-[15px] font-semibold text-brand-700">
            “{uploadTarget?.parentName ?? 'ไดร์ฟของฉัน'}”
          </p>
        </div>
      ) : null}

      {allowContextMenu ? <ContextMenu state={state} destinationName={uploadTarget?.parentName ?? 'ไดร์ฟของฉัน'} onClose={close} onAction={onAction} /> : null}
    </section>
  );
}
