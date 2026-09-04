import type { PrismaClient } from '@prisma/client';

/**
 * นิยาม RBAC ของระบบ - แหล่งความจริงเดียวของสิทธิ์และบทบาท
 *
 * แยกออกจาก seed ของผู้ใช้โดยตั้งใจ การเพิ่มสิทธิ์ใหม่หนึ่งตัวต้องไม่บังคับให้ต้องรัน
 * เส้นทางที่แตะบัญชีผู้ใช้หรือรหัสผ่านไปด้วย ดู prisma/rbac-sync.ts
 */
export const PERMISSIONS = [
  ['users:read', 'ดูผู้ใช้'], ['users:manage', 'จัดการผู้ใช้'],
  ['roles:read', 'ดูบทบาทและสิทธิ์'], ['roles:manage', 'จัดการบทบาทและสิทธิ์'],
  ['resources:read', 'ดูทรัพยากร'], ['resources:write', 'สร้างและแก้ไขทรัพยากร'],
  ['resources:delete', 'ลบทรัพยากร'], ['admin:access', 'เข้าพื้นที่ผู้ดูแลระบบ'],
  ['resources:owner:manage', 'โอนเจ้าของทรัพยากร'],
  ['resources:share', 'จัดการสิทธิ์เข้าถึงทรัพยากร'],
  ['resources:lock', 'ล็อกและปลดล็อกทรัพยากร'],
  ['system:settings:manage', 'จัดการค่าตั้งค่าการทำงานของระบบ'],
  ['system:backup:manage', 'สำรองและกู้คืนข้อมูลของระบบ'],
] as const;

/**
 * ค่าตั้งค่าการทำงานของระบบเป็นสิทธิ์ที่มีผลกระทบสูง (เช่น อายุถังขยะ = การลบถาวร)
 * จึงไม่รวมอยู่ในชุดของ ADMIN โดยอัตโนมัติ ต้องมอบให้เป็นรายกรณี
 */
const ADMIN_EXCLUDED: string[] = ['roles:manage', 'system:settings:manage', 'system:backup:manage'];

export const ROLE_PERMISSIONS: Record<string, string[]> = {
  SUPER_ADMIN: PERMISSIONS.map(([code]) => code),
  ADMIN: PERMISSIONS.map(([code]) => code).filter((code) => !ADMIN_EXCLUDED.includes(code)),
  MANAGER: [
    'users:read', 'resources:read', 'resources:write', 'resources:delete',
    'resources:owner:manage', 'resources:share', 'resources:lock',
  ],
  MEMBER: ['resources:read', 'resources:write'],
  VIEWER: ['resources:read'],
};

export interface RbacSyncResult {
  permissionsCreated: number;
  grantsCreated: number;
}

/**
 * ทำให้สิทธิ์และบทบาทในฐานข้อมูลตรงกับนิยามข้างต้น
 *
 * แตะเฉพาะตาราง Permission, Role และ RolePermission เท่านั้น
 * ไม่แตะ User, UserRole, รหัสผ่าน, สถานะบัญชี หรือ token ใด ๆ
 *
 * เป็น idempotent: รันซ้ำได้โดยไม่เกิดแถวซ้ำ เพราะใช้ upsert บน unique key ทุกจุด
 * และเพิ่มสิทธิ์อย่างเดียว ไม่เพิกถอนของเดิม - การเพิกถอนต้องเป็นการตัดสินใจที่ตั้งใจ
 * ไม่ใช่ผลข้างเคียงของการรัน sync
 */
export async function syncRbac(prisma: PrismaClient): Promise<RbacSyncResult> {
  let permissionsCreated = 0;
  let grantsCreated = 0;

  for (const [code, name] of PERMISSIONS) {
    const existing = await prisma.permission.findUnique({ where: { code }, select: { id: true } });
    if (!existing) permissionsCreated += 1;
    await prisma.permission.upsert({ where: { code }, update: { name }, create: { code, name } });
  }

  for (const [code, permissionCodes] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.upsert({
      where: { code },
      update: {},
      create: { code, name: code.replace('_', ' ') },
    });
    const rows = await prisma.permission.findMany({ where: { code: { in: permissionCodes } } });
    for (const permission of rows) {
      const key = { roleId_permissionId: { roleId: role.id, permissionId: permission.id } };
      const existing = await prisma.rolePermission.findUnique({ where: key, select: { roleId: true } });
      if (!existing) grantsCreated += 1;
      await prisma.rolePermission.upsert({
        where: key,
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
    }
  }

  return { permissionsCreated, grantsCreated };
}
