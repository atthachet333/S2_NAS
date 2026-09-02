import { useRef, useState } from 'react';
import { FileText, FolderPlus, FolderUp, Globe2, Link2, Plus, Sheet, Upload } from 'lucide-react';
import { MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { useOutsideClose } from '@/hooks/useOutsideClose';
import { cn } from '@/lib/utils';

/** ปุ่ม + ใหม่ สำหรับสร้างโฟลเดอร์และอัปโหลด */
export function NewMenu({ variant = 'solid', onCreateFolder }: { variant?: 'solid' | 'outline'; onCreateFolder?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, open, () => setOpen(false));

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="ใหม่"
        className={cn('s2-btn', variant === 'solid' ? 's2-btn-primary' : 's2-btn-outline')}
      >
        <Plus className="h-4 w-4" aria-hidden />
        <span className="hidden sm:inline">ใหม่</span>
      </button>

      {open ? (
        <div role="menu" className="s2-menu absolute left-0 z-[var(--z-menu)] mt-7 w-56 sm:left-auto sm:right-0">
          <MenuItem
            icon={<FolderPlus className="h-4 w-4" />}
            label="สร้างโฟลเดอร์"
            onSelect={() => { setOpen(false); onCreateFolder ? onCreateFolder() : window.dispatchEvent(new Event('s2-create-folder')); }}
          />
          <MenuSeparator />
          <MenuItem
            icon={<Upload className="h-4 w-4" />}
            label="อัปโหลดไฟล์"
            onSelect={() => { setOpen(false); window.dispatchEvent(new Event('s2-upload-file')); }}
          />
          <MenuItem
            icon={<FolderUp className="h-4 w-4" />}
            label="อัปโหลดโฟลเดอร์"
            shortcut="เร็ว ๆ นี้"
            disabled
          />
          <MenuSeparator />
          <MenuItem icon={<Sheet className="h-4 w-4" />} label="เพิ่ม Google Sheet" shortcut="เร็ว ๆ นี้" disabled />
          <MenuItem icon={<FileText className="h-4 w-4" />} label="เพิ่ม Google Doc" shortcut="เร็ว ๆ นี้" disabled />
          <MenuItem icon={<Globe2 className="h-4 w-4" />} label="เพิ่ม Google Drive" shortcut="เร็ว ๆ นี้" disabled />
          <MenuItem icon={<Link2 className="h-4 w-4" />} label="เพิ่มลิงก์" shortcut="เร็ว ๆ นี้" disabled />
        </div>
      ) : null}
    </div>
  );
}
