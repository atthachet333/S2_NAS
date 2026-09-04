import type { UploadItem, UploadState } from '@/hooks/uploadQueueContext';

/**
 * นโยบายการเก็บกวาดคิวอัปโหลด
 *
 * แยกออกมาจากคอมโพเนนต์เพราะเป็นข้อตกลงเชิงพฤติกรรม ไม่ใช่เรื่องการจัดวาง
 * และต้องพิสูจน์ได้ด้วยเวลาจำลอง ไม่ต้องรอจริง 15 วินาที
 */

/** อายุของแถวที่อัปโหลดสำเร็จ นับจากเวลาที่สำเร็จของแถวนั้นเอง */
export const UPLOAD_SUCCESS_AUTO_DISMISS_MS = 15_000;

/** ความถี่ในการกวาด - ละเอียดพอให้รู้สึกตรงเวลา แต่ไม่ถี่จนเปลืองโดยเปล่าประโยชน์ */
export const UPLOAD_SWEEP_INTERVAL_MS = 1_000;

/**
 * มีเพียงสถานะเดียวที่หายเองได้
 *
 * QUEUED/UPLOADING ยังทำงานอยู่, FAILED ต้องให้ผู้ใช้เห็นเพื่อกดลองใหม่,
 * NEEDS_DECISION รอการตัดสินใจเรื่องไฟล์ซ้ำ/ชื่อซ้ำ, CANCELLED เป็นผลลัพธ์ที่ผู้ใช้ต้องรับรู้
 * ทั้งหมดนี้หายเองไม่ได้ เพราะการหายไปเงียบ ๆ คือการกลืนข้อมูลที่ผู้ใช้ต้องใช้ตัดสินใจ
 */
export function autoDismissable(state: UploadState): boolean {
  return state === 'SUCCESS';
}

type SweepCandidate = Pick<UploadItem, 'id' | 'state'> & { succeededAt?: number };

/**
 * แถวที่หมดอายุแล้ว ณ เวลาหนึ่ง
 *
 * แต่ละแถวนับอายุจาก succeededAt ของตัวเอง ไฟล์ที่เสร็จก่อนจึงหายก่อนเสมอ
 * ไม่ใช่ล้างทั้งกลุ่มตามแถวที่เสร็จล่าสุดหรือเก่าสุด
 */
export function expiredUploadIds(
  items: SweepCandidate[],
  now: number,
  delay: number = UPLOAD_SUCCESS_AUTO_DISMISS_MS,
): string[] {
  return items
    .filter(
      (item) =>
        autoDismissable(item.state) &&
        typeof item.succeededAt === 'number' &&
        now - item.succeededAt >= delay,
    )
    .map((item) => item.id);
}

/**
 * ผลของการกวาดหนึ่งรอบ
 *
 * รวมการตัดสินใจทั้งหมดไว้ที่เดียวเพื่อให้พิสูจน์ได้โดยไม่ต้องประกอบ React ขึ้นมาทั้งชุด
 */
export interface SweepResult<T extends SweepCandidate> {
  remaining: T[];
  dismissed: string[];
  /** ไม่เหลือรายการใดเลย = ไม่ควรมีแผงลอยว่าง ๆ ค้างอยู่บนหน้าจอ */
  shouldClosePanel: boolean;
}

export function sweepUploadQueue<T extends SweepCandidate>(
  items: T[],
  now: number,
  focusedId: string | null = null,
  delay: number = UPLOAD_SUCCESS_AUTO_DISMISS_MS,
): SweepResult<T> {
  const dismissed = withoutFocusedRow(expiredUploadIds(items, now, delay), focusedId);
  if (dismissed.length === 0) {
    return { remaining: items, dismissed, shouldClosePanel: false };
  }
  const remaining = items.filter((item) => !dismissed.includes(item.id));
  return { remaining, dismissed, shouldClosePanel: remaining.length === 0 };
}

/**
 * แถวที่กำลังถูกโฟกัสอยู่ต้องไม่ถูกลบทิ้งใต้มือผู้ใช้
 *
 * ถ้าลบไปตอนนั้น โฟกัสจะตกลงไปที่ document.body ผู้ใช้คีย์บอร์ดจะหลุดบริบททันที
 * จึงเลื่อนการลบแถวนั้นออกไปจนกว่าโฟกัสจะย้ายออก ส่วนแถวอื่นยังหายตามกำหนดปกติ
 */
export function withoutFocusedRow(ids: string[], focusedId: string | null | undefined): string[] {
  return focusedId ? ids.filter((id) => id !== focusedId) : ids;
}
