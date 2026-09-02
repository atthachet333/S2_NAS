import { env } from './config/env.js';
import { BRAND } from './config/branding.js';
import { buildApp } from './app.js';
import {
  printBannerFooter,
  printBannerHeader,
  printBlank,
  printLine,
} from './core/banner.js';
import { checkDatabase, disconnectDatabase } from './core/database.js';
import { verifyStorage } from './core/storage.js';
import { logger } from './core/logger.js';

/**
 * ลำดับการ start:
 * 1. ตรวจ environment (ทำใน config/env.ts)
 * 2. ตรวจ storage path + read/write  -> ถ้าเขียนไม่ได้ ต้องหยุดพร้อม error ชัดเจน
 * 3. ตรวจ database connection        -> รายงานสถานะ (dev ยังทำงานต่อได้)
 * 4. เปิด HTTP server
 */
async function start(): Promise<void> {
  printBannerHeader();

  const baseUrl = `http://localhost:${env.BACKEND_PORT}`;
  printLine('SERVER', 'Environment', env.NODE_ENV);
  printLine('SERVER', 'Backend', baseUrl);
  printLine('SERVER', 'API', `${baseUrl}/api`);
  printLine('SERVER', 'Health', `${baseUrl}/api/health`);
  printBlank();

  // ---- Storage ----
  const storage = await verifyStorage(true);
  if (storage.status !== 'READY') {
    printLine('STORAGE', 'Status', storage.status, 'error');
    printLine('STORAGE', 'Path', storage.root, 'error');
    printLine('STORAGE', 'Readable', String(storage.readable), storage.readable ? 'ok' : 'error');
    printLine('STORAGE', 'Writable', String(storage.writable), storage.writable ? 'ok' : 'error');
    if (storage.message) printLine('STORAGE', 'Reason', storage.message, 'error');
    printBannerFooter('Backend หยุดทำงาน: Storage ไม่พร้อมใช้งาน', false);
    process.exit(1);
  }

  // ---- Database ----
  const db = await checkDatabase(true);
  if (db.status === 'CONNECTED') {
    printLine('DATABASE', 'MariaDB', `CONNECTED (${db.latencyMs}ms)`, 'ok');
  } else if (env.isProduction || env.STRICT_DB_STARTUP) {
    printLine('DATABASE', 'MariaDB', db.status, 'error');
    if (db.message) printLine('DATABASE', 'Reason', db.message, 'error');
    printBannerFooter('Backend หยุดทำงาน: เชื่อมต่อฐานข้อมูลไม่ได้', false);
    process.exit(1);
  } else {
    printLine('DATABASE', 'MariaDB', db.status, 'warn');
    if (db.message) printLine('DATABASE', 'Reason', db.message, 'warn');
    printLine('DATABASE', 'Note', 'Phase 1 ทำงานต่อได้ แต่ Phase 2 ต้องเชื่อมต่อสำเร็จ', 'warn');
  }
  printBlank();

  printLine('STORAGE', 'Status', 'READY', 'ok');
  printLine('STORAGE', 'Path', storage.root);
  printLine('STORAGE', 'Max upload', `${env.MAX_UPLOAD_SIZE_MB} MB`);

  // ---- HTTP ----
  const app = await buildApp();

  try {
    await app.listen({ port: env.BACKEND_PORT, host: env.BACKEND_HOST });
  } catch (error) {
    printBlank();
    printLine('SERVER', 'Status', 'FAILED', 'error');
    printLine('SERVER', 'Reason', (error as Error).message, 'error');
    printBannerFooter(`Backend เริ่มทำงานไม่สำเร็จที่ port ${env.BACKEND_PORT}`, false);
    process.exit(1);
  }

  printBannerFooter('Backend ready');

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\n[${BRAND.name}] ได้รับสัญญาณ ${signal} - กำลังปิดระบบ\n`);
    try {
      await app.close();
      await disconnectDatabase();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled rejection');
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  logger.error({ err: error }, 'uncaught exception');
  process.exit(1);
});

void start();
