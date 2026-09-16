import { useCallback, useEffect, useRef, useState } from 'react';
import { useUploadQueue } from './useUploadQueue';
import { evaluateUpdateReadiness, shouldActivateNow, type UpdateReadiness } from '@/lib/pwa-update';

/**
 * วงจรชีวิตของ service worker และการอัปเดตแอป (F24-B)
 *
 * **การลงทะเบียนต้องล้มเหลวได้โดยไม่ทำให้แอปพัง** service worker เป็นส่วนเสริม
 * ไม่ใช่เงื่อนไขของการทำงาน เบราว์เซอร์ที่ปิดไว้ โหมดส่วนตัวบางตัว หรือการเปิดผ่าน
 * http ที่ไม่ใช่ localhost จะลงทะเบียนไม่ได้เลย ทุกกรณีเหล่านั้นแอปต้องใช้งานได้ตามปกติ
 *
 * **ไม่โหลดหน้าใหม่ขณะกำลังอัปโหลด** เวอร์ชันใหม่มีผลก็ต่อเมื่อโหลดหน้าใหม่ ซึ่งจะทำให้
 * ไฟล์ที่ส่งไปได้ครึ่งทางหายไปทั้งหมด ถ้าผู้ใช้กดอัปเดตระหว่างอัปโหลด ระบบจะจำเจตนาไว้
 * แล้วทำให้เองเมื่ออัปโหลดจบ ผู้ใช้ไม่ต้องกลับมากดซ้ำ
 */
export interface PwaUpdateState {
  /** มีเวอร์ชันใหม่รออยู่ */
  updateAvailable: boolean;
  /** ผู้ใช้กดขออัปเดตแล้ว แต่ยังทำไม่ได้เพราะมีงานค้าง */
  pendingActivation: boolean;
  /** ตอนนี้เปลี่ยนเวอร์ชันได้หรือยัง พร้อมเหตุผลถ้ายังไม่ได้ */
  readiness: UpdateReadiness;
  /** ขอเปลี่ยนไปใช้เวอร์ชันใหม่ - จะทำทันทีถ้าปลอดภัย มิฉะนั้นรอจนปลอดภัย */
  applyUpdate: () => void;
  /** ปิดคำเชิญไว้ก่อน โดยไม่อัปเดต */
  dismiss: () => void;
}

export function usePwaUpdate(): PwaUpdateState {
  const { activeCount } = useUploadQueue();
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [userRequested, setUserRequested] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  /** ฟังก์ชันที่ vite-plugin-pwa คืนมาสำหรับสั่งให้เวอร์ชันใหม่มีผล */
  const activate = useRef<((reload?: boolean) => Promise<void>) | null>(null);

  useEffect(() => {
    let cancelled = false;

    // นำเข้าแบบไดนามิกเพื่อให้แอปยังรันได้แม้โมดูลเสมือนของ PWA ไม่มีอยู่
    void import('virtual:pwa-register')
      .then(({ registerSW }) => {
        if (cancelled) return;
        activate.current = registerSW({
          immediate: true,
          onNeedRefresh() {
            if (!cancelled) setUpdateAvailable(true);
          },
          onRegisterError(error: unknown) {
            // ลงทะเบียนไม่สำเร็จไม่ใช่เรื่องที่ผู้ใช้ต้องรับรู้ แอปทำงานต่อได้ตามปกติ
            console.warn('[PWA] ลงทะเบียน service worker ไม่สำเร็จ', error);
          },
        });
      })
      .catch((error: unknown) => {
        console.warn('[PWA] ไม่มีการรองรับ service worker ในสภาพแวดล้อมนี้', error);
      });

    return () => { cancelled = true; };
  }, []);

  const readiness = evaluateUpdateReadiness(activeCount);

  // ผู้ใช้เคยกดขอไว้แล้ว พออัปโหลดจบก็ทำให้เองทันที
  useEffect(() => {
    if (!shouldActivateNow({ updateAvailable, userRequested, activeUploads: activeCount })) return;
    void activate.current?.(true);
  }, [updateAvailable, userRequested, activeCount]);

  const applyUpdate = useCallback(() => {
    setUserRequested(true);
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  return {
    updateAvailable: updateAvailable && !dismissed,
    pendingActivation: userRequested && !readiness.canActivate,
    readiness,
    applyUpdate,
    dismiss,
  };
}
