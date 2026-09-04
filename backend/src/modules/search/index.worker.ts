import { env } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import { claimNextJob, reconcileIndex, runJob } from './search-index.service.js';

/**
 * ตัวทำงานสกัดข้อความ
 *
 * เป็นตัววนตรวจคิวในฐานข้อมูล ไม่ใช่คิวในหน่วยความจำ โดยตั้งใจ
 * งานที่รอไว้จึงอยู่รอดข้ามการรีสตาร์ทของเซิร์ฟเวอร์ และไม่ต้องเพิ่ม Redis
 * เข้ามาในระบบเพียงเพื่อเรื่องนี้
 *
 * ข้อจำกัดที่ตั้งใจให้ต่ำ:
 *   - ทำพร้อมกันได้ไม่กี่งาน เพราะการที่ระบบยังรับอัปโหลดได้สำคัญกว่าความเร็วของการค้นหา
 *   - ทำงานเก่าที่สุดก่อน งานที่ค้างมานานจึงไม่ถูกแซงตลอดไป
 *   - ความล้มเหลวของงานหนึ่งไม่หยุดตัววน และไม่ทำให้ไฟล์นั้นดาวน์โหลดไม่ได้
 */

export interface IndexWorker {
  stop(): void;
  /** ใช้ในเทส - ทำงานหนึ่งรอบแล้วคืนจำนวนงานที่ทำสำเร็จ */
  runOnce(): Promise<number>;
}

/** ทำงานที่ค้างอยู่หนึ่งรอบ ตามจำนวนที่ทำพร้อมกันได้ */
export async function drainOnce(concurrency: number): Promise<number> {
  let done = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const jobId = await claimNextJob();
      if (!jobId) return;
      try {
        await runJob(jobId);
      } catch (error) {
        // งานหนึ่งพังต้องไม่ทำให้ตัววนตาย - แถวถูกทิ้งไว้ให้รอบกู้คืนหยิบขึ้นมาใหม่
        logger.warn({ err: error }, '[SEARCH] งานสกัดข้อความล้มเหลวโดยไม่คาดคิด');
      }
      done += 1;
      // ทำทีละชุด ไม่กวาดจนหมดในรอบเดียว เพื่อคืนเวลาให้คำขอของผู้ใช้
      if (done >= concurrency * 20) return;
    }
  });

  await Promise.all(workers);
  return done;
}

/**
 * เริ่มตัวทำงาน
 *
 * การกู้คืนงานค้างทำครั้งแรกแบบไม่บล็อก - การเริ่มระบบต้องไม่รอให้ดัชนีเสร็จ
 */
export function startIndexWorker(): IndexWorker | null {
  if (env.S2_NAS_EXTRACT_ENABLED !== 1) return null;

  const concurrency = env.S2_NAS_EXTRACT_CONCURRENCY;
  let stopped = false;
  let running = false;

  const tick = async (): Promise<number> => {
    if (stopped || running) return 0;
    running = true;
    try {
      return await drainOnce(concurrency);
    } catch (error) {
      logger.warn({ err: error }, '[SEARCH] รอบทำงานของตัวสกัดข้อความล้มเหลว');
      return 0;
    } finally {
      running = false;
    }
  };

  // กู้คืนงานค้างจากการรีสตาร์ทครั้งก่อน แล้วจึงเริ่มวน
  void reconcileIndex()
    .then((result) => {
      if (result.requeued > 0 || result.created > 0) {
        logger.info(`[SEARCH] กู้คืนคิว: กลับเข้าคิว ${result.requeued} · สร้างใหม่ ${result.created}`);
      }
      return tick();
    })
    .catch((error: unknown) => logger.warn({ err: error }, '[SEARCH] กู้คืนคิวไม่สำเร็จ'));

  const timer = setInterval(() => void tick(), env.S2_NAS_EXTRACT_POLL_SECONDS * 1000);
  timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runOnce: tick,
  };
}
