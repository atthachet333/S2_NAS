import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DriveRoot } from '@/lib/drive-labels';
import { selectableDriveRoots } from '@/lib/folder-picker';
import { isSameLocation } from '@/lib/folder-picker';
import { FolderPlus, PenLine, FolderInput, UserRoundCog, Trash2, X } from 'lucide-react';
import { ApiError, fileApi, resourceApi } from '@/lib/api';
import type { DriveEntry } from '@/lib/drive';
import { FolderPicker } from './FolderPicker';
import { OwnerPicker } from './OwnerPicker';
import { useAuth } from '@/hooks/useAuth';

export type ResourceDialogMode = 'create' | 'rename' | 'move' | 'owner' | 'delete';
const ERROR_MESSAGES: Record<string, string> = {
  FOLDER_NAME_EXISTS: 'มีโฟลเดอร์ชื่อนี้อยู่แล้ว', INVALID_RESOURCE_NAME: 'ชื่อโฟลเดอร์ไม่ถูกต้อง',
  INVALID_MOVE: 'ไม่สามารถย้ายโฟลเดอร์ไปยังตำแหน่งนี้ได้', RESOURCE_ACCESS_DENIED: 'คุณไม่มีสิทธิ์ดำเนินการนี้',
  CROSS_DRIVE_MOVE_DENIED: 'การย้ายทรัพยากรข้ามไดร์ฟสงวนไว้สำหรับผู้ดูแลระบบ',
  SYSTEM_DRIVE_WRITE_DENIED: 'คุณไม่มีสิทธิ์เพิ่มทรัพยากรในไดร์ฟของระบบ',
  OWNER_NOT_FOUND: 'ไม่พบผู้ใช้ที่เปิดใช้งาน เลือกผู้ดูแลรายอื่นแล้วลองใหม่',
  FOLDER_NOT_EMPTY: 'โฟลเดอร์นี้ยังมีรายการอยู่ ต้องย้ายหรือลบรายการภายในก่อน',
  OWNER_TRANSFER_DENIED: 'คุณไม่มีสิทธิ์เปลี่ยนผู้ดูแลของโฟลเดอร์นี้',
  FOLDER_NOT_FOUND: 'ไม่พบโฟลเดอร์ปลายทาง อาจถูกย้ายหรือลบไปแล้ว',
  RESOURCE_NOT_FOUND: 'ไม่พบทรัพยากรนี้แล้ว',
  VALIDATION_ERROR: 'ข้อมูลที่กรอกไม่ถูกต้อง',
};

export function ResourceDialog({ mode, entry, parentId, driveRoot = 'MY_DRIVE', onClose, onSuccess }: { mode: ResourceDialogMode; entry: DriveEntry | null; parentId: string | null; driveRoot?: DriveRoot; onClose: () => void; onSuccess: (message: string) => void }) {
  const { user } = useAuth();
  const [name, setName] = useState(entry?.name ?? '');
  const [ownerId, setOwnerId] = useState(entry?.ownerId ?? user?.id ?? '');
  const [destinationId, setDestinationId] = useState<string | null>(entry?.parentId ?? parentId);
  /**
   * ไดร์ฟต้นทางของทรัพยากรที่กำลังย้าย ไม่ใช่ไดร์ฟของหน้าที่เปิดกล่องนี้
   * ทั้งสองค่าตรงกันเกือบตลอด แต่รายการที่มาจากหน้ารวม (ล่าสุด/รายการโปรด) อาจต่างกันได้
   */
  const sourceDriveRoot: DriveRoot = entry?.driveRoot ?? driveRoot;
  const [destinationDrive, setDestinationDrive] = useState<DriveRoot>(sourceDriveRoot);
  const allowedDriveRoots = selectableDriveRoots(user, sourceDriveRoot);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  const canReadUsers = Boolean(user?.permissions.includes('users:read'));
  /** เส้นทางของตำแหน่งปัจจุบัน ใช้แสดง "ตำแหน่งปัจจุบัน" เป็นเส้นทางเชิงตรรกะ ไม่ใช่ path จริง */
  const { data: currentCrumbs } = useQuery({
    queryKey: ['resource-dialog-crumbs', entry?.parentId],
    queryFn: () => resourceApi.breadcrumb(entry!.parentId!),
    enabled: mode === 'move' && Boolean(entry?.parentId),
  });
  useEffect(() => { firstRef.current?.focus(); }, []);
  const isFile = entry?.kind === 'file';
  const noun = isFile ? 'ไฟล์' : 'โฟลเดอร์';
  const titles = {
    create: 'สร้างโฟลเดอร์',
    rename: `เปลี่ยนชื่อ${noun}`,
    move: `ย้าย${noun}`,
    owner: 'เปลี่ยนผู้ดูแลโฟลเดอร์',
    delete: `ย้าย${noun}ไปถังขยะ`,
  } as const;
  const icons = { create: FolderPlus, rename: PenLine, move: FolderInput, owner: UserRoundCog, delete: Trash2 } as const;
  const Icon = icons[mode];
  /** ปลายทางเดียวกับตำแหน่งเดิม = ไม่มีอะไรให้ย้าย จึงปิดปุ่มยืนยันไว้ */
  const moveUnchanged = isSameLocation(
    { driveRoot: sourceDriveRoot, parentId: entry?.parentId ?? null },
    { driveRoot: destinationDrive, parentId: destinationId },
  );
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError(null); setSubmitting(true);
    try {
      // ที่ระดับรากต้องบอกไดร์ฟเสมอ ในโฟลเดอร์ backend จะสืบทอดจากโฟลเดอร์แม่เอง
      if (mode === 'create') await resourceApi.createFolder({ name, parentId, ...(parentId ? {} : { driveScope: driveRoot }), ...(canReadUsers && ownerId !== user?.id ? { ownerId } : {}) });
      if (mode === 'rename' && entry) await resourceApi.update(entry.id, { name });
      /**
       * ไดร์ฟปลายทางส่งไปเฉพาะตอนวางไว้ที่ราก ถ้าวางในโฟลเดอร์ backend จะสืบทอดจากโฟลเดอร์แม่เอง
       * และเป็นผู้ไล่ปรับ driveScope ของลูกหลานทั้งกิ่ง - หน้าจอไม่ทำซ้ำตรรกะนั้น
       */
      if (mode === 'move' && entry) await resourceApi.move(entry.id, destinationId, destinationId ? undefined : destinationDrive);
      if (mode === 'owner' && entry) await resourceApi.transferOwner(entry.id, ownerId);
      // ใช้เส้นทางถังขยะของ Phase D เพื่อให้บันทึกตำแหน่งเดิม ผู้ลบ และลูกหลานครบ
      if (mode === 'delete' && entry) await fileApi.moveToTrash(entry.id);
      onSuccess(mode === 'create' ? 'สร้างโฟลเดอร์แล้ว' : mode === 'rename' ? 'เปลี่ยนชื่อแล้ว' : mode === 'move' ? `ย้าย${noun}แล้ว` : mode === 'owner' ? 'เปลี่ยนผู้ดูแลแล้ว' : 'ย้ายไปถังขยะแล้ว');
    } catch (reason) {
      setError(reason instanceof ApiError ? ERROR_MESSAGES[reason.code] ?? reason.message : 'ดำเนินการไม่สำเร็จ');
    } finally { setSubmitting(false); }
  };
  return <div className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-3 backdrop-blur-sm" onMouseDown={onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="resource-dialog-title" className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop sm:p-6" onMouseDown={(event) => event.stopPropagation()}>
      <div className="flex items-start gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><Icon className="h-5 w-5" /></span><div className="min-w-0 flex-1"><h2 id="resource-dialog-title" className="text-[16px] font-semibold text-navy-900">{titles[mode]}</h2>{entry ? <p className="mt-1 truncate text-[11px] text-navy-400">{entry.name}</p> : <p className="mt-1 text-[11px] text-navy-400">จัดเก็บภายใต้พื้นที่องค์กร S2 NAS</p>}</div><button type="button" onClick={onClose} aria-label="ปิด" className="rounded-lg p-1.5 text-navy-400 hover:bg-navy-50"><X className="h-4 w-4" /></button></div>
      <form onSubmit={submit} className="mt-5 space-y-4">
        {(mode === 'create' || mode === 'rename') ? <label className="block text-[11.5px] font-semibold text-navy-700">{mode === 'create' ? 'ชื่อโฟลเดอร์' : `ชื่อ${noun}`}<input ref={firstRef} className="s2-input mt-1.5 h-11 rounded-xl px-3 text-[13px]" value={name} onChange={(event) => setName(event.target.value)} maxLength={191} required /></label> : null}
        {mode === 'create' || mode === 'owner' ? (
          <div>
            <p className="text-[11.5px] font-semibold text-navy-700">ผู้ดูแล</p>
            <div className="mt-1.5">
              <OwnerPicker
                value={ownerId}
                onChange={setOwnerId}
                showTransfer={mode === 'owner'}
                disabled={!canReadUsers}
                currentOwner={
                  entry
                    ? { displayName: entry.ownerName, email: entry.ownerEmail }
                    : user
                      ? { displayName: user.displayName, email: user.email }
                      : undefined
                }
              />
            </div>
          </div>
        ) : null}
        {mode === 'move' ? (
          <FolderPicker
            value={destinationId}
            onChange={setDestinationId}
            driveRoot={destinationDrive}
            onDriveRootChange={setDestinationDrive}
            selectableDriveRoots={allowedDriveRoots}
            excludeId={entry?.id}
            currentParentId={entry?.parentId ?? null}
            currentDriveRoot={sourceDriveRoot}
            currentLocationSegments={(currentCrumbs?.data ?? []).map((node) => node.name)}
          />
        ) : null}
        {mode === 'delete' ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-[12px] leading-relaxed text-amber-700">
            {isFile
              ? 'ไฟล์จะถูกย้ายไปถังขยะ ยังกู้คืนได้และไฟล์จริงยังไม่ถูกลบออกจาก storage'
              : 'โฟลเดอร์นี้พร้อมรายการภายในจะถูกย้ายไปถังขยะ ยังกู้คืนได้และไฟล์จริงยังไม่ถูกลบออกจาก storage'}
          </p>
        ) : null}
        {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-[11.5px] text-red-700">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-1"><button type="button" onClick={onClose} className="s2-btn s2-btn-ghost">ยกเลิก</button><button type="submit" disabled={submitting || ((mode === 'create' || mode === 'rename') && !name.trim()) || (mode === 'move' && moveUnchanged)} className={mode === 'delete' ? 's2-btn border border-red-200 bg-red-50 text-red-700' : 's2-btn s2-btn-primary'}>{submitting ? 'กำลังดำเนินการ…' : mode === 'move' ? 'ย้ายมาที่นี่' : mode === 'create' ? 'สร้างโฟลเดอร์' : mode === 'owner' ? 'เปลี่ยนผู้ดูแล' : mode === 'delete' ? `ย้าย${noun}ไปถังขยะ` : 'บันทึก'}</button></div>
      </form>
    </section>
  </div>;
}
