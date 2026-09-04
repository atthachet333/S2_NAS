import { authorizedFetch } from './api';
import { getPreviewMode } from './file-types';

/**
 * การเปิดดูและบันทึกไฟล์ในพื้นที่ลูกค้า
 *
 * ทุกเส้นทางเนื้อหาต้องแนบ access token ลิงก์ตรงจึงใช้ไม่ได้
 * (refresh cookie ผูกกับ /api/auth เท่านั้น และ endpoint เนื้อหาไม่รับ cookie)
 * ที่นี่จึงดึงเป็น blob ก่อนเสมอ แล้วค่อยเปิดหรือบันทึก
 */

/** เปิดดูในแท็บใหม่ - ใช้กับ PDF รูปภาพ และข้อความที่เบราว์เซอร์แสดงได้เอง */
export async function openPortalBlob(url: string): Promise<void> {
  const response = await authorizedFetch(url);
  if (!response.ok) throw new Error(String(response.status));
  const objectUrl = URL.createObjectURL(await response.blob());
  window.open(objectUrl, '_blank', 'noopener,noreferrer');
  /**
   * ปล่อย URL คืนหลังเบราว์เซอร์เปิดแท็บแล้ว
   * การปล่อยทันทีทำให้แท็บใหม่เปิดไม่ทันในบางเบราว์เซอร์
   */
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

/** บันทึกลงเครื่อง */
export function savePortalBlob(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

/**
 * เอกสารชนิดนี้แสดงตัวอย่างในเบราว์เซอร์ได้หรือไม่
 *
 * ใช้ตัวจำแนกชุดเดียวกับฝั่งภายใน เพื่อไม่ให้เกิดสองคำตอบสำหรับไฟล์ชนิดเดียวกัน
 */
export function canPreviewInBrowser(name: string, mimeType?: string | null): boolean {
  return getPreviewMode(name, mimeType) !== 'NONE';
}

/**
 * ข้อความเมื่อเปิดตัวอย่างไม่ได้
 *
 * บอกทางออกก็ต่อเมื่อทางออกนั้นมีอยู่จริง - การบอกให้ดาวน์โหลดทั้งที่ดาวน์โหลดไม่ได้
 * คือการส่งผู้ใช้ไปชนกำแพง
 */
export function unsupportedPreviewMessage(canDownload: boolean): string {
  return canDownload
    ? 'ไม่รองรับการแสดงตัวอย่าง ดาวน์โหลดไฟล์เพื่อเปิดด้วยโปรแกรมที่รองรับ'
    : 'ไม่รองรับการแสดงตัวอย่าง กรุณาติดต่อผู้ดูแลหากต้องการไฟล์นี้';
}
