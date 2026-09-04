import type { ReactNode } from 'react';
import { FolderPlus } from 'lucide-react';
import { SYSTEM_DRIVE_LABEL, type DriveRoot } from '@/lib/drive-labels';

/**
 * สถานะว่าง V4
 *
 * กระชับและมีขอบเขตชัดเจน ไม่กินพื้นที่ครึ่งหน้าจอเพียงเพราะยังไม่มีข้อมูล
 *
 * ไม่โฆษณาสิ่งที่ทำได้อยู่แล้วว่าเป็น "ฟีเจอร์ถัดไป" - การสร้างทรัพยากรทุกชนิด
 * อยู่หลังปุ่ม + ใหม่ ที่ส่งเข้ามา จึงชี้ไปที่นั่นแทนการชวนให้สร้างโฟลเดอร์อย่างเดียว
 */
export function WorkspaceOnboarding({
  onCreateFolder,
  canCreate = true,
  driveRoot = 'MY_DRIVE',
  newMenu,
}: {
  onCreateFolder: () => void;
  canCreate?: boolean;
  driveRoot?: DriveRoot;
  /** ปุ่ม + ใหม่ ที่รู้ปลายทางไดร์ฟแล้ว */
  newMenu?: ReactNode;
}) {
  const systemDrive = driveRoot === 'SYSTEM_DRIVE';

  return (
    <div className="s2-resource-card mx-auto w-full max-w-lg px-5 py-6 text-center">
      <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
        <FolderPlus className="h-5 w-5" aria-hidden />
      </span>

      <h3 className="mt-3 text-[14.5px] font-semibold text-navy-900">
        {systemDrive ? `ยังไม่มีรายการใน${SYSTEM_DRIVE_LABEL}` : 'ยังไม่มีรายการ'}
      </h3>
      <p className="mt-1 text-[12px] leading-relaxed text-navy-400">
        {systemDrive
          ? 'เพิ่มโฟลเดอร์ ไฟล์ หรือทรัพยากรส่วนกลางสำหรับบุคลากรในองค์กร'
          : 'เพิ่มโฟลเดอร์ ไฟล์ หรือทรัพยากรเพื่อเริ่มจัดระเบียบพื้นที่ทำงานของคุณ'}
      </p>

      {canCreate ? (
        <div className="mt-4 flex justify-center">
          {newMenu ?? (
            <button type="button" className="s2-btn s2-btn-primary" onClick={onCreateFolder}>
              <FolderPlus className="h-4 w-4" aria-hidden />
              สร้างโฟลเดอร์
            </button>
          )}
        </div>
      ) : (
        <p className="mt-4 rounded-lg border border-line bg-[var(--s2-surface-soft)] px-3 py-2 text-[11.5px] text-navy-500">
          {systemDrive
            ? 'บัญชีของคุณเปิดดูและดาวน์โหลดไดร์ฟของระบบได้ แต่ไม่มีสิทธิ์เพิ่มทรัพยากร'
            : 'บัญชีของคุณไม่มีสิทธิ์สร้างทรัพยากรในตำแหน่งนี้'}
        </p>
      )}
    </div>
  );
}
