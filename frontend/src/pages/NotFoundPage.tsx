import { Link } from 'react-router-dom';
import { FileQuestion } from 'lucide-react';

export default function NotFoundPage() {
  return (
    <div className="s2-surface flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-navy-50 text-navy-300">
        <FileQuestion className="h-6 w-6" aria-hidden />
      </div>
      <p className="text-[17px] font-semibold text-navy-900">ไม่พบหน้าที่ต้องการ</p>
      <p className="max-w-sm text-[13px] leading-relaxed text-navy-400">
        หน้าที่คุณเปิดอาจถูกย้าย หรือยังไม่เปิดใช้งานในระบบ S2 NAS
      </p>
      <Link to="/files" className="s2-btn s2-btn-primary mt-3">
        ไปยังไฟล์ของฉัน
      </Link>
    </div>
  );
}
