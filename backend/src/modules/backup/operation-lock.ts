import { AppError } from '../../core/errors.js';

/**
 * ล็อกงานสำรอง/กู้คืน
 *
 * งานเหล่านี้อ่านและเขียนพื้นที่เดียวกันเป็นเวลานาน การปล่อยให้รันซ้อนกัน
 * ทำให้ชุดสำรองที่ได้ไม่ตรงกับ manifest ของตัวเอง ซึ่งแย่กว่าการไม่มีชุดสำรอง
 * เพราะมันดูเหมือนใช้ได้จนกว่าจะถึงวันที่ต้องกู้คืนจริง
 *
 * ตัวนี้เป็น "ด่านเร็ว" ภายใน process เท่านั้น ด่านที่มีอำนาจตัดสินจริงคือ
 * advisory lock ของ MariaDB (distributed-lock.ts) ซึ่งกันได้ข้ามอินสแตนซ์
 *
 * เก็บด่านเร็วไว้เพราะตอบคำขอที่ชนกันภายในเครื่องเดียวกันได้ทันทีโดยไม่ต้องคุยกับฐานข้อมูล
 * แต่ห้ามพึ่งมันเพียงลำพัง - process อื่นมองไม่เห็นสถานะนี้เลย
 */
export type BackupOperation = 'BACKUP' | 'RESTORE';

let current: { operation: BackupOperation; startedAt: Date } | null = null;

export function currentOperation(): { operation: BackupOperation; startedAt: Date } | null {
  return current;
}

/**
 * จองสิทธิ์ทำงาน แล้วคืนฟังก์ชันสำหรับปล่อย
 * ผู้เรียกต้องปล่อยใน finally เสมอ มิฉะนั้นงานที่ล้มจะล็อกระบบไว้ถาวร
 */
export function acquireOperationLock(operation: BackupOperation): () => void {
  if (current) {
    const code = current.operation === 'BACKUP' ? 'BACKUP_ALREADY_RUNNING' : 'RESTORE_ALREADY_RUNNING';
    const message =
      current.operation === 'BACKUP'
        ? 'มีการสำรองข้อมูลกำลังทำงานอยู่แล้ว'
        : 'มีการเตรียมกู้คืนกำลังทำงานอยู่ กรุณารอให้เสร็จก่อน';
    throw new AppError(code, message, 409);
  }
  const held = { operation, startedAt: new Date() };
  current = held;
  return () => {
    if (current === held) current = null;
  };
}

/** ใช้ในเทสเท่านั้น เพื่อคืนสถานะให้สะอาดระหว่างชุดทดสอบ */
export function resetOperationLock(): void {
  current = null;
}
