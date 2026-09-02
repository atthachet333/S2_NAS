import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { getSeedableUsers } from '../src/config/seed-users.js';

const prisma = new PrismaClient();

const permissions = [
  ['users:read', 'ดูผู้ใช้'], ['users:manage', 'จัดการผู้ใช้'],
  ['roles:read', 'ดูบทบาทและสิทธิ์'], ['roles:manage', 'จัดการบทบาทและสิทธิ์'],
  ['resources:read', 'ดูทรัพยากร'], ['resources:write', 'สร้างและแก้ไขทรัพยากร'],
  ['resources:delete', 'ลบทรัพยากร'], ['admin:access', 'เข้าพื้นที่ผู้ดูแลระบบ'],
  ['resources:owner:manage', 'โอนเจ้าของทรัพยากร'],
  ['resources:share', 'จัดการสิทธิ์เข้าถึงทรัพยากร'],
  ['resources:lock', 'ล็อกและปลดล็อกทรัพยากร'],
] as const;

const rolePermissions: Record<string, string[]> = {
  SUPER_ADMIN: permissions.map(([code]) => code),
  ADMIN: permissions.map(([code]) => code).filter((code) => code !== 'roles:manage'),
  MANAGER: [
    'users:read', 'resources:read', 'resources:write', 'resources:delete',
    'resources:owner:manage', 'resources:share', 'resources:lock',
  ],
  MEMBER: ['resources:read', 'resources:write'],
  VIEWER: ['resources:read'],
};

async function main() {
  for (const [code, name] of permissions) {
    await prisma.permission.upsert({ where: { code }, update: { name }, create: { code, name } });
  }
  console.log('[SEED] Permissions synced');

  for (const [code, permissionCodes] of Object.entries(rolePermissions)) {
    const role = await prisma.role.upsert({ where: { code }, update: {}, create: { code, name: code.replace('_', ' ') } });
    const rows = await prisma.permission.findMany({ where: { code: { in: permissionCodes } } });
    for (const permission of rows) {
      await prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } }, update: {}, create: { roleId: role.id, permissionId: permission.id } });
    }
  }
  console.log('[SEED] Roles synced');

  const configuredAdminEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const configuredPassword = process.env.SEED_ADMIN_PASSWORD;
  for (const seed of getSeedableUsers()) {
    if (seed.email === configuredAdminEmail) continue;
    const role = await prisma.role.findUniqueOrThrow({ where: { code: seed.role } });
    const existing = await prisma.user.findUnique({ where: { email: seed.email } });
    const user = existing
      ? existing
      : await prisma.user.create({
          data: {
            email: seed.email, displayName: seed.email.split('@')[0]!, status: 'INVITED',
            mustChangePassword: true,
          },
        });
    await prisma.userRole.upsert({ where: { userId_roleId: { userId: user.id, roleId: role.id } }, update: {}, create: { userId: user.id, roleId: role.id } });
  }

  if (!configuredAdminEmail || !configuredPassword) {
    throw new Error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be configured');
  }
  if (configuredPassword.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must contain at least 12 characters');
  }

  const superAdminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });
  const existingAdmin = await prisma.user.findUnique({ where: { email: configuredAdminEmail } });
  let admin;
  if (!existingAdmin) {
    admin = await prisma.user.create({
      data: {
        email: configuredAdminEmail,
        displayName: configuredAdminEmail.split('@')[0]!,
        passwordHash: await bcrypt.hash(configuredPassword, 12),
        status: 'ACTIVE',
        mustChangePassword: true,
      },
    });
  } else if (!existingAdmin.passwordHash) {
    admin = await prisma.user.update({
      where: { id: existingAdmin.id },
      data: {
        passwordHash: await bcrypt.hash(configuredPassword, 12),
        status: 'ACTIVE',
        mustChangePassword: true,
      },
    });
  } else {
    // Existing established passwords are intentionally never replaced by seed.
    admin = existingAdmin.status === 'ACTIVE'
      ? existingAdmin
      : await prisma.user.update({ where: { id: existingAdmin.id }, data: { status: 'ACTIVE' } });
  }

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: superAdminRole.id } },
    update: {},
    create: { userId: admin.id, roleId: superAdminRole.id },
  });

  console.log(`[SEED] Admin account ready: ${configuredAdminEmail}`);
  console.log('[SEED] Completed');
}

main()
  .catch(() => {
    console.error('[SEED] Failed');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
