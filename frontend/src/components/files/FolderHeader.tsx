import type { ReactNode } from 'react';
import { FolderOpen, Info, Lock, PenLine, Plus, UserRoundCog, FolderInput } from 'lucide-react';
import type { ResourceDto } from '@/lib/api';
import { OwnerAvatar, ownerLabel } from './OwnerIdentity';
import { ResourceSourceBadge } from './ResourceSourceBadge';
import type { ResourceSource } from './ResourceSourceBadge';
import { formatDateTime, formatRelativeTime } from '@/lib/utils';

/**
 * หัวเรื่องของโฟลเดอร์ที่กำลังเปิดอยู่
 *
 * ตอบสามคำถามในบรรทัดเดียว: อยู่ที่ไหน ใครดูแล และสถานะล่าสุดเป็นอย่างไร
 * ปุ่มการทำงานแสดงเฉพาะสิ่งที่ capability จากเซิร์ฟเวอร์อนุญาตจริง
 */
export function FolderHeader({
  folder,
  onCreateFolder,
  newMenu,
  onRename,
  onMove,
  onTransferOwner,
  onDetails,
}: {
  folder: ResourceDto;
  onCreateFolder: () => void;
  /** เมนูสร้างทรัพยากรที่รู้ปลายทางไดร์ฟ - ส่งเข้ามาจากหน้าที่ใช้งาน */
  newMenu?: ReactNode;
  onRename: () => void;
  onMove: () => void;
  onTransferOwner: () => void;
  onDetails: () => void;
}) {
  const { capabilities } = folder;

  return (
    <header className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
      <div className="flex min-w-0 items-start gap-3.5">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
          <FolderOpen className="h-6 w-6" aria-hidden />
        </span>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-[26px] font-semibold leading-tight tracking-tight text-navy-900">
              {folder.name}
            </h1>
            {folder.isLocked ? (
              <span className="inline-flex items-center gap-1 rounded-md border border-line bg-[var(--s2-surface-soft)] px-1.5 py-0.5 text-[10px] font-medium text-navy-500">
                <Lock className="h-3 w-3" aria-hidden />
                ล็อกไว้
              </span>
            ) : null}
            <ResourceSourceBadge source={folder.sourceType as ResourceSource} hideManual />
          </div>

          {/* ผู้ดูแล + สถานะ อยู่บรรทัดเดียวกันเพื่อให้อ่านจบในสายตาเดียว */}
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] text-navy-400">
            <span className="inline-flex items-center gap-1.5">
              <OwnerAvatar owner={folder.owner} size="xs" />
              <span className="font-semibold text-navy-800">{ownerLabel(folder.owner)}</span>
              <span>· ผู้ดูแลหลัก</span>
            </span>
            <span className="text-navy-200" aria-hidden>
              |
            </span>
            <span title={formatDateTime(folder.updatedAt)}>
              แก้ไขล่าสุด {formatRelativeTime(folder.updatedAt)}
            </span>
            <span className="text-navy-200" aria-hidden>
              ·
            </span>
            <span>{folder.itemCount} รายการ</span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 xl:justify-end">
        {/* เมนูสร้างทรัพยากรถูกส่งเข้ามาจากหน้าที่รู้ว่าอยู่ไดร์ฟไหน ที่นี่ไม่ตัดสินปลายทางเอง */}
        {capabilities.canEdit ? (newMenu ?? (
          <button type="button" className="s2-btn s2-btn-outline" onClick={onCreateFolder}>
            <Plus className="h-4 w-4" aria-hidden />
            ใหม่
          </button>
        )) : null}
        {capabilities.canRename ? (
          <button type="button" className="s2-btn s2-btn-outline" onClick={onRename}>
            <PenLine className="h-4 w-4" aria-hidden />
            เปลี่ยนชื่อ
          </button>
        ) : null}
        {capabilities.canMove ? (
          <button type="button" className="s2-btn s2-btn-outline" onClick={onMove}>
            <FolderInput className="h-4 w-4" aria-hidden />
            ย้าย
          </button>
        ) : null}
        {capabilities.canTransferOwner ? (
          <button type="button" className="s2-btn s2-btn-outline" onClick={onTransferOwner}>
            <UserRoundCog className="h-4 w-4" aria-hidden />
            เปลี่ยนผู้ดูแล
          </button>
        ) : null}
        <button type="button" className="s2-btn s2-btn-ghost" onClick={onDetails}>
          <Info className="h-4 w-4" aria-hidden />
          รายละเอียด
        </button>
      </div>
    </header>
  );
}
