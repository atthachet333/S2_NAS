import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * แผ่นเลื่อนขึ้นจากขอบล่าง (F24-C)
 *
 * **ทำไมไม่ใช้เมนูคลิกขวาเดิมบนมือถือ:** เมนูแบบลอยต้องมีจุดยึดและพื้นที่ว่างรอบตัว
 * บนจอ 375px เมนูจะชนขอบจนต้องเลื่อนตำแหน่งเอง และรายการเมนูขนาดเดสก์ท็อป
 * เล็กเกินกว่าจะแตะถูกด้วยนิ้ว แผ่นล่างให้ทั้งความกว้างเต็มจอและระยะที่นิ้วเอื้อมถึงง่าย
 *
 * **การจัดการโฟกัส:** ดักโฟกัสไว้ในแผ่น และคืนโฟกัสกลับที่เดิมเมื่อปิด
 * มิฉะนั้นผู้ใช้คีย์บอร์ดจะหลุดไปอยู่หลังฉากบังโดยไม่รู้ตัว
 */
export function Sheet({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  /** ชื่อของแผ่น - ใช้เป็นทั้งหัวเรื่องที่มองเห็นและชื่อสำหรับตัวอ่านหน้าจอ */
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // การดักโฟกัสต้องมี DOM จริง สภาพแวดล้อมที่ไม่มีก็ยังเรนเดอร์เนื้อหาได้ตามปกติ
    if (typeof document === 'undefined') return;
    restoreFocusTo.current = (document.activeElement as HTMLElement | null) ?? null;

    const panel = panelRef.current;
    // ย้ายโฟกัสเข้ามาในแผ่น เพื่อให้ Escape และการไล่ Tab ทำงานกับแผ่นทันที
    panel?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      restoreFocusTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[var(--z-dialog)] flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="ปิด"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-[var(--s2-overlay)] backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative flex max-h-[85vh] w-full flex-col rounded-t-2xl border border-[var(--s2-card-border)] bg-[var(--s2-elevated)] shadow-pop outline-none sm:max-w-md sm:rounded-2xl"
        // เผื่อพื้นที่ให้แถบบ้านของเครื่อง ไม่ให้ปุ่มล่างสุดอยู่ใต้มัน
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          {/* แถบจับด้านบนบอกใบ้ว่านี่คือแผ่นที่ปิดได้ ไม่ใช่หน้าใหม่ */}
          <span className="absolute left-1/2 top-1.5 h-1 w-10 -translate-x-1/2 rounded-full bg-[var(--s2-border-strong)] sm:hidden" aria-hidden />
          <h2 className="min-w-0 truncate text-[14px] font-semibold text-navy-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-navy-400 transition-colors hover:bg-navy-50 hover:text-navy-700"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">{children}</div>

        {footer ? <div className="border-t border-line px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

/**
 * รายการหนึ่งบรรทัดในแผ่น - สูงพอให้แตะถูกด้วยนิ้ว
 *
 * 44px คือขนาดที่เล็กที่สุดที่ยังแตะได้แม่นยำโดยไม่ต้องเล็ง ซึ่งเป็นเกณฑ์ที่
 * ทั้ง Apple และ Google ใช้ตรงกัน ปุ่มขนาดเดสก์ท็อปราว 24px ต้องเล็งทุกครั้ง
 */
export function SheetItem({
  icon,
  label,
  hint,
  onSelect,
  disabled = false,
  tone = 'default',
}: {
  icon?: ReactNode;
  label: string;
  hint?: string;
  onSelect: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`flex min-h-[48px] w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        tone === 'danger'
          ? 'text-rose-700 hover:bg-rose-50'
          : 'text-navy-800 hover:bg-[var(--s2-surface-soft)]'
      }`}
    >
      {icon ? <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden>{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint ? <span className="block truncate text-[11.5px] text-navy-400">{hint}</span> : null}
      </span>
    </button>
  );
}
