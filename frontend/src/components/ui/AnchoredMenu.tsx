import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/**
 * เมนูที่ยึดตำแหน่งกับปุ่ม แต่ถูก render ที่ document.body
 *
 * เหตุผลที่ต้องใช้ portal: header ใช้ backdrop-filter ซึ่งบังคับให้เบราว์เซอร์
 * สร้าง compositing layer แยก เมนูที่เป็นลูกของ header จึงถูกวาดทับด้วยปุ่มบนหน้า
 * ที่มี transition/transform ได้ ทั้งที่ลำดับ z-index ถูกต้องแล้ว
 * การย้ายออกมาไว้นอก header ทำให้ไม่ต้องพึ่งพา stacking context ของ ancestor อีกต่อไป
 */
export function AnchoredMenu({
  anchorRef,
  open,
  onClose,
  width = 236,
  /** ระยะห่างจากขอบล่างของ header หรือของปุ่ม แล้วแต่ว่าอันไหนต่ำกว่า */
  offset = 11,
  label,
  children,
  className,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  width?: number;
  offset?: number;
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();

      // ถ้าปุ่มอยู่ใน header ให้เริ่มนับจากขอบล่างของ header เพื่อให้ทุกเมนูเรียงระดับเดียวกัน
      const bar = anchor.closest('header');
      const baseline = Math.max(rect.bottom, bar?.getBoundingClientRect().bottom ?? rect.bottom);

      const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
      setPosition({ top: baseline + offset, left });
    };

    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchorRef, width, offset]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose, anchorRef]);

  if (!open || !position) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      className={cn('s2-menu fixed z-[var(--z-menu)]', className)}
      style={{ top: position.top, left: position.left, width, maxWidth: 'calc(100vw - 16px)' }}
    >
      {children}
    </div>,
    document.body,
  );
}
