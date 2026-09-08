import type { GoogleDriveSync, Prisma } from '@prisma/client';
import { env } from '../../../config/env.js';
import { prisma } from '../../../core/prisma.js';
import { logger } from '../../../core/logger.js';
import { googleDriveProvider, isDriveConfigured } from './google-api.js';
import { credentialCipherReady } from '../integration-crypto.js';
import { checkOne } from './sync.service.js';
import type { GoogleDriveProvider } from './provider.js';

/**
 * ตัวทำงานเบื้องหลังของการซิงก์ Google Drive (F19)
 *
 * ใช้รูปแบบเดียวกับตัวสกัดข้อความของ F12: ตั้งเวลาถามฐานข้อมูลว่ามีงานถึงคิวไหม
 * ไม่มี process แยก ไม่มีคิวภายนอก ไม่มีอะไรใหม่ให้ต้องดูแลตอนนำขึ้นระบบจริง
 */

export interface DriveSyncWorker {
  stop(): void;
  runOnce(): Promise<number>;
}

/**
 * จำนวนรายการต่อรอบ
 *
 * รอบหนึ่งไม่ต้องตรวจทุกไฟล์ให้จบ - รอบถัดไปจะมาต่อจากรายการที่ค้างเก่าที่สุดเอง
 * การพยายามตรวจสองพันไฟล์ในรอบเดียวมีแต่จะชนโควตาของ Google
 */
const BATCH_SIZE = 20;

/** ระยะห่างขั้นต่ำก่อนตรวจไฟล์เดิมซ้ำ - กันการวนถามไฟล์เดียวกันรัว ๆ */
function dueBefore(now: Date): Date {
  return new Date(now.getTime() - env.S2_NAS_DRIVE_SYNC_POLL_SECONDS * 1000);
}

/**
 * เงื่อนไขว่างานชิ้นไหนถึงคิวตรวจ
 *
 * แยกออกมาเป็นฟังก์ชันเดียวเพื่อให้ทั้งของจริงและของทดสอบใช้เกณฑ์ชุดเดียวกัน
 * ถ้าชุดทดสอบเขียนเงื่อนไขของตัวเอง มันจะทดสอบตรรกะที่ไม่ได้ทำงานจริงในระบบ
 */
function dueWhere(now: Date): Prisma.GoogleDriveSyncWhereInput {
  return {
    syncEnabled: true,
    detachedAt: null,
    mode: 'SYNCED',
    connection: { state: 'ACTIVE' },
    OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: dueBefore(now) } }],
  };
}

function findDue(where: Prisma.GoogleDriveSyncWhereInput): Promise<GoogleDriveSync[]> {
  return prisma.googleDriveSync.findMany({
    where,
    // เก่าที่สุดก่อน จึงไม่มีไฟล์ไหนถูกลืมเมื่อมีงานมากกว่าหนึ่งรอบ
    orderBy: [{ lastCheckedAt: 'asc' }, { createdAt: 'asc' }],
    take: BATCH_SIZE,
  });
}

/** วิธีเลือกงานหนึ่งรอบ - ฉีดเข้ามาได้เพื่อจำกัดขอบเขต */
export type DueSyncSelector = (now: Date) => Promise<GoogleDriveSync[]>;

/** ของจริง: ทุกการผูกที่ถึงคิวในฐานข้อมูล */
export const selectDueSyncs: DueSyncSelector = (now) => findDue(dueWhere(now));

/**
 * ตัวเลือกงานที่จำกัดอยู่เฉพาะการเชื่อมต่อที่ระบุ
 *
 * **มีไว้เพื่อความปลอดภัยของชุดทดสอบโดยเฉพาะ** ชุดทดสอบรันบนฐานข้อมูลเดียวกับ
 * ที่ใช้งานจริง และบางชุดสลับกุญแจถอดรหัสเป็นค่าสุ่มเพื่อทดสอบกรณีกุญแจผิด
 * ถ้ารอบตรวจกวาดทั้งฐานข้อมูล มันจะไปเจอการเชื่อมต่อจริงของผู้ใช้ ถอดรหัสไม่ผ่าน
 * แล้วบันทึกสถานะ CREDENTIAL_UNREADABLE ทับของจริง - ชุดทดสอบทำลายข้อมูลจริง
 *
 * เกณฑ์ 'ถึงคิว' ยังเป็นชุดเดียวกับของจริงทุกประการ ต่างแค่ขอบเขตที่มองเห็น
 * จึงไม่ใช่การทดสอบตรรกะปลอม
 *
 * ไม่ใช่ flag ส่วนกลาง และเปิดใช้โดยบังเอิญในระบบจริงไม่ได้ - ต้องส่งรายการ
 * รหัสการเชื่อมต่อเข้ามาอย่างเจาะจงเท่านั้น
 */
export function dueSyncsForConnections(connectionIds: readonly string[]): DueSyncSelector {
  const ids = [...connectionIds];
  return (now) =>
    ids.length === 0
      ? Promise.resolve([])
      : findDue({ AND: [dueWhere(now), { connectionId: { in: ids } }] });
}

/**
 * ตรวจหนึ่งรอบ
 *
 * เลือกเฉพาะการผูกที่เปิดซิงก์อยู่ ยังไม่ถูกหยุดถาวร และการเชื่อมต่อยังใช้งานได้
 *
 * การเชื่อมต่อที่ต้องยืนยันตัวตนใหม่ถูกข้ามทั้งหมด ไม่ใช่ลองแล้วล้มเหลวทีละไฟล์
 * เพราะทุกไฟล์ของการเชื่อมต่อนั้นจะล้มเหลวด้วยเหตุผลเดียวกัน และการลองซ้ำ
 * ก็แค่ยิงคำขอที่รู้ผลอยู่แล้วไปที่ Google
 */
export async function runSyncBatch(
  provider: GoogleDriveProvider = googleDriveProvider,
  now: Date = new Date(),
  selectDue: DueSyncSelector = selectDueSyncs,
): Promise<number> {
  const due = await selectDue(now);

  if (due.length === 0) return 0;

  let cursor = 0;
  let done = 0;
  const concurrency = Math.min(env.S2_NAS_DRIVE_SYNC_CONCURRENCY, due.length);

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const item = due[cursor++];
      if (!item) return;

      try {
        // ตัวทำงานเบื้องหลังไม่มี IP หรือเบราว์เซอร์ - บันทึกจะแสดงผู้ลงมือว่า "ระบบ"
        await checkOne(item, provider, {});
        done += 1;
      } catch (error) {
        /**
         * ข้อผิดพลาดที่หลุดออกมาถึงตรงนี้แปลว่า checkOne เองพัง ไม่ใช่การซิงก์ล้มเหลว
         * (ความล้มเหลวปกติถูกจัดการและบันทึกไว้ข้างในแล้ว) รอบต่อไปจะลองใหม่
         */
        logger.warn({ err: error }, '[DRIVE] ตรวจการเปลี่ยนแปลงล้มเหลวโดยไม่คาดคิด');
      }
    }
  });

  await Promise.all(workers);
  return done;
}

export function startDriveSyncWorker(
  provider: GoogleDriveProvider = googleDriveProvider,
): DriveSyncWorker | null {
  if (env.S2_NAS_DRIVE_SYNC_ENABLED !== 1) return null;

  /**
   * ไม่เริ่มตัวทำงานเมื่อยังตั้งค่าไม่ครบ
   *
   * ตัวจับเวลาที่ตื่นมาทุก 15 นาทีเพื่อพบว่าทำอะไรไม่ได้ ไม่ได้ให้ประโยชน์อะไร
   * นอกจากบันทึกคำเตือนซ้ำ ๆ จนคนเลิกอ่านบันทึก
   */
  if (!isDriveConfigured() || !credentialCipherReady()) return null;

  let stopped = false;
  let running = false;

  const tick = async (): Promise<number> => {
    // รอบก่อนยังไม่จบก็ข้ามไป - งานที่ค้างจะถูกหยิบในรอบถัดไปตามลำดับเวลาอยู่แล้ว
    if (stopped || running) return 0;
    running = true;
    try {
      const done = await runSyncBatch(provider);
      if (done > 0) logger.info(`[DRIVE] ตรวจการเปลี่ยนแปลง ${done} รายการ`);
      return done;
    } catch (error) {
      logger.warn({ err: error }, '[DRIVE] รอบซิงก์ล้มเหลว');
      return 0;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), env.S2_NAS_DRIVE_SYNC_POLL_SECONDS * 1000);
  // ไม่กันไม่ให้ process ปิดตัวเมื่อไม่มีงานอื่นเหลือ
  timer.unref();

  logger.info(
    `[DRIVE] ตัวซิงก์ Google Drive เริ่มทำงาน (ทุก ${env.S2_NAS_DRIVE_SYNC_POLL_SECONDS} วินาที)`,
  );

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runOnce: tick,
  };
}
