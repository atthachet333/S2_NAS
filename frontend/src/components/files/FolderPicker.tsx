import { useQuery } from '@tanstack/react-query';
import { ChevronRight, CornerLeftUp, Folder, FolderOpen, Home } from 'lucide-react';
import { resourceApi } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * ตัวเลือกโฟลเดอร์ปลายทาง V3
 *
 * บอกให้ชัดว่าตอนนี้อยู่ที่ไหน กำลังจะย้ายไปที่ไหน และเดินเข้าออกโฟลเดอร์ได้
 * ปลายทางที่ client รู้แน่ว่าไม่ถูกต้อง (ตัวมันเองและตำแหน่งเดิม) จะถูกปิดไว้
 * แต่เซิร์ฟเวอร์ยังเป็นผู้ตัดสินสุดท้ายเสมอ เช่นกรณีย้ายเข้าไปในลูกหลานของตัวเอง
 */
export function FolderPicker({
  value,
  onChange,
  excludeId,
  currentParentId,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  excludeId?: string;
  currentParentId?: string | null;
}) {
  const { data, isPending } = useQuery({
    queryKey: ['folder-picker', value ?? 'root'],
    queryFn: () =>
      resourceApi.list(
        new URLSearchParams({
          ...(value ? { parentId: value } : {}),
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
  const destinationName = value ? (crumbs?.data.at(-1)?.name ?? 'กำลังโหลด…') : 'รากองค์กร';
  const unchanged = (value ?? null) === (currentParentId ?? null);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-[var(--s2-surface-soft)]">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-line px-2 py-2 text-[11px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          type="button"
          onClick={() => onChange(null)}
          className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-navy-500 transition-colors hover:bg-[var(--s2-surface)] hover:text-navy-800"
        >
          <Home className="h-3.5 w-3.5" aria-hidden />
          รากองค์กร
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
        <FolderOpen className={cn('h-4 w-4 shrink-0', unchanged ? 'text-navy-300' : 'text-brand-600')} aria-hidden />
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
