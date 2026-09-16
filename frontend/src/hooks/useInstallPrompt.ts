import { useCallback, useEffect, useState } from 'react';
import {
  INSTALL_DISMISSED_KEY, installCapability, readDismissedAt, type InstallCapability,
} from '@/lib/install-prompt';
import {
  hasInstallPrompt, runInstallPrompt, subscribeToInstallPrompt, wasInstalledThisSession,
} from '@/lib/install-prompt-store';

/**
 * การติดตั้งแอปบนอุปกรณ์ของผู้ใช้ (F24-J)
 *
 * **สิ่งที่เบราว์เซอร์ยอมให้ทำจริง:** Chromium ยิง beforeinstallprompt มาให้ครั้งเดียว
 * ตอนโหลดหน้า เราเก็บไว้ในที่เก็บระดับโมดูล (ดู install-prompt-store) แล้วค่อยเรียกใช้
 * ตอนผู้ใช้กด ส่วน iOS ไม่มีเหตุการณ์นี้เลย และ **สั่งติดตั้งจากโค้ดไม่ได้**
 * จึงห้ามทำปุ่มที่ดูเหมือนติดตั้งได้บน iOS เพราะกดแล้วจะไม่มีอะไรเกิดขึ้น
 */
export interface InstallState {
  capability: InstallCapability;
  /** สั่งเปิดกล่องติดตั้งของเบราว์เซอร์ - ใช้ได้เฉพาะเมื่อ capability เป็น PROMPTABLE */
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
  /** ปิดคำเชิญและจำไว้ว่าเคยปิด */
  dismiss: () => void;
  /** เวลาที่เคยปิดคำเชิญ - ใช้ตัดสินว่าจะเชิญอีกเมื่อไร */
  dismissedAt: number | null;
}

/** ตรวจว่ากำลังเปิดจากไอคอนที่ติดตั้งไว้หรือไม่ */
function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) return true;
  // Safari บน iOS ใช้คุณสมบัติของตัวเองแทน display-mode
  return (window.navigator as { standalone?: boolean } | undefined)?.standalone === true;
}

function detectIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent ?? '');
}

export function useInstallPrompt(): InstallState {
  const [, forceUpdate] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  useEffect(() => {
    try {
      setDismissedAt(readDismissedAt(window.localStorage.getItem(INSTALL_DISMISSED_KEY)));
    } catch {
      /* โหมดส่วนตัวอาจอ่านไม่ได้ - ถือว่าไม่เคยปิด */
    }
    // ที่เก็บระดับโมดูลรับเหตุการณ์ไว้ตั้งแต่แอปเริ่ม ตรงนี้แค่ขอให้บอกเมื่อมีการเปลี่ยนแปลง
    return subscribeToInstallPrompt(() => forceUpdate((value) => value + 1));
  }, []);

  const promptInstall = useCallback(() => runInstallPrompt(), []);

  const dismiss = useCallback(() => {
    const now = Date.now();
    setDismissedAt(now);
    try {
      window.localStorage.setItem(INSTALL_DISMISSED_KEY, String(now));
    } catch {
      /* เขียนไม่ได้ก็ยังปิดได้ในรอบนี้ */
    }
  }, []);

  return {
    capability: installCapability({
      promptCaptured: hasInstallPrompt(),
      standalone: detectStandalone() || wasInstalledThisSession(),
      ios: detectIos(),
    }),
    promptInstall,
    dismiss,
    dismissedAt,
  };
}
