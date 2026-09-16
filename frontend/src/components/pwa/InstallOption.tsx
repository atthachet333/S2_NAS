import { useState } from 'react';
import { Check, Download, Share } from 'lucide-react';
import { Sheet, SheetItem } from '@/components/ui/Sheet';
import { useInstallPrompt } from '@/hooks/useInstallPrompt';

/**
 * ทางเข้าการติดตั้งแอป (F24-J)
 *
 * **อยู่ในเมนู "เพิ่มเติม" ไม่ใช่ในแถบนำทาง** แถบล่างมีห้าช่องและทุกช่องเป็นสิ่งที่
 * ผู้ใช้ทำทุกวัน การติดตั้งเป็นสิ่งที่ทำครั้งเดียวในชีวิตของอุปกรณ์หนึ่งเครื่อง
 * จึงไม่คุ้มกับพื้นที่ถาวรที่แย่งมาจากงานประจำวัน
 *
 * **บน iOS ไม่มีปุ่มติดตั้ง** เพราะกดแล้วจะไม่มีอะไรเกิดขึ้นจริง ๆ
 * แสดงวิธีทำด้วยมือแทน ซึ่งเป็นสิ่งเดียวที่ทำได้จริงบนระบบนั้น
 */
export function InstallOption({ onDone }: { onDone?: () => void }) {
  const install = useInstallPrompt();
  const [iosGuideOpen, setIosGuideOpen] = useState(false);
  const [result, setResult] = useState<'accepted' | 'dismissed' | 'unavailable' | null>(null);

  // ติดตั้งไปแล้ว หรือเบราว์เซอร์นี้ทำไม่ได้ - ไม่มีอะไรให้เสนอ
  if (install.capability === 'INSTALLED' || install.capability === 'UNSUPPORTED') return null;

  if (install.capability === 'MANUAL_ONLY') {
    return (
      <>
        <SheetItem
          icon={<Share className="h-4 w-4" />}
          label="เพิ่ม S2 NAS ไปยังหน้าจอโฮม"
          hint="เปิดใช้งานเหมือนแอปบนเครื่อง"
          onSelect={() => setIosGuideOpen(true)}
        />
        <Sheet open={iosGuideOpen} title="เพิ่มไปยังหน้าจอโฮม" onClose={() => setIosGuideOpen(false)}>
          <ol className="space-y-2.5 px-3 py-2 text-[13px] leading-relaxed text-navy-700">
            <li className="flex gap-2">
              <span className="font-semibold text-brand-700">1.</span>
              <span>แตะปุ่มแชร์ <Share className="inline h-4 w-4 align-text-bottom" aria-hidden /> ที่แถบล่างของ Safari</span>
            </li>
            <li className="flex gap-2">
              <span className="font-semibold text-brand-700">2.</span>
              <span>เลื่อนลงแล้วเลือก “เพิ่มไปยังหน้าจอโฮม”</span>
            </li>
            <li className="flex gap-2">
              <span className="font-semibold text-brand-700">3.</span>
              <span>แตะ “เพิ่ม” ที่มุมขวาบน</span>
            </li>
          </ol>
          {/* บอกตามตรงว่าเราสั่งให้เองไม่ได้ ผู้ใช้จะได้ไม่รอปุ่มที่ไม่มีอยู่ */}
          <p className="px-3 pb-2 text-[11.5px] text-navy-400">
            Safari ไม่เปิดให้เว็บสั่งติดตั้งเองได้ จึงต้องทำสามขั้นตอนนี้ด้วยตนเอง
          </p>
        </Sheet>
      </>
    );
  }

  return (
    <SheetItem
      icon={result === 'accepted' ? <Check className="h-4 w-4" /> : <Download className="h-4 w-4" />}
      label={result === 'accepted' ? 'กำลังติดตั้ง S2 NAS' : 'ติดตั้ง S2 NAS'}
      hint={result === 'dismissed' ? 'ยกเลิกไปเมื่อสักครู่ · แตะเพื่อลองใหม่' : 'เปิดใช้งานเหมือนแอปบนเครื่อง'}
      onSelect={() => {
        void install.promptInstall().then((outcome) => {
          setResult(outcome);
          // ผู้ใช้ปฏิเสธกล่องของระบบ ถือเป็นการปิดคำเชิญ จะได้ไม่ถูกตื๊ออีก
          if (outcome === 'dismissed') install.dismiss();
          if (outcome === 'accepted') onDone?.();
        });
      }}
    />
  );
}
