import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Download, Eye, FileArchive, FileText, FileUp, FolderInput, FolderPlus, FolderUp,
  Globe2, History, Info, Link2, Lock, LockOpen, MessageSquareText, PenLine, Pin, PinOff,
  Share2, Sheet, SquareArrowOutUpRight, Star, StarOff, Tag, Trash2, Upload, UserRoundCog,
} from 'lucide-react';
import { MenuItem, MenuLabel, MenuSeparator } from '@/components/ui/Menu';
import type { DriveEntry } from '@/lib/drive';
import { clampContextMenuPosition, nextMenuIndex, visibleResourceActions } from '@/lib/interaction-policy';
import { isPreviewable } from '@/lib/file-types';

export interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  entry: DriveEntry | null;
  keyboard: boolean;
  returnFocus: HTMLElement | null;
}

const CLOSED: ContextMenuState = { open: false, x: 0, y: 0, entry: null, keyboard: false, returnFocus: null };

export function useContextMenu() {
  const [state, setState] = useState<ContextMenuState>(CLOSED);

  const openAt = useCallback((event: React.MouseEvent, entry: DriveEntry | null) => {
    event.preventDefault();
    event.stopPropagation();
    setState({ open: true, x: event.clientX, y: event.clientY, entry, keyboard: false, returnFocus: null });
  }, []);

  const openForEntry = useCallback((entry: DriveEntry, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    setState({ open: true, x: rect.left + 16, y: rect.top + 16, entry, keyboard: true, returnFocus: anchor });
  }, []);

  const close = useCallback(() => setState((current) => {
    if (current.returnFocus) queueMicrotask(() => current.returnFocus?.focus());
    return CLOSED;
  }), []);
  return { state, openAt, openForEntry, close };
}

export function ContextMenu({
  state,
  destinationName,
  onClose,
  onAction,
}: {
  state: ContextMenuState;
  destinationName: string;
  onClose: () => void;
  onAction: (action: string, entry: DriveEntry | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: state.x, y: state.y });

  useEffect(() => {
    if (!state.open || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setPosition(clampContextMenuPosition(
      { x: state.x, y: state.y },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    ));
    if (state.keyboard) {
      requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus());
    }
  }, [state.open, state.x, state.y, state.keyboard]);

  useEffect(() => {
    if (!state.open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [state.open, onClose]);

  if (!state.open) return null;
  const entry = state.entry;
  const allowed = entry ? new Set(visibleResourceActions(entry)) : new Set<string>();
  const run = (action: string) => () => { onAction(action, entry); onClose(); };

  const personal = (
    <>
      {allowed.has('favorite') ? <MenuItem icon={<Star className="h-4 w-4" />} label="เพิ่มในรายการโปรด" onSelect={run('favorite')} /> : null}
      {allowed.has('unfavorite') ? <MenuItem icon={<StarOff className="h-4 w-4" />} label="นำออกจากรายการโปรด" onSelect={run('unfavorite')} /> : null}
      {allowed.has('pin') ? <MenuItem icon={<Pin className="h-4 w-4" />} label="ปักหมุด" onSelect={run('pin')} /> : null}
      {allowed.has('unpin') ? <MenuItem icon={<PinOff className="h-4 w-4" />} label="ยกเลิกปักหมุด" onSelect={run('unpin')} /> : null}
    </>
  );

  const metadata = (
    <>
      {allowed.has('tags') ? <MenuItem icon={<Tag className="h-4 w-4" />} label="จัดการแท็ก" onSelect={run('tags')} /> : null}
      {allowed.has('remark') ? <MenuItem icon={<MessageSquareText className="h-4 w-4" />} label="หมายเหตุ" onSelect={run('remark')} /> : null}
      {allowed.has('share') ? <MenuItem icon={<Share2 className="h-4 w-4" />} label="จัดการสิทธิ์เข้าถึง" onSelect={run('share')} /> : null}
      {allowed.has('lock') ? <MenuItem icon={<Lock className="h-4 w-4" />} label="ล็อกทรัพยากร" onSelect={run('lock')} /> : null}
      {allowed.has('unlock') ? <MenuItem icon={<LockOpen className="h-4 w-4" />} label="ปลดล็อก" onSelect={run('unlock')} /> : null}
    </>
  );


  const menu = (
    <div
      ref={ref}
      role="menu"
      aria-label={entry ? `ตัวเลือกของ ${entry.name}` : `สร้างใน ${destinationName}`}
      className="s2-menu fixed z-[var(--z-context)] w-64"
      style={{ left: position.x, top: position.y }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? []);
        const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
        items[nextMenuIndex(current, event.key, items.length)]?.focus();
      }}
    >
      {entry === null ? (
        <>
          <MenuLabel>สร้างใน “{destinationName}”</MenuLabel>
          <MenuItem icon={<FolderPlus className="h-4 w-4" />} label="สร้างโฟลเดอร์" onSelect={run('create-folder')} />
          <MenuSeparator />
          <MenuItem icon={<Upload className="h-4 w-4" />} label="อัปโหลดไฟล์" onSelect={run('upload-here')} />
          <MenuItem icon={<FolderUp className="h-4 w-4" />} label="อัปโหลดโฟลเดอร์" shortcut="เร็ว ๆ นี้" disabled />
          <MenuSeparator />
          <MenuItem icon={<Sheet className="h-4 w-4" />} label="เพิ่ม Google Sheet" shortcut="เร็ว ๆ นี้" disabled />
          <MenuItem icon={<FileText className="h-4 w-4" />} label="เพิ่ม Google Doc" shortcut="เร็ว ๆ นี้" disabled />
          <MenuItem icon={<Globe2 className="h-4 w-4" />} label="เพิ่ม Google Drive" shortcut="เร็ว ๆ นี้" disabled />
          <MenuItem icon={<Link2 className="h-4 w-4" />} label="เพิ่มลิงก์" shortcut="เร็ว ๆ นี้" disabled />
        </>
      ) : entry.kind === 'folder' ? (
        <>
          <MenuItem icon={<SquareArrowOutUpRight className="h-4 w-4" />} label="เปิด" onSelect={run('open')} />
          {allowed.has('create-folder-inside') || allowed.has('upload-here') ? <MenuSeparator /> : null}
          {allowed.has('create-folder-inside') ? <MenuItem icon={<FolderPlus className="h-4 w-4" />} label="สร้างโฟลเดอร์ภายใน" onSelect={run('create-folder-inside')} /> : null}
          {allowed.has('upload-here') ? <MenuItem icon={<Upload className="h-4 w-4" />} label="อัปโหลดไฟล์ที่นี่" onSelect={run('upload-here')} /> : null}
          <MenuSeparator />
          <MenuItem icon={<FileArchive className="h-4 w-4" />} label="ดาวน์โหลดเป็น ZIP" onSelect={run('download-zip')} />
          <MenuSeparator />
          {personal}
          <MenuSeparator />
          {allowed.has('rename') ? <MenuItem icon={<PenLine className="h-4 w-4" />} label="เปลี่ยนชื่อ" onSelect={run('rename')} /> : null}
          {allowed.has('move') ? <MenuItem icon={<FolderInput className="h-4 w-4" />} label="ย้าย" onSelect={run('move')} /> : null}
          {metadata}
          {allowed.has('owner') ? <MenuItem icon={<UserRoundCog className="h-4 w-4" />} label="เปลี่ยนผู้ดูแล" onSelect={run('owner')} /> : null}
          <MenuSeparator />
          <MenuItem icon={<Info className="h-4 w-4" />} label="รายละเอียด" onSelect={run('details')} />
          <MenuItem icon={<History className="h-4 w-4" />} label="ประวัติการใช้งาน" onSelect={run('activity')} />
          {allowed.has('trash') ? <><MenuSeparator /><MenuItem icon={<Trash2 className="h-4 w-4" />} label="ย้ายไปถังขยะ" danger onSelect={run('trash')} /></> : null}
        </>
      ) : (
        <>
          <MenuItem icon={<Eye className="h-4 w-4" />} label="ดูตัวอย่าง" disabled={!isPreviewable(entry.name, entry.mimeType)} onSelect={run('preview')} />
          {allowed.has('download') ? <MenuItem icon={<Download className="h-4 w-4" />} label="ดาวน์โหลดไฟล์ต้นฉบับ" onSelect={run('download')} /> : null}
          {allowed.has('new-version') ? <><MenuSeparator /><MenuItem icon={<FileUp className="h-4 w-4" />} label="อัปโหลดเวอร์ชันใหม่" onSelect={run('new-version')} /></> : null}
          <MenuSeparator />
          {personal}
          <MenuSeparator />
          {allowed.has('rename') ? <MenuItem icon={<PenLine className="h-4 w-4" />} label="เปลี่ยนชื่อ" onSelect={run('rename')} /> : null}
          {allowed.has('move') ? <MenuItem icon={<FolderInput className="h-4 w-4" />} label="ย้าย" onSelect={run('move')} /> : null}
          {metadata}
          <MenuSeparator />
          <MenuItem icon={<Info className="h-4 w-4" />} label="รายละเอียด" onSelect={run('details')} />
          <MenuItem icon={<History className="h-4 w-4" />} label="ประวัติการใช้งาน" onSelect={run('activity')} />
          {allowed.has('trash') ? <><MenuSeparator /><MenuItem icon={<Trash2 className="h-4 w-4" />} label="ย้ายไปถังขยะ" danger onSelect={run('trash')} /></> : null}
        </>
      )}
    </div>
  );

  return createPortal(menu, document.body);
}
