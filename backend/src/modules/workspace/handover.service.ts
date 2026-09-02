import { prisma } from '../../core/prisma.js';
import { AppError, badRequest, forbidden, notFound } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type { AuditContext } from './workspace.service.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * การส่งมอบความรับผิดชอบ (Handover)
 *
 * ทรัพยากรทุกชิ้นเป็นขององค์กร ไม่ใช่ของบุคคล เมื่อพนักงานลาออกหรือย้ายหน้าที่
 * ไฟล์ต้องอยู่ต่อและต้องมีผู้ดูแลคนใหม่เสมอ ระบบจึงต้อง
 *   1. บอกได้ว่าใครดูแลอะไรอยู่บ้าง ก่อนตัดสินใจปิดบัญชี
 *   2. โอนความเป็นผู้ดูแลทั้งชุดได้ในครั้งเดียว พร้อมดูตัวอย่างก่อนยืนยัน
 *   3. เตือนเมื่อกำลังจะปิดบัญชีที่ยังมีทรัพยากรค้างอยู่
 *
 * การโอนเปลี่ยนเฉพาะ ownerId (ผู้รับผิดชอบ) เท่านั้น
 * createdById (ผู้สร้าง) ไม่ถูกแตะต้อง เพราะเป็นข้อเท็จจริงทางประวัติศาสตร์
 */

function isAdmin(user: AuthUser): boolean {
  return user.roles.includes('SUPER_ADMIN') || user.roles.includes('ADMIN');
}

function assertMayHandover(user: AuthUser): void {
  if (!isAdmin(user) && !user.permissions.includes('resources:owner:manage')) {
    throw forbidden('ไม่มีสิทธิ์โอนความเป็นผู้ดูแลทรัพยากร');
  }
}

const actorSelect = { id: true, displayName: true, email: true, status: true } as const;

/** ภาพรวมว่าผู้ใช้แต่ละคนดูแลทรัพยากรอยู่เท่าไร ใช้ก่อนตัดสินใจปิดบัญชี */
export async function ownershipOverview(user: AuthUser) {
  assertMayHandover(user);

  const groups = await prisma.resource.groupBy({
    by: ['ownerId'],
    where: { deletedAt: null },
    _count: { _all: true },
  });
  if (groups.length === 0) return [];

  const [users, folderGroups] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: groups.map((group) => group.ownerId) } },
      select: actorSelect,
      orderBy: { displayName: 'asc' },
    }),
    prisma.resource.groupBy({
      by: ['ownerId'],
      where: { deletedAt: null, type: 'FOLDER' },
      _count: { _all: true },
    }),
  ]);

  const total = new Map(groups.map((group) => [group.ownerId, group._count._all]));
  const folders = new Map(folderGroups.map((group) => [group.ownerId, group._count._all]));

  return users.map((row) => {
    const owned = total.get(row.id) ?? 0;
    const folderCount = folders.get(row.id) ?? 0;
    return {
      user: { id: row.id, displayName: row.displayName, email: row.email, status: row.status },
      ownedTotal: owned,
      ownedFolders: folderCount,
      ownedFiles: owned - folderCount,
      /** บัญชีที่ปิดใช้งานแล้วแต่ยังถือทรัพยากร คือความเสี่ยงที่ต้องจัดการ */
      needsHandover: row.status !== 'ACTIVE' && owned > 0,
    };
  });
}

async function loadTransferParties(fromUserId: string, toUserId: string) {
  if (fromUserId === toUserId) {
    throw badRequest('HANDOVER_SAME_USER', 'ผู้โอนและผู้รับต้องเป็นคนละคน');
  }
  const [from, to] = await Promise.all([
    prisma.user.findUnique({ where: { id: fromUserId }, select: actorSelect }),
    prisma.user.findUnique({ where: { id: toUserId }, select: actorSelect }),
  ]);
  if (!from) throw notFound('USER_NOT_FOUND', 'ไม่พบผู้ใช้ต้นทาง');
  if (!to) throw notFound('USER_NOT_FOUND', 'ไม่พบผู้ใช้ปลายทาง');
  // ผู้รับต้องเป็นบัญชีที่ใช้งานได้จริง มิฉะนั้นเท่ากับย้ายปัญหาไปไว้อีกที่
  if (to.status !== 'ACTIVE') {
    throw new AppError('HANDOVER_TARGET_INACTIVE', 'ผู้รับต้องเป็นผู้ใช้ที่เปิดใช้งานอยู่', 400);
  }
  return { from, to };
}

/** ดูตัวอย่างก่อนโอนจริง ไม่เขียนข้อมูลใด ๆ */
export async function previewHandover(fromUserId: string, toUserId: string, user: AuthUser) {
  assertMayHandover(user);
  const { from, to } = await loadTransferParties(fromUserId, toUserId);

  const where = { ownerId: fromUserId, deletedAt: null } as const;
  const [count, sample] = await Promise.all([
    prisma.resource.count({ where }),
    prisma.resource.findMany({
      where,
      select: { id: true, name: true, type: true, isLocked: true },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
      take: 50,
    }),
  ]);

  return {
    from: { id: from.id, displayName: from.displayName, email: from.email, status: from.status },
    to: { id: to.id, displayName: to.displayName, email: to.email, status: to.status },
    total: count,
    sample,
    truncated: count > sample.length,
  };
}

/**
 * โอนความเป็นผู้ดูแลทั้งหมดของผู้ใช้หนึ่งไปยังอีกคน
 *
 * ทำใน transaction เดียว เพื่อไม่ให้เกิดสถานะครึ่ง ๆ กลาง ๆ ที่ทรัพยากรบางส่วนโอนแล้ว
 * บางส่วนยังค้าง ซึ่งจะตามแก้ยากมากเมื่อมีของหลายพันชิ้น
 */
export async function bulkTransferOwnership(
  fromUserId: string,
  toUserId: string,
  user: AuthUser,
  audit: AuditContext,
) {
  assertMayHandover(user);
  const { from, to } = await loadTransferParties(fromUserId, toUserId);

  const transferred = await prisma.$transaction(async (tx) => {
    const result = await tx.resource.updateMany({
      where: { ownerId: fromUserId, deletedAt: null },
      data: { ownerId: toUserId, updatedById: user.id },
    });
    if (result.count === 0) return 0;

    await tx.activityLog.create({
      data: {
        userId: user.id,
        action: 'OWNERSHIP_BULK_TRANSFERRED',
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent?.slice(0, 500),
        // เก็บเฉพาะรหัสผู้ใช้ ไม่เก็บอีเมลลงบันทึกกิจกรรม
        metadata: { fromUserId, toUserId, count: result.count },
      },
    });
    return result.count;
  });

  logger.info(`[HANDOVER] โอนความเป็นผู้ดูแล ${transferred} รายการ`);
  return {
    transferred,
    from: { id: from.id, displayName: from.displayName },
    to: { id: to.id, displayName: to.displayName },
  };
}

/**
 * ตรวจก่อนปิดการใช้งานบัญชี
 *
 * ไม่ห้ามการปิดบัญชี แต่ต้องบอกให้ชัดว่ายังมีอะไรค้างอยู่ การเงียบไว้แล้วปล่อยให้
 * โฟลเดอร์กลายเป็นของบัญชีที่ล็อกอินไม่ได้ คือทางที่ทำให้เอกสารไร้ผู้ดูแลถาวร
 */
export async function offboardingCheck(targetUserId: string, user: AuthUser) {
  assertMayHandover(user);
  const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: actorSelect });
  if (!target) throw notFound('USER_NOT_FOUND', 'ไม่พบผู้ใช้');

  const [ownedTotal, ownedFolders, lockedCount] = await Promise.all([
    prisma.resource.count({ where: { ownerId: targetUserId, deletedAt: null } }),
    prisma.resource.count({ where: { ownerId: targetUserId, deletedAt: null, type: 'FOLDER' } }),
    prisma.resource.count({ where: { lockedById: targetUserId, isLocked: true, deletedAt: null } }),
  ]);

  return {
    user: { id: target.id, displayName: target.displayName, email: target.email, status: target.status },
    ownedTotal,
    ownedFolders,
    ownedFiles: ownedTotal - ownedFolders,
    lockedByUser: lockedCount,
    requiresHandover: ownedTotal > 0,
  };
}
