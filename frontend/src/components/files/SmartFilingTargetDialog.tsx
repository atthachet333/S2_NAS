import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FolderPlus, X } from 'lucide-react';
import { resourceApi } from '@/lib/api';
import { driveDestination, type DriveRoot } from '@/lib/drive-labels';
import { FolderPicker } from './FolderPicker';

/**
 * เลือกหรือสร้างโฟลเดอร์ปลายทางสำหรับการจัดเก็บอัจฉริยะ (F22-F10/F11)
 *
 * **กล่องนี้ไม่ย้ายอะไรเลย** หน้าที่เดียวคือคืนรหัสโฟลเดอร์ที่ผู้ใช้เลือก
 * การย้ายจริงยังเกิดที่เส้นทางยืนยันของการจัดเก็บอัจฉริยะเหมือนเดิมทุกประการ
 * ซึ่งตรวจสิทธิ์ใหม่ทั้งชุดแล้วเรียกบริการย้ายเดิมของระบบ
 *
 * **การสร้างโฟลเดอร์ไม่ย้ายเอกสารตามไปด้วย** เป็นสองการกระทำที่แยกจากกันชัดเจน
 * ผู้ใช้สร้างโฟลเดอร์เสร็จแล้วยังต้องยืนยันการย้ายอีกครั้งต่างหาก
 * การรวมสองอย่างเป็นการกระทำเดียวทำให้ผู้ใช้ย้ายเอกสารโดยไม่ได้ตั้งใจ
 *
 * ตัวเลือกโฟลเดอร์ใช้ของเดิมของระบบ ซึ่งดึงรายการจากเซิร์ฟเวอร์ที่กรองสิทธิ์ไว้แล้ว
 * โฟลเดอร์ที่ผู้ใช้เข้าไม่ถึงจึงไม่มีทางปรากฏในรายการนี้
 */

export interface SmartFilingTargetDialogProps {
  resourceId: string;
  currentParentId: string | null;
  currentDriveRoot?: DriveRoot;
  /** ผู้ใช้เลือกปลายทางแล้ว - ผู้เรียกต้องไปขั้นยืนยันต่อ ไม่ใช่ย้ายทันที */
  onSelect: (target: { folderId: string; label: string }) => void;
  onClose: () => void;
}

export function SmartFilingTargetDialog({
  resourceId, currentParentId, currentDriveRoot = 'MY_DRIVE', onSelect, onClose,
}: SmartFilingTargetDialogProps): JSX.Element {
  const [destinationId, setDestinationId] = useState<string | null>(currentParentId);
  const [driveRoot, setDriveRoot] = useState<DriveRoot>(currentDriveRoot);
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [createdFolder, setCreatedFolder] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * ชื่อเต็มของปลายทางที่เลือก - ขั้นยืนยันต้องบอกว่าจะย้ายไปไหน
   *
   * ป้ายกลาง ๆ อย่าง "โฟลเดอร์ที่เลือก" ทำให้ผู้ใช้ยืนยันการย้ายโดยไม่เห็นปลายทาง
   * ซึ่งเป็นจุดที่ผิดพลาดแล้วแก้กลับยาก ปุ่มยืนยันจึงถูกปิดไว้จนกว่าจะรู้เส้นทางจริง
   */
  const { data: crumbs } = useQuery({
    queryKey: ['smart-filing-target-crumbs', destinationId],
    queryFn: () => resourceApi.breadcrumb(destinationId!),
    enabled: Boolean(destinationId),
  });
  const destinationLabel = destinationId
    ? crumbs?.data.length
      ? driveDestination(driveRoot, crumbs.data.map((node) => node.name))
      : null
    : driveDestination(driveRoot);

  const createFolder = useMutation({
    mutationFn: async () => {
      const created = await resourceApi.createFolder({
        name: folderName.trim(),
        parentId: destinationId,
        driveScope: driveRoot,
      });
      return created.data;
    },
    onSuccess: (folder) => {
      setError(null);
      setCreating(false);
      // สร้างเสร็จแล้วยังไม่ย้าย - ถามแยกอีกครั้งว่าจะย้ายหรือไม่
      setCreatedFolder({ id: folder.id, name: folder.name });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  /**
   * ถามเรื่องการย้ายแยกจากการสร้าง
   *
   * ผู้ใช้ที่ตั้งใจแค่สร้างโฟลเดอร์ไว้ก่อน ต้องออกจากขั้นตอนนี้ได้โดยเอกสารไม่ขยับ
   */
  if (createdFolder) {
    return (
      <div className="fixed inset-0 z-[calc(var(--z-context)+3)] flex items-center justify-center bg-black/40 p-4"
        role="dialog" aria-label="สร้างโฟลเดอร์แล้ว">
        <div className="w-full max-w-md rounded-xl border border-line bg-[var(--s2-surface)] p-4">
          <p className="text-[13px] font-medium text-navy-800">สร้างโฟลเดอร์แล้ว</p>
          <p className="mt-1 break-words text-[12px] text-navy-600">{createdFolder.name}</p>
          <p className="mt-3 text-[12px] text-navy-600">ต้องการย้ายเอกสารนี้เข้าโฟลเดอร์ที่สร้างหรือไม่?</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className="s2-btn s2-btn-primary"
              onClick={() => onSelect({
                folderId: createdFolder.id,
                // เส้นทางเต็มของโฟลเดอร์ที่เพิ่งสร้าง ไม่ใช่ชื่อลอย ๆ เพราะชื่อซ้ำกันได้ทั้งระบบ
                label: destinationLabel ? `${destinationLabel} / ${createdFolder.name}` : createdFolder.name,
              })}>
              ย้ายเอกสาร
            </button>
            <button type="button" className="s2-btn s2-btn-outline" onClick={onClose}>ไว้ที่เดิม</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[calc(var(--z-context)+3)] flex items-center justify-center bg-black/40 p-4"
      role="dialog" aria-label="เลือกโฟลเดอร์ปลายทาง">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-xl border border-line bg-[var(--s2-surface)] p-4">
        <header className="flex items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold text-navy-800">เลือกโฟลเดอร์ปลายทาง</h3>
          <button type="button" className="rounded-lg p-1.5 text-navy-400 hover:bg-navy-50"
            onClick={onClose} aria-label="ปิด"><X className="h-4 w-4" /></button>
        </header>

        <FolderPicker
          value={destinationId}
          onChange={setDestinationId}
          driveRoot={driveRoot}
          onDriveRootChange={setDriveRoot}
          selectableDriveRoots={[currentDriveRoot]}
          excludeId={resourceId}
          currentParentId={currentParentId}
          currentDriveRoot={currentDriveRoot}
        />

        {creating ? (
          <div className="rounded-lg border border-line bg-[var(--s2-surface-soft)] p-3">
            <label className="block text-[12px] text-navy-600" htmlFor="smart-filing-new-folder">ชื่อโฟลเดอร์</label>
            <input id="smart-filing-new-folder" className="s2-input mt-1 w-full" value={folderName}
              onChange={(event) => setFolderName(event.target.value)} placeholder="ชื่อโฟลเดอร์ใหม่" />
            <p className="mt-2 text-[11px] text-navy-500">
              จะถูกสร้างไว้ในโฟลเดอร์ที่เลือกไว้ด้านบน
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="s2-btn s2-btn-primary"
                disabled={folderName.trim().length === 0 || createFolder.isPending}
                onClick={() => createFolder.mutate()}>
                ยืนยันสร้างโฟลเดอร์
              </button>
              <button type="button" className="s2-btn s2-btn-ghost" onClick={() => setCreating(false)}>ยกเลิก</button>
            </div>
          </div>
        ) : null}

        {error ? <p className="text-[12px] text-red-600" role="alert">{error}</p> : null}

        <footer className="flex flex-wrap gap-2">
          <button type="button" className="s2-btn s2-btn-primary" disabled={!destinationId || !destinationLabel}
            onClick={() => destinationId && destinationLabel
              && onSelect({ folderId: destinationId, label: destinationLabel })}>
            ใช้โฟลเดอร์นี้
          </button>
          {!creating ? (
            <button type="button" className="s2-btn s2-btn-outline" onClick={() => setCreating(true)}>
              <FolderPlus className="h-3.5 w-3.5" aria-hidden /> สร้างโฟลเดอร์
            </button>
          ) : null}
          <button type="button" className="s2-btn s2-btn-ghost" onClick={onClose}>ยกเลิก</button>
        </footer>
      </div>
    </div>
  );
}
