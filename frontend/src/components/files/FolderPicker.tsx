import { useQuery } from '@tanstack/react-query';
import { ChevronRight, CornerLeftUp, Folder, FolderOpen, HardDrive, Server } from 'lucide-react';
import { resourceApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DRIVE_ROOT_LABEL, driveDestination, type DriveRoot } from '@/lib/drive-labels';
import { DRIVE_ROOTS, isSameLocation } from '@/lib/folder-picker';

const DRIVE_ICON = { MY_DRIVE: HardDrive, SYSTEM_DRIVE: Server } as const;

/**
 * ตัวเลือกโฟลเดอร์ปลายทาง V3 (รองรับสองไดร์ฟ)
 *
 * บอกให้ชัดว่าตอนนี้อยู่ที่ไหน กำลังจะย้ายไปที่ไหน และเดินเข้าออกโฟลเดอร์ได้
 * รากของ "ไดร์ฟของฉัน" และ "ไดร์ฟของระบบ" ถูกแยกจากกันเสมอ ไม่รวมเป็นรายการเดียวที่กำกวม
 *
 * ตัวเลือกนี้เป็นแค่การนำทาง ปลายทางที่ client รู้แน่ว่าไม่ถูกต้องจะถูกปิดไว้
 * แต่เซิร์ฟเวอร์ยังเป็นผู้ตัดสินสุดท้ายเสมอ เช่น ย้ายเข้าไปในลูกหลานของตัวเอง
 * หรือย้ายข้ามไดร์ฟโดยไม่มีสิทธิ์ (CROSS_DRIVE_MOVE_DENIED)
 */
export function FolderPicker({
  value,
  onChange,
  driveRoot,
  onDriveRootChange,
  selectableDriveRoots,
  excludeId,
  currentParentId,
  currentDriveRoot = 'MY_DRIVE',
  currentLocationSegments = [],
  disabledDriveReason = 'การย้ายข้ามไดร์ฟสงวนไว้สำหรับผู้ดูแลระบบ',
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  /** ไดร์ฟที่กำลังเปิดดูอยู่ในตัวเลือกนี้ */
  driveRoot: DriveRoot;
  onDriveRootChange: (root: DriveRoot) => void;
  /** ไดร์ฟที่เลือกเป็นปลายทางได้จริงตามสิทธิ์ - ไดร์ฟอื่นแสดงแบบปิดไว้ ไม่ซ่อนเงียบ ๆ */
  selectableDriveRoots: DriveRoot[];
  excludeId?: string;
  currentParentId?: string | null;
  currentDriveRoot?: DriveRoot;
  /** เส้นทางเชิงตรรกะของตำแหน่งปัจจุบัน ใต้ระดับไดร์ฟ */
  currentLocationSegments?: string[];
  /** เหตุผลที่ไดร์ฟบางตัวเลือกไม่ได้ - ต่างกันตามบริบทที่เรียกใช้ จึงไม่ hardcode ไว้ในตัวเลือก */
  disabledDriveReason?: string;
}) {
  const { data, isPending } = useQuery({
    queryKey: ['folder-picker', driveRoot, value ?? 'root'],
    queryFn: () =>
      resourceApi.list(
        new URLSearchParams({
          ...(value ? { parentId: value } : { driveScope: driveRoot }),
          type: 'FOLDER',
          sort: 'name',
          direction: 'asc',
          limit: '50',
        }),
      ),
  });

  const { data: crumbs } = useQuery({
    queryKey: ['folder-picker-crumbs', value],
    queryFn: () => resourceApi.breadcrumb(value!),
    enabled: Boolean(value),
  });

  const parentId = crumbs?.data.length && crumbs.data.length > 1 ? crumbs.data.at(-2)!.id : null;
  const folders = (data?.data.items ?? []).filter((item) => item.id !== excludeId);
  const segments = (crumbs?.data ?? []).map((node) => node.name);
  const destinationName =
    value && segments.length === 0 ? 'กำลังโหลด…' : driveDestination(driveRoot, segments);
  const unchanged = isSameLocation(
    { driveRoot: currentDriveRoot, parentId: currentParentId ?? null },
    { driveRoot, parentId: value ?? null },
  );

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-[var(--s2-surface-soft)]">
      {/* ---------- ตำแหน่งปัจจุบัน: บอกจุดตั้งต้นก่อนเสมอ ---------- */}
      <div className="border-b border-line px-3 py-2">
        <p className="s2-section-title">ตำแหน่งปัจจุบัน</p>
        <p className="truncate text-[12px] text-navy-600">
          {driveDestination(currentDriveRoot, currentLocationSegments)}
        </p>
      </div>

      {/* ---------- เลือกไดร์ฟ: สองรากแยกกันชัดเจน ไม่รวมเป็นรายการเดียว ---------- */}
      <div
        className="flex items-center gap-1 overflow-x-auto border-b border-line px-2 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="เลือกไดร์ฟปลายทาง"
      >
        {DRIVE_ROOTS.map((root) => {
          const Icon = DRIVE_ICON[root];
          const allowed = selectableDriveRoots.includes(root);
          const active = driveRoot === root;
          return (
            <button
              key={root}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={!allowed}
              title={allowed ? undefined : disabledDriveReason}
              onClick={() => {
                if (!allowed || active) return;
                // เปลี่ยนไดร์ฟแล้วต้องเริ่มที่รากของไดร์ฟนั้น ไม่ค้างอยู่ที่โฟลเดอร์ของไดร์ฟเดิม
                onDriveRootChange(root);
                onChange(null);
              }}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11.5px] transition-colors',
                active
                  ? 'bg-brand-50 font-semibold text-brand-700'
                  : 'text-navy-500 hover:bg-[var(--s2-surface)] hover:text-navy-800',
                !allowed && 'cursor-not-allowed opacity-45 hover:bg-transparent hover:text-navy-500',
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {DRIVE_ROOT_LABEL[root]}
            </button>
          );
        })}
      </div>

      {/* ---------- เส้นทางภายในไดร์ฟที่เลือก ---------- */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-line px-2 py-2 text-[11px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          type="button"
          onClick={() => onChange(null)}
          className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-navy-500 transition-colors hover:bg-[var(--s2-surface)] hover:text-navy-800"
        >
          {DRIVE_ROOT_LABEL[driveRoot]}
        </button>
        {(crumbs?.data ?? []).map((node) => (
          <span key={node.id} className="flex shrink-0 items-center gap-1">
            <ChevronRight className="h-3 w-3 text-navy-300" aria-hidden />
            <button
              type="button"
              onClick={() => onChange(node.id)}
              className="whitespace-nowrap rounded-lg px-1.5 py-1 text-navy-600 transition-colors hover:bg-[var(--s2-surface)]"
            >
              {node.name}
            </button>
          </span>
        ))}
      </div>

      <div className="max-h-56 space-y-0.5 overflow-y-auto p-1.5">
        {value ? (
          <button type="button" onClick={() => onChange(parentId)} className="s2-menu-item">
            <CornerLeftUp className="h-4 w-4 text-navy-400" aria-hidden />
            ย้อนขึ้นหนึ่งระดับ
          </button>
        ) : null}

        {isPending ? (
          <p className="px-2 py-6 text-center text-[11px] text-navy-400">กำลังโหลดโฟลเดอร์…</p>
        ) : null}

        {folders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            onClick={() => onChange(folder.id)}
            className="s2-menu-item"
          >
            <Folder className="h-4 w-4 text-brand-500" aria-hidden />
            <span className="truncate">{folder.name}</span>
            <ChevronRight className="ml-auto h-3.5 w-3.5 text-navy-300" aria-hidden />
          </button>
        ))}

        {!isPending && folders.length === 0 ? (
          <p className="px-2 py-6 text-center text-[11px] text-navy-400">ไม่มีโฟลเดอร์ย่อยที่นี่</p>
        ) : null}
      </div>

      <div
        className={cn(
          'flex items-center gap-2 border-t border-line px-3 py-2.5',
          unchanged ? 'bg-[var(--s2-surface-soft)]' : 'bg-brand-50',
        )}
      >
        <FolderOpen
          className={cn('h-4 w-4 shrink-0', unchanged ? 'text-navy-300' : 'text-brand-600')}
          aria-hidden
        />
        <div className="min-w-0">
          <p className="s2-section-title">ปลายทาง</p>
          <p className={cn('truncate text-[12px] font-semibold', unchanged ? 'text-navy-500' : 'text-brand-700')}>
            {destinationName}
            {unchanged ? ' (ตำแหน่งเดิม)' : ''}
          </p>
        </div>
      </div>
    </div>
  );
}
