import { FolderPlus, Globe, HardDriveUpload, Link2, Sheet } from 'lucide-react';

/**
 * สถานะว่าง V4
 *
 * กระชับและมีขอบเขตชัดเจน ไม่กินพื้นที่ครึ่งหน้าจอเพียงเพราะยังไม่มีข้อมูล
 * ทางลัดของอนาคตเป็นเพียงข้อความบอกลำดับถัดไป ไม่ใช่ปุ่มที่ดูกดได้
 */
const NEXT_FEATURES = [
  { icon: Sheet, label: 'Google Sheet' },
  { icon: Globe, label: 'Drive' },
  { icon: Link2, label: 'Web Link' },
  { icon: HardDriveUpload, label: 'อัปโหลดไฟล์' },
] as const;

export function WorkspaceOnboarding({
  onCreateFolder,
  canCreate = true,
}: {
  onCreateFolder: () => void;
  canCreate?: boolean;
}) {
  return (
    <div className="s2-resource-card mx-auto w-full max-w-lg px-5 py-6 text-center">
      <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
        <FolderPlus className="h-5 w-5" aria-hidden />
      </span>

      <h3 className="mt-3 text-[14.5px] font-semibold text-navy-900">ยังไม่มีรายการ</h3>
      <p className="mt-1 text-[12px] leading-relaxed text-navy-400">
        เริ่มด้วยการสร้างโฟลเดอร์เพื่อจัดระเบียบทรัพยากรขององค์กร
      </p>

      {canCreate ? (
        <button type="button" className="s2-btn s2-btn-primary mt-4" onClick={onCreateFolder}>
          <FolderPlus className="h-4 w-4" aria-hidden />
          สร้างโฟลเดอร์
        </button>
      ) : (
        <p className="mt-4 rounded-lg border border-line bg-[var(--s2-surface-soft)] px-3 py-2 text-[11.5px] text-navy-500">
          บัญชีของคุณไม่มีสิทธิ์สร้างโฟลเดอร์ในตำแหน่งนี้
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-t border-line pt-3">
        <span className="s2-section-title">ฟีเจอร์ถัดไป</span>
        {NEXT_FEATURES.map((item) => (
          <span key={item.label} className="inline-flex items-center gap-1 text-[11px] text-navy-300">
            <item.icon className="h-3.5 w-3.5" aria-hidden />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}
