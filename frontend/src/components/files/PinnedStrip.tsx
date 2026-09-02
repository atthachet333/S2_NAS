import { Pin, PinOff } from 'lucide-react';
import type { ResourceDto } from '@/lib/api';
import { applyMarks, toDriveEntry, type DriveEntry } from '@/lib/drive';
import { FileTypeIcon } from './FileTypeIcon';

/**
 * ทางลัดไปยังรายการที่ปักหมุดไว้
 *
 * ต่างจากรายการโปรดตรงที่หมุดมีไว้สำหรับ "สิ่งที่กำลังทำอยู่ตอนนี้" จึงแสดงเป็นแถบเดียว
 * ที่หน้ารากเท่านั้น และไม่ยาวจนเบียดเนื้อหาหลักของโฟลเดอร์
 */
export function PinnedStrip({
  resources,
  favoriteIds,
  pinnedIds,
  onOpen,
  onAction,
}: {
  resources: ResourceDto[];
  favoriteIds: Set<string>;
  pinnedIds: Set<string>;
  onOpen: (entry: DriveEntry) => void;
  onAction: (action: string, entry: DriveEntry) => void;
}) {
  if (resources.length === 0) return null;
  const entries = applyMarks(resources.map(toDriveEntry), favoriteIds, pinnedIds);

  return (
    <section aria-label="รายการที่ปักหมุด">
      <div className="flex items-center gap-1.5">
        <Pin className="h-3.5 w-3.5 text-navy-400" aria-hidden />
        <h2 className="text-[13px] font-semibold text-navy-800">ปักหมุดไว้</h2>
        <span className="text-[11.5px] text-navy-400">{entries.length} รายการ</span>
      </div>

      <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {entries.map((entry) => (
          <li key={entry.id} className="group relative">
            <button
              type="button"
              onClick={() => onOpen(entry)}
              onContextMenu={(event) => {
                event.preventDefault();
                onAction('details', entry);
              }}
              className="s2-surface flex w-full items-center gap-2.5 p-3 text-left transition-colors hover:border-brand-300"
            >
              <FileTypeIcon name={entry.name} kind={entry.kind} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-navy-800">{entry.name}</span>
                <span className="block truncate text-[10.5px] text-navy-400">{entry.ownerName}</span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => onAction('unpin', entry)}
              aria-label={`ยกเลิกปักหมุด ${entry.name}`}
              className="absolute right-1.5 top-1.5 rounded-lg p-1.5 text-navy-300 opacity-0 transition-opacity hover:bg-navy-50 hover:text-navy-600 focus-visible:opacity-100 group-hover:opacity-100"
            >
              <PinOff className="h-3.5 w-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
