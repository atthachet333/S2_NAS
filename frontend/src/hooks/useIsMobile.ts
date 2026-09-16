import { useEffect, useState } from 'react';

/**
 * ขนาดหน้าจอระดับโทรศัพท์ (F24-C)
 *
 * **ทำไมต้องถามด้วย JavaScript ทั้งที่มี CSS:** บางกรณีต้องเรนเดอร์ "คนละโครงสร้าง"
 * ไม่ใช่แค่จัดวางต่างกัน เช่น รายการไฟล์บนจอเล็กเป็นการ์ด ส่วนบนจอใหญ่เป็นตาราง
 * ถ้าใช้ CSS ซ่อน/แสดง จะต้องเรนเดอร์ทั้งสองแบบพร้อมกัน ซึ่งหมายถึง DOM สองชุด
 * สำหรับทุกแถวในโฟลเดอร์ที่มีไฟล์เป็นร้อย และตัวอ่านหน้าจอจะเจอรายการซ้ำสองรอบ
 *
 * **จุดตัดที่ 768px** ตรงกับ md ของ Tailwind ที่ระบบใช้อยู่ จึงไม่เกิดช่วงกำกวม
 * ที่ CSS คิดว่าเป็นมือถือแต่ JavaScript คิดว่าไม่ใช่
 */
export const MOBILE_QUERY = '(max-width: 767px)';

/**
 * ความกว้างที่ตารางไฟล์ยังอ่านได้จริง (F24-G)
 *
 * **วัดมาแล้ว ไม่ได้เดา:** ตารางของระบบนี้กว้าง ~1750px เมื่อมีชื่อไฟล์ภาษาไทยยาว ๆ
 * เพราะคอลัมน์ชื่อยืดตามเนื้อหา สัดส่วนที่มองไม่เห็นและต้องเลื่อนแนวนอนไปหาคือ
 * 56% ที่ 768px · 45% ที่ 1024px · 31% ที่ 1280px
 *
 * ที่ 768px ผู้ใช้ iPad แนวตั้งต้องเลื่อนเพื่อดูข้อมูลเกินครึ่งของตาราง ซึ่งแย่กว่า
 * การอ่านการ์ดที่เห็นครบในครั้งเดียว จุดตัดของ "ตารางหรือการ์ด" จึงอยู่ที่ 1024px
 *
 * **แยกจาก MOBILE_QUERY โดยตั้งใจ:** แถบนำทางล่างและแผ่นกระทำเป็นเรื่องของ "โทรศัพท์"
 * ส่วนการเลือกตารางหรือการ์ดเป็นเรื่องของ "ความกว้างพอให้ตารางอ่านออกไหม"
 * หน้าต่างเดสก์ท็อปกว้าง 900px จึงได้การ์ดที่อ่านง่าย โดยไม่ได้แถบนำทางของโทรศัพท์
 */
export const COMPACT_LIST_QUERY = '(max-width: 1023px)';

/** อ่านค่าอย่างปลอดภัย - สภาพแวดล้อมที่ไม่มี matchMedia ให้ถือว่าไม่ใช่มือถือ */
export function readIsMobile(query: string = MOBILE_QUERY): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

/** ติดตามผลของ media query หนึ่งข้อ */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => readIsMobile(query));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
}

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

/** ควรแสดงรายการไฟล์เป็นการ์ดแทนตารางหรือไม่ */
export function useCompactList(): boolean {
  return useMediaQuery(COMPACT_LIST_QUERY);
}
