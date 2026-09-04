import { useRef, useState } from 'react';
import { FileText, FolderPlus, FolderUp, Globe2, Link2, Plus, Sheet, Upload } from 'lucide-react';
import { MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { useOutsideClose } from '@/hooks/useOutsideClose';
import { cn } from '@/lib/utils';
import type { ExternalResourceType } from '@/lib/external-resources';

/**
 * ปุ่ม + ใหม่ - ทางเข้าเดียวของการสร้างทรัพยากรทุกชนิด
 *
 * ใช้ร่วมกันทั้งไดร์ฟของฉันและไดร์ฟของระบบ ปลายทางถูกตัดสินโดยหน้าที่เรียกใช้
 * ไม่ใช่โดยเมนูนี้ เมนูจึงไม่ต้องรู้ว่าตอนนี้อยู่ไดร์ฟไหน
 */
export function NewMenu({
  variant = 'solid',
  onCreateFolder,
  onCreateExternal,
  onUploadFile,
  onUploadFolder,
}: {
  variant?: 'solid' | 'outline';
  onCreateFolder?: () => void;
  onCreateExternal?: (type: ExternalResourceType) => void;
  onUploadFile?: () => void;
  onUploadFolder?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, open, () => setOpen(false));
  const createExternal = (type: ExternalResourceType) => {
    setOpen(false);
    if (onCreateExternal) onCreateExternal(type);
    else window.dispatchEvent(new CustomEvent('s2-create-external', { detail: { type } }));
  };

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
        <div
          role="menu"
          className="s2-menu absolute left-0 z-[var(--z-menu)] mt-7 max-h-[70vh] w-56 overflow-y-auto sm:left-auto sm:right-0"
        >
          <MenuItem
            icon={<FolderPlus className="h-4 w-4" />}
            label="สร้างโฟลเดอร์"
            onSelect={() => { setOpen(false); onCreateFolder ? onCreateFolder() : window.dispatchEvent(new Event('s2-create-folder')); }}
          />
          <MenuSeparator />
          <MenuItem
            icon={<Upload className="h-4 w-4" />}
            label="อัปโหลดไฟล์"
            onSelect={() => {
              setOpen(false);
              if (onUploadFile) onUploadFile();
              else window.dispatchEvent(new Event('s2-upload-file'));
            }}
          />
          <MenuItem
            icon={<FolderUp className="h-4 w-4" />}
            label="อัปโหลดโฟลเดอร์"
            onSelect={() => {
              setOpen(false);
              if (onUploadFolder) onUploadFolder();
              else window.dispatchEvent(new Event('s2-upload-folder'));
            }}
          />
          <MenuSeparator />
          <MenuItem icon={<Sheet className="h-4 w-4" />} label="เพิ่ม Google Sheet" onSelect={() => createExternal('GOOGLE_SHEET')} />
          <MenuItem icon={<FileText className="h-4 w-4" />} label="เพิ่ม Google Doc" onSelect={() => createExternal('GOOGLE_DOC')} />
          <MenuItem icon={<Globe2 className="h-4 w-4" />} label="เพิ่ม Google Drive" onSelect={() => createExternal('GOOGLE_DRIVE')} />
          <MenuItem icon={<Link2 className="h-4 w-4" />} label="เพิ่มลิงก์" onSelect={() => createExternal('WEB_LINK')} />
        </div>
      ) : null}
    </div>
  );
}
