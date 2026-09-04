import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * ผู้ลงมือของงานที่ระบบสั่งเอง
 *
 * งานตามตารางยังต้องมีผู้รับผิดชอบใน audit ไม่ใช่ผู้ใช้ลึกลับ จึงเลือกบัญชีจริง
 * ที่ถือสิทธิ์ system:backup:manage อยู่แล้ว ไม่สร้างบัญชีพิเศษและไม่แตะรหัสผ่านใคร
 *
 * ถ้ายังไม่มีใครถือสิทธิ์นี้ จะคืน null และงานตามตารางจะไม่ทำงาน - ตั้งใจให้เป็นเช่นนั้น
 * ดีกว่าแอบสำรองข้อมูลในนามของใครก็ไม่รู้
 */
export async function backupOperator(): Promise<AuthUser | null> {
  const user = await prisma.user.findFirst({
    where: {
      status: 'ACTIVE',
      roles: { some: { role: { permissions: { some: { permission: { code: 'system:backup:manage' } } } } } },
    },
    include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
    orderBy: { createdAt: 'asc' },
  });
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    type: user.type,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    roles: user.roles.map((link) => link.role.code),
    permissions: [...new Set(user.roles.flatMap((link) => link.role.permissions.map((row) => row.permission.code)))],
  };
}
