import { CloudOff } from 'lucide-react';

/**
 * เปลือกแอปตอนออฟไลน์ (F24-B)
 *
 * **ทำไมต้องบอกตรง ๆ ว่าข้อมูลอาจไม่ใช่ปัจจุบัน:** service worker เก็บเฉพาะเปลือกแอป
 * ไม่ได้เก็บข้อมูลเอกสาร สิ่งที่ยังเห็นอยู่บนหน้าจอตอนเน็ตหลุดคือสิ่งที่โหลดไว้ก่อนหน้า
 * ซึ่งอาจถูกคนอื่นแก้ไปแล้ว การปล่อยให้หน้าจอดูเหมือนทำงานปกติจะทำให้ผู้ใช้ตัดสินใจ
 * บนข้อมูลเก่าโดยไม่รู้ตัว ซึ่งอันตรายกว่าการบอกว่าตอนนี้ยืนยันอะไรไม่ได้
 */
export function OfflineNotice() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="s2-resource-card flex items-start gap-3 border-amber-300 bg-amber-50 px-4 py-3 text-amber-900"
    >
      <CloudOff className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <p className="min-w-0 text-[13px] leading-relaxed">
        <span className="block font-semibold">ขณะนี้ออฟไลน์</span>
        <span className="block">ข้อมูลเอกสารต้องเชื่อมต่ออินเทอร์เน็ตเพื่อดูข้อมูลล่าสุด</span>
      </p>
    </div>
  );
}
