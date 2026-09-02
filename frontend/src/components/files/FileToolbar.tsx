import { useRef, useState } from 'react';
import {
  ArrowDownAZ,
  ArrowUpAZ,
  CalendarClock,
  Filter,
  Grid2X2,
  Info,
  List,
  Upload,
} from 'lucide-react';
import { NewMenu } from '@/components/layout/NewMenu';
import { MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import { useOutsideClose } from '@/hooks/useOutsideClose';
import { useDriveUi } from '@/hooks/useDriveUi';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/utils';

export type SortKey = 'name-asc' | 'name-desc' | 'modified-desc' | 'size-desc';

const SORT_LABEL: Record<SortKey, string> = {
  'name-asc': 'ชื่อ ก-ฮ',
  'name-desc': 'ชื่อ ฮ-ก',
  'modified-desc': 'แก้ไขล่าสุด',
  'size-desc': 'ขนาดมากไปน้อย',
};

/** แถบเครื่องมือเหนือพื้นที่ไฟล์ */
export function FileToolbar({
  sort,
  onSortChange,
  showNew = false,
  showUpload = false,
  onCreateFolder,
}: {
  sort: SortKey;
  onSortChange: (sort: SortKey) => void;
  /** ค่าเริ่มต้นปิดไว้ เพราะหัวหน้ามีปุ่มหลักอยู่แล้ว */
  showNew?: boolean;
  showUpload?: boolean;
  onCreateFolder?: () => void;
}) {
  const { viewMode, setViewMode, toggleDetails, detailsOpen } = useDriveUi();
  const { notify } = useToast();

  const [sortOpen, setSortOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  useOutsideClose(sortRef, sortOpen, () => setSortOpen(false));
  useOutsideClose(filterRef, filterOpen, () => setFilterOpen(false));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {showNew ? <NewMenu variant="outline" onCreateFolder={onCreateFolder} /> : null}

      {showUpload ? (
        <button
          type="button"
          aria-label="อัปโหลด"
          className="s2-btn s2-btn-outline"
          onClick={() =>
            notify({
              tone: 'info',
              title: 'การอัปโหลดยังไม่เปิดใช้งาน',
              description: 'ระบบไฟล์บนเซิร์ฟเวอร์จะเปิดใช้งานใน Phase 3',
            })
          }
        >
          <Upload className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">อัปโหลด</span>
        </button>
      ) : null}

      <div className="flex items-center gap-1.5">
        <div className="relative" ref={sortRef}>
          <button
            type="button"
            onClick={() => setSortOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={sortOpen}
            aria-label={`เรียงลำดับ: ${SORT_LABEL[sort]}`}
            className="s2-btn s2-btn-ghost"
          >
            <ArrowDownAZ className="h-4 w-4" aria-hidden />
            <span className="hidden md:inline">{SORT_LABEL[sort]}</span>
          </button>
          {sortOpen ? (
            <div role="menu" className="s2-menu absolute right-0 z-[var(--z-menu)] mt-2.5 w-52">
              <MenuLabel>เรียงลำดับ</MenuLabel>
              <MenuItem
                icon={<ArrowDownAZ className="h-4 w-4" />}
                label={SORT_LABEL['name-asc']}
                onSelect={() => {
                  onSortChange('name-asc');
                  setSortOpen(false);
                }}
              />
              <MenuItem
                icon={<ArrowUpAZ className="h-4 w-4" />}
                label={SORT_LABEL['name-desc']}
                onSelect={() => {
                  onSortChange('name-desc');
                  setSortOpen(false);
                }}
              />
              <MenuItem
                icon={<CalendarClock className="h-4 w-4" />}
                label={SORT_LABEL['modified-desc']}
                onSelect={() => {
                  onSortChange('modified-desc');
                  setSortOpen(false);
                }}
              />
              <MenuItem
                icon={<Filter className="h-4 w-4" />}
                label={SORT_LABEL['size-desc']}
                onSelect={() => {
                  onSortChange('size-desc');
                  setSortOpen(false);
                }}
              />
            </div>
          ) : null}
        </div>

        <div className="relative" ref={filterRef}>
          <button
            type="button"
            onClick={() => setFilterOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={filterOpen}
            aria-label="ตัวกรอง"
            className="s2-btn s2-btn-ghost"
          >
            <Filter className="h-4 w-4" aria-hidden />
            <span className="hidden md:inline">ตัวกรอง</span>
          </button>
          {filterOpen ? (
            <div role="menu" className="s2-menu absolute right-0 z-[var(--z-menu)] mt-2.5 w-56">
              <MenuLabel>ประเภท</MenuLabel>
              <MenuItem label="โฟลเดอร์" disabled />
              <MenuItem label="เอกสาร" disabled />
              <MenuItem label="รูปภาพ" disabled />
              <MenuSeparator />
              <MenuLabel>แก้ไขเมื่อ</MenuLabel>
              <MenuItem label="7 วันล่าสุด" disabled />
              <MenuItem label="30 วันล่าสุด" disabled />
              <p className="px-2.5 pb-2 pt-1 text-[11px] leading-relaxed text-navy-300">
                ตัวกรองจะใช้งานได้เมื่อมีไฟล์ในระบบ
              </p>
            </div>
          ) : null}
        </div>

        <div className="flex items-center rounded-[10px] border border-line bg-surface p-0.5">
          <button
            type="button"
            onClick={() => setViewMode('grid')}
            aria-pressed={viewMode === 'grid'}
            aria-label="มุมมองตาราง"
            className={cn(
              'rounded-lg p-1.5 transition-colors',
              viewMode === 'grid' ? 'bg-navy-50 text-navy-800' : 'text-navy-400 hover:text-navy-700',
            )}
          >
            <Grid2X2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setViewMode('list')}
            aria-pressed={viewMode === 'list'}
            aria-label="มุมมองรายการ"
            className={cn(
              'rounded-lg p-1.5 transition-colors',
              viewMode === 'list' ? 'bg-navy-50 text-navy-800' : 'text-navy-400 hover:text-navy-700',
            )}
          >
            <List className="h-4 w-4" />
          </button>
        </div>

        <button
          type="button"
          onClick={toggleDetails}
          aria-pressed={detailsOpen}
          aria-label="รายละเอียด"
          className={cn(
            'rounded-[10px] border border-line p-2 transition-colors',
            detailsOpen ? 'bg-navy-50 text-navy-800' : 'bg-surface text-navy-400 hover:text-navy-700',
          )}
        >
          <Info className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
