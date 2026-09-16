import { ChevronRight, Lock, MoreVertical, Pin, Star } from 'lucide-react';
import type { DriveEntry } from '@/lib/drive';
import { FileTypeIcon } from './FileTypeIcon';
import { cn } from '@/lib/utils';
import { isExternalEntry } from '@/lib/external-resources';
import { mobileMetaLine } from '@/lib/mobile-entry';

/**
 * รายการไฟล์สำหรับจอโทรศัพท์ (F24-C)
 *
 * **ทำไมไม่ใช่ตารางเดิม:** ตารางของเดสก์ท็อปกว้างอย่างน้อย 1040px เพราะมีเจ็ดคอลัมน์
 * บนจอ 375px ผู้ใช้จึงต้องเลื่อนแนวนอนเพื่อดูวันที่ของไฟล์ แล้วเลื่อนกลับมาดูว่ามันคือไฟล์ไหน
 * การเลื่อนแนวนอนยังชนกับการปัดเพื่อย้อนกลับของเบราว์เซอร์บนมือถืออีกด้วย
 *
 * **สิ่งที่เลือกแสดง:** ชื่อไฟล์คือสิ่งเดียวที่ผู้ใช้ใช้ระบุตัวไฟล์จริง ๆ จึงได้พื้นที่มากที่สุด
 * ข้อมูลประกอบถูกยุบเหลือบรรทัดเดียว เพราะบนจอแคบ การมีสามบรรทัดต่อรายการ
 * แปลว่าเห็นไฟล์ได้ทีละสี่รายการ ซึ่งทำให้การกวาดสายตาหาไฟล์ใช้ไม่ได้
 *
 * **ปุ่มตัวเลือกแสดงตลอดเวลา** ไม่ใช่ปรากฏตอนชี้เมาส์ เพราะนิ้วไม่มีสถานะ "ชี้"
 */
export function FileCards({
  entries,
  selectedId,
  onSelect,
  onOpen,
  onContextMenu,
  selectedIds = new Set<string>(),
  onToggleSelection,
  selectionMode = false,
}: {
  entries: DriveEntry[];
  selectedId?: string | null;
  onSelect: (entry: DriveEntry) => void;
  onOpen: (entry: DriveEntry) => void;
  onContextMenu: (event: React.MouseEvent, entry: DriveEntry) => void;
  selectedIds?: Set<string>;
  onToggleSelection?: (entry: DriveEntry) => void;
  /** โหมดเลือกหลายรายการ - ต้องเปิดอย่างชัดแจ้ง ไม่ใช่เดาจากการกดค้าง */
  selectionMode?: boolean;
}) {
  return (
    <ul className="flex flex-col gap-1.5">
      {entries.map((entry) => {
        const isFolder = entry.kind === 'folder';
        const checked = selectedIds.has(entry.id);
        return (
          <li
            key={entry.id}
            className={cn(
              'flex items-center gap-2 rounded-xl border border-[var(--s2-card-border)] bg-[var(--s2-layer-card)] px-2 py-2 transition-colors',
              (selectedId === entry.id || checked) && 'border-[var(--s2-primary-border)] bg-brand-50',
            )}
          >
            {selectionMode && onToggleSelection ? (
              <label className="flex h-11 w-11 shrink-0 items-center justify-center">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleSelection(entry)}
                  aria-label={`เลือก ${entry.name}`}
                  className="h-5 w-5 accent-[var(--s2-primary)]"
                />
              </label>
            ) : null}

            {/* ตัวรายการทั้งแถวเป็นปุ่มเดียว - เป้าหมายแตะใหญ่ที่สุดเท่าที่พื้นที่มี */}
            <button
              type="button"
              onClick={() => (selectionMode && onToggleSelection ? onToggleSelection(entry) : onOpen(entry))}
              onFocus={() => onSelect(entry)}
              className="flex min-h-[52px] min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1 py-1 text-left"
            >
              <FileTypeIcon
                name={entry.name}
                kind={entry.kind}
                resourceType={entry.resourceType}
                size="sm"
                mimeType={entry.mimeType}
                resourceId={entry.id}
                sizeBytes={entry.sizeBytes}
                showThumbnail
              />
              <span className="min-w-0 flex-1">
                {/*
                  ชื่อไฟล์ตัดที่สองบรรทัด

                  ชื่อภาษาไทยยาว ๆ ที่ไม่มีช่องว่างจะตัดคำไม่ได้ถ้าบังคับบรรทัดเดียว
                  สองบรรทัดจึงพอให้เห็นส่วนที่แยกไฟล์ออกจากกัน โดยยังไม่ดันรายการถัดไปลงไปไกล
                */}
                <span className="line-clamp-2 break-words text-[13.5px] font-medium leading-snug text-navy-900">
                  {entry.name}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-navy-500">
                  <span className="truncate">{mobileMetaLine(entry)}</span>
                </span>
              </span>

              <span className="flex shrink-0 items-center gap-1">
                {entry.favorite ? <Star role="img" className="h-3.5 w-3.5 fill-amber-400 text-amber-500" aria-label="รายการโปรด" /> : null}
                {entry.pinned ? <Pin role="img" className="h-3.5 w-3.5 text-brand-600" aria-label="ปักหมุดไว้" /> : null}
                {entry.isLocked ? <Lock role="img" className="h-3.5 w-3.5 text-navy-300" aria-label="ถูกล็อกไว้" /> : null}
                {isFolder && !isExternalEntry(entry) ? (
                  <ChevronRight className="h-4 w-4 text-navy-300" aria-hidden />
                ) : null}
              </span>
            </button>

            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onContextMenu(event, entry);
              }}
              aria-label={`ตัวเลือกของ ${entry.name}`}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-navy-400 transition-colors hover:bg-navy-50 hover:text-navy-700"
            >
              <MoreVertical className="h-[18px] w-[18px]" aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
