import { Camera, CloudOff, FileUp, ImageUp } from 'lucide-react';
import { Sheet, SheetItem } from '@/components/ui/Sheet';
import { useConnectivity } from '@/hooks/useConnectivity';
import { UPLOAD_EVENTS } from '@/lib/upload-inputs';

/**
 * ตัวเลือกการอัปโหลดบนมือถือ (F24-D)
 *
 * **ทำไมต้องแยกเป็นสามทาง:** บนโทรศัพท์ ตัวเลือกไฟล์แบบธรรมดาเปิดเข้าไปที่คลังไฟล์
 * ของเครื่อง ซึ่งไม่ใช่ที่ที่รูปถ่ายอยู่ในความรู้สึกของผู้ใช้ และไม่มีทางไปถึงกล้องเลย
 * การบอกเบราว์เซอร์ว่าเราต้องการอะไร ทำให้มันเปิดตัวเลือกที่ถูกต้องให้ตั้งแต่แรก
 *
 * **ไม่รับประกันว่าทุกเครื่องทำเหมือนกัน** accept และ capture เป็นคำใบ้ ไม่ใช่คำสั่ง
 * iOS กับ Android ตีความต่างกัน และเบราว์เซอร์บนเดสก์ท็อปมักไม่สนใจ capture เลย
 * ทุกทางจึงลงเอยที่คิวอัปโหลดเดิมเสมอ ไม่ว่าเบราว์เซอร์จะเลือกให้ผู้ใช้อย่างไร
 */
export function MobileUploadSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { online } = useConnectivity();

  const pick = (event: string) => {
    onClose();
    window.dispatchEvent(new Event(event));
  };

  return (
    <Sheet open={open} title="อัปโหลด" onClose={onClose}>
      {online ? null : (
        <p className="mx-1 mb-2 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-amber-900">
          <CloudOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <span className="block font-semibold">ขณะนี้ออฟไลน์</span>
            การอัปโหลดต้องเชื่อมต่ออินเทอร์เน็ต ระบบไม่เก็บไฟล์ไว้ส่งให้ภายหลัง
          </span>
        </p>
      )}

      <SheetItem
        icon={<FileUp className="h-4 w-4" />}
        label="เลือกไฟล์"
        hint="เอกสารจากเครื่องของคุณ"
        disabled={!online}
        onSelect={() => pick(UPLOAD_EVENTS.file)}
      />
      <SheetItem
        icon={<ImageUp className="h-4 w-4" />}
        label="เลือกรูปภาพ"
        hint="จากคลังภาพ"
        disabled={!online}
        onSelect={() => pick(UPLOAD_EVENTS.photo)}
      />
      <SheetItem
        icon={<Camera className="h-4 w-4" />}
        label="ถ่ายเอกสาร"
        hint="เปิดกล้องของเครื่อง"
        disabled={!online}
        onSelect={() => pick(UPLOAD_EVENTS.camera)}
      />
    </Sheet>
  );
}
