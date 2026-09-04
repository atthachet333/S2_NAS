import { PrismaClient } from '@prisma/client';
import { syncRbac } from './rbac.js';

/**
 * ซิงก์เฉพาะสิทธิ์และบทบาท
 *
 * ใช้เมื่อเพิ่มสิทธิ์ใหม่เข้าโค้ดแล้วต้องการให้มีผลกับฐานข้อมูลที่ใช้งานอยู่
 * โดยไม่ต้องรัน seed ของผู้ใช้ ซึ่งต้องการ SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD
 * และแตะบัญชีผู้ดูแลระบบ
 *
 * สคริปต์นี้ไม่สร้าง ไม่แก้ และไม่ลบผู้ใช้ รหัสผ่าน สถานะบัญชี หรือการมอบบทบาทให้ผู้ใช้
 */
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const result = await syncRbac(prisma);
  console.log(
    `[RBAC] Synced. permissions created: ${result.permissionsCreated}, role grants created: ${result.grantsCreated}`,
  );
  if (result.permissionsCreated === 0 && result.grantsCreated === 0) {
    console.log('[RBAC] Already up to date - nothing changed');
  }
}

main()
  .catch((error: unknown) => {
    console.error('[RBAC] Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
