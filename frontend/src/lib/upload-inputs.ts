/**
 * คำใบ้ที่บอกเบราว์เซอร์ว่าผู้ใช้ตั้งใจเลือกอะไร (F24-D)
 *
 * **สถานะจริงของ accept และ capture:** ทั้งคู่เป็นคำใบ้ ไม่ใช่สัญญา
 * - `accept="image/*"` ทำให้ตัวเลือกไฟล์กรองเหลือเฉพาะรูป แต่ผู้ใช้ยังเลือกอย่างอื่นได้
 *   บนบางเครื่อง และเซิร์ฟเวอร์ยังต้องตรวจชนิดไฟล์เองเสมอ
 * - `capture="environment"` ขอกล้องหลัง Android ส่วนใหญ่เปิดกล้องให้ทันที
 *   iOS มักให้เลือกระหว่างกล้องกับคลังภาพ และเดสก์ท็อปมักไม่สนใจเลย
 *
 * **จึงห้ามสร้างหน้าจอที่พังถ้าคำใบ้ไม่เป็นผล** ทุกทางจบที่ input type=file เหมือนกัน
 * และลงเอยที่คิวอัปโหลดเดิม ต่างกันแค่ตัวเลือกที่เบราว์เซอร์หยิบมาให้ผู้ใช้ก่อน
 */

export type UploadIntent = 'file' | 'photo' | 'camera';

export interface UploadInputAttributes {
  /** ชนิดไฟล์ที่ต้องการให้ตัวเลือกกรองให้ - ไม่ใส่แปลว่ารับทุกชนิด */
  accept?: string;
  /** ขอให้เปิดกล้องโดยตรง - รองรับไม่เท่ากันในแต่ละระบบปฏิบัติการ */
  capture?: 'environment' | 'user';
  /** เลือกได้หลายไฟล์พร้อมกันหรือไม่ */
  multiple: boolean;
}

/** ชื่อเหตุการณ์ที่ใช้สั่งเปิดตัวเลือกไฟล์ข้ามคอมโพเนนต์ */
export const UPLOAD_EVENTS = {
  file: 's2-upload-file',
  photo: 's2-upload-photo',
  camera: 's2-upload-camera',
  folder: 's2-upload-folder',
} as const;

export function uploadInputAttributes(intent: UploadIntent): UploadInputAttributes {
  switch (intent) {
    case 'photo':
      return { accept: 'image/*', multiple: true };
    case 'camera':
      /**
       * ถ่ายได้ทีละภาพ
       *
       * กล้องของเบราว์เซอร์คืนภาพเดียวต่อการเปิดหนึ่งครั้งอยู่แล้ว การประกาศ multiple
       * จะสร้างความคาดหวังว่าถ่ายรัวได้ ซึ่งไม่มีเบราว์เซอร์ไหนทำให้
       */
      return { accept: 'image/*', capture: 'environment', multiple: false };
    case 'file':
    default:
      return { multiple: true };
  }
}

/**
 * ไฟล์นี้ใหญ่เกินกว่าที่เซิร์ฟเวอร์รับหรือไม่
 *
 * **ตรวจจากข้อมูลกำกับ ไม่ใช่จากเนื้อไฟล์** ขนาดของ File รู้ได้จากระบบไฟล์ทันที
 * โดยไม่ต้องอ่านเนื้อหาเข้าหน่วยความจำ การอ่านไฟล์ 500 MB เข้ามาเพื่อวัดขนาด
 * จะทำให้แท็บบนมือถือถูกปิดเพราะใช้หน่วยความจำเกิน ก่อนจะได้บอกผู้ใช้ด้วยซ้ำ
 */
export function exceedsUploadLimit(fileSize: number, limitBytes: number): boolean {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return false;
  return fileSize > limitBytes;
}

/** ข้อความบอกขีดจำกัดที่อ่านเข้าใจได้ ไม่ใช่จำนวนไบต์ดิบ */
export function uploadLimitMessage(limitBytes: number): string {
  const megabytes = limitBytes / (1024 * 1024);
  const readable = megabytes >= 1024
    ? `${(megabytes / 1024).toFixed(megabytes % 1024 === 0 ? 0 : 1)} GB`
    : `${Math.round(megabytes)} MB`;
  return `ไฟล์ใหญ่เกินกว่าที่ระบบรับได้ (สูงสุด ${readable})`;
}
