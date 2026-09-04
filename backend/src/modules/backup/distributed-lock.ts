import { PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';
import { AppError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

/**
 * ล็อกงานสำรอง/กู้คืนแบบข้ามอินสแตนซ์
 *
 * ล็อกในหน่วยความจำกันได้แค่ภายใน process เดียว เมื่อรัน backend หลายตัวพร้อมกัน
 * ทั้งสองตัวจะเชื่อว่าตัวเองว่างและสำรองข้อมูลทับกัน ชุดสำรองที่ได้จะไม่ตรงกับ manifest ของตัวเอง
 *
 * MariaDB advisory lock (GET_LOCK/RELEASE_LOCK) แก้ปัญหานี้ได้ เพราะเป็นของกลางที่ทุกอินสแตนซ์เห็นตรงกัน
 *
 * ข้อสำคัญที่สุด: advisory lock ผูกกับ "คอนเนกชัน" ไม่ใช่กับ session ของแอป
 * ถ้า GET_LOCK กับ RELEASE_LOCK วิ่งคนละคอนเนกชันในพูล การปลดล็อกจะไม่มีผล
 * และล็อกจะค้างจนกว่าคอนเนกชันเดิมจะถูกปิด - ระบบจะหยุดสำรองข้อมูลไปเงียบ ๆ
 *
 * จึงใช้ PrismaClient แยกอีกตัวที่บังคับ connection_limit=1 เพื่อให้ทุกคำสั่งของล็อก
 * วิ่งบนคอนเนกชันเดียวกันเสมอ
 */

export const BACKUP_LOCK_NAME = 's2_nas_backup_operation';

/**
 * คอนเนกชันเฉพาะของล็อก
 *
 * แยกจาก prisma หลักโดยตั้งใจ ถ้าใช้พูลเดียวกัน คำสั่งปลดล็อกอาจไปโผล่คนละคอนเนกชัน
 */
let lockClient: PrismaClient | null = null;

function singleConnectionUrl(): string {
  if (!env.DATABASE_URL) {
    throw new AppError('BACKUP_DB_NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล', 500);
  }
  const url = new URL(env.DATABASE_URL);
  // พูลขนาดหนึ่งเดียว = ทุกคำสั่งของล็อกอยู่บนคอนเนกชันเดียวกันแน่นอน
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('pool_timeout', '10');
  return url.toString();
}

function client(): PrismaClient {
  lockClient ??= new PrismaClient({ datasources: { db: { url: singleConnectionUrl() } } });
  return lockClient;
}

/** ปิดคอนเนกชันของล็อก - ใช้ตอนปิดระบบและในเทส */
export async function disconnectLockClient(): Promise<void> {
  await lockClient?.$disconnect();
  lockClient = null;
}

export type LockOperation = 'BACKUP' | 'RETENTION' | 'RESTORE_STAGE' | 'REHEARSAL' | 'OFFSITE';

export interface DistributedLockHandle {
  operation: LockOperation;
  release: () => Promise<void>;
}

/**
 * ขอล็อกแบบมีเวลาจำกัด
 *
 * ไม่รอไม่จำกัดเวลาเด็ดขาด คำขอที่ค้างรอเป็นนาทีแย่กว่าการตอบว่า "ไม่ว่าง" ทันที
 * เพราะผู้ใช้จะกดซ้ำและงานจะกองกันโดยไม่มีใครรู้ว่าเกิดอะไรขึ้น
 */
export async function acquireDistributedLock(
  operation: LockOperation,
  timeoutSeconds: number = env.S2_NAS_BACKUP_LOCK_TIMEOUT_SECONDS,
  prismaClient: PrismaClient = client(),
): Promise<DistributedLockHandle> {
  const rows = await prismaClient.$queryRawUnsafe<Array<Record<string, unknown>>>(
    'SELECT GET_LOCK(?, ?) AS acquired',
    BACKUP_LOCK_NAME,
    timeoutSeconds,
  );

  /**
   * GET_LOCK คืน 1 = ได้ล็อก, 0 = หมดเวลารอ, NULL = เกิดข้อผิดพลาด
   * ทั้ง 0 และ NULL ต้องถือว่าไม่ได้ล็อก ห้ามตีความ NULL ว่าสำเร็จเด็ดขาด
   */
  const acquired = Number(rows[0]?.acquired ?? 0);
  if (acquired !== 1) {
    throw new AppError(
      'BACKUP_OPERATION_BUSY',
      'มีงานสำรองหรือกู้คืนกำลังทำงานอยู่ กรุณาลองใหม่อีกครั้ง',
      409,
    );
  }

  let released = false;
  return {
    operation,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await prismaClient.$queryRawUnsafe('SELECT RELEASE_LOCK(?) AS released', BACKUP_LOCK_NAME);
      } catch (error) {
        /**
         * ปลดล็อกไม่สำเร็จมักแปลว่าคอนเนกชันหลุดไปแล้ว
         * ซึ่งฐานข้อมูลจะปลดล็อกให้เองอยู่แล้ว จึงไม่ทำให้งานที่เพิ่งเสร็จกลายเป็นล้มเหลว
         */
        logger.warn({ err: error }, '[LOCK] ปลดล็อกไม่สำเร็จ (คอนเนกชันอาจหลุดไปแล้ว)');
      }
    },
  };
}

/**
 * รันงานภายใต้ล็อกข้ามอินสแตนซ์
 *
 * ปลดล็อกใน finally เสมอ งานที่ throw ต้องไม่ทิ้งล็อกค้างไว้
 */
export async function withDistributedLock<T>(
  operation: LockOperation,
  work: () => Promise<T>,
  timeoutSeconds?: number,
): Promise<T> {
  const handle = await acquireDistributedLock(operation, timeoutSeconds);
  try {
    return await work();
  } finally {
    await handle.release();
  }
}

export interface LockStatus {
  name: string;
  held: boolean;
  /** true เมื่อผู้ถือคือคอนเนกชันของ process นี้เอง */
  heldByThisProcess: boolean;
}

/**
 * สถานะล็อกสำหรับงานปฏิบัติการ
 *
 * IS_USED_LOCK คืน connection id ของผู้ถือ หรือ NULL เมื่อไม่มีใครถือ
 * ใช้ดูได้อย่างเดียว ไม่ใช่การจอง - อย่านำผลนี้ไปตัดสินใจแทนการขอล็อกจริง
 */
export async function lockStatus(prismaClient: PrismaClient = client()): Promise<LockStatus> {
  const rows = await prismaClient.$queryRawUnsafe<Array<Record<string, unknown>>>(
    'SELECT IS_USED_LOCK(?) AS holder, CONNECTION_ID() AS self',
    BACKUP_LOCK_NAME,
  );
  const holder = rows[0]?.holder ?? null;
  const self = rows[0]?.self ?? null;
  return {
    name: BACKUP_LOCK_NAME,
    held: holder !== null,
    heldByThisProcess: holder !== null && String(holder) === String(self),
  };
}
