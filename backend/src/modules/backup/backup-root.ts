import fsp from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';

/**
 * ความพร้อมของรากชุดสำรอง
 *
 * ตรวจตอน start เพื่อไม่ให้เปิดตัวจับเวลาที่จะล้มเหลวทุกคืนโดยไม่มีใครรู้
 * env.ts ตรวจแล้วว่าเส้นทางไม่ซ้อนกับ storage - ตรงนี้ตรวจว่าเขียนได้จริง
 */
export async function verifyBackupRoot(): Promise<{ writable: boolean; reason?: string }> {
  try {
    await fsp.mkdir(env.BACKUP_ROOT, { recursive: true });
    const probe = path.join(env.BACKUP_ROOT, '.write-probe');
    await fsp.writeFile(probe, 'ok');
    await fsp.rm(probe, { force: true });
    return { writable: true };
  } catch {
    // ไม่ส่ง path จริงออกไป - ผู้เรียกใช้แค่รู้ว่าพร้อมหรือไม่
    return { writable: false, reason: 'เขียนลงรากของชุดสำรองไม่ได้' };
  }
}
