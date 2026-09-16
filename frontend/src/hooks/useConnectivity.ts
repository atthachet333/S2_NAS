import { useEffect, useRef, useState } from 'react';

/**
 * สถานะการเชื่อมต่อของเบราว์เซอร์ (F24-B)
 *
 * **ขอบเขตของสิ่งที่รู้ได้จริง:** navigator.onLine บอกได้อย่างเดียวว่าเครื่องมีเส้นทาง
 * ออกสู่เครือข่ายหรือไม่ มันเป็นจริงได้ทั้งที่ Wi-Fi ต่ออยู่กับเราเตอร์ที่ไม่มีอินเทอร์เน็ต
 * หรือเซิร์ฟเวอร์ของเราล่ม **จึงห้ามใช้ค่านี้สรุปว่าเซิร์ฟเวอร์ทำงานอยู่**
 *
 * ค่าเท็จเชื่อถือได้มากกว่าค่าจริง: ถ้าเบราว์เซอร์บอกว่าออฟไลน์ ก็ออฟไลน์แน่
 * เราจึงใช้มันเพื่อ "ปิด" การกระทำที่ต้องมีเซิร์ฟเวอร์เท่านั้น ไม่ใช้เพื่อ "รับรอง" ว่าพร้อม
 * การตรวจสุขภาพเซิร์ฟเวอร์จริงเป็นคนละเรื่องและมีที่ทางของมันอยู่แล้ว (ServerStatus)
 */
export interface ConnectivityState {
  /** เบราว์เซอร์เชื่อว่ามีเส้นทางออกเครือข่าย - ไม่ได้แปลว่าเซิร์ฟเวอร์พร้อม */
  online: boolean;
  /** เพิ่งกลับมาเชื่อมต่อได้หลังจากหลุดไป - ใช้แสดงข้อความยืนยันชั่วคราว */
  reconnected: boolean;
}

/** อ่านค่าเริ่มต้นอย่างปลอดภัย - บางสภาพแวดล้อมการทดสอบไม่มี navigator */
export function readOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

export function useConnectivity(): ConnectivityState {
  const [online, setOnline] = useState(readOnline);
  const [reconnected, setReconnected] = useState(false);
  /**
   * จำไว้ว่าเคยหลุดไปจริงหรือไม่
   *
   * ตอนเหตุการณ์ online ถูกยิง navigator.onLine เป็นจริงไปแล้ว จึงใช้ค่านั้น
   * ย้อนดูอดีตไม่ได้ ต้องอาศัยสิ่งที่เราบันทึกไว้เองตอนหลุด
   */
  const wasOffline = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const goOnline = () => {
      setOnline(true);
      if (wasOffline.current) {
        wasOffline.current = false;
        setReconnected(true);
      }
    };
    const goOffline = () => {
      wasOffline.current = true;
      setOnline(false);
      setReconnected(false);
    };

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  useEffect(() => {
    if (!reconnected) return;
    // ข้อความ "กลับมาออนไลน์แล้ว" เป็นการยืนยันชั่วคราว ไม่ใช่สถานะถาวรที่ต้องค้างอยู่
    const timer = window.setTimeout(() => setReconnected(false), 4000);
    return () => window.clearTimeout(timer);
  }, [reconnected]);

  return { online, reconnected };
}
