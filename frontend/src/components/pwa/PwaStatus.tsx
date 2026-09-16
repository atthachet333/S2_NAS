import { CloudOff, RefreshCw, Wifi } from 'lucide-react';
import { useConnectivity } from '@/hooks/useConnectivity';
import { usePwaUpdate } from '@/hooks/usePwaUpdate';
import { UPDATE_ACTION_TEXT } from '@/lib/pwa-update';

/**
 * แถบสถานะของแอปที่ติดตั้งได้ (F24-B)
 *
 * รวมสองเรื่องที่ต้องแย่งพื้นที่เดียวกันไว้ที่เดียว: การเชื่อมต่อ และเวอร์ชันใหม่
 * ถ้าแยกเป็นสองคอมโพเนนต์ที่ลอยอยู่คนละที่ ทั้งคู่จะโผล่พร้อมกันตอนเน็ตกลับมา
 * แล้วบังเนื้อหาซ้อนกัน ที่เดียวจึงตัดสินลำดับความสำคัญได้
 *
 * วางไว้ล่างจอเพราะบนมือถือนิ้วอยู่ใกล้ขอบล่าง และแถบบนถูกใช้เป็นหัวเรื่องอยู่แล้ว
 */
export function PwaStatus() {
  const { online, reconnected } = useConnectivity();
  const update = usePwaUpdate();

  // ออฟไลน์สำคัญกว่าเรื่องเวอร์ชันเสมอ - อัปเดตตอนไม่มีเน็ตทำไม่ได้อยู่แล้ว
  if (!online) {
    return (
      <Bar tone="warn">
        <CloudOff className="h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0">ออฟไลน์</span>
      </Bar>
    );
  }

  if (reconnected) {
    return (
      <Bar tone="ok">
        <Wifi className="h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0">กลับมาออนไลน์แล้ว</span>
      </Bar>
    );
  }

  if (!update.updateAvailable) return null;

  return (
    <Bar tone="info">
      <RefreshCw className={`h-4 w-4 shrink-0 ${update.pendingActivation ? 'animate-spin' : ''}`} aria-hidden />
      <span className="min-w-0 flex-1">{update.readiness.message}</span>
      {update.pendingActivation ? null : (
        <>
          <button
            type="button"
            onClick={update.applyUpdate}
            className="s2-btn s2-btn-primary min-h-[38px] shrink-0 px-3 py-1.5 text-[12.5px]"
          >
            {UPDATE_ACTION_TEXT}
          </button>
          <button
            type="button"
            onClick={update.dismiss}
            aria-label="ปิดการแจ้งเวอร์ชันใหม่"
            className="s2-btn s2-btn-ghost min-h-[38px] shrink-0 px-2 py-1.5 text-[12.5px]"
          >
            ไว้ก่อน
          </button>
        </>
      )}
    </Bar>
  );
}

const TONE = {
  warn: 'border-amber-300 bg-amber-50 text-amber-900',
  ok: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  info: 'border-[var(--s2-primary-border)] bg-[var(--s2-primary-soft)] text-navy-900',
} as const;

function Bar({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  return (
    <div
      // ประกาศแบบสุภาพ ไม่แย่งโฟกัสจากสิ่งที่ผู้ใช้กำลังทำอยู่
      role="status"
      aria-live="polite"
      className={`pointer-events-auto fixed inset-x-3 bottom-3 z-[var(--z-toast)] mx-auto flex max-w-lg items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] shadow-pop ${TONE[tone]}`}
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
    >
      {children}
    </div>
  );
}
