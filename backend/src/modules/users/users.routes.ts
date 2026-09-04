import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../core/prisma.js';
import { notFound } from '../../core/errors.js';
import { requirePermission } from '../auth/auth.guard.js';
import { clientPortalSummary } from '../portal/portal.service.js';
import { normalizeEmail } from '../../config/seed-users.js';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../auth/password-policy.js';
import {
  activateUser,
  changeUserRoles,
  listUsers,
  MAX_DISPLAY_NAME_LENGTH,
  resetTemporaryPassword,
  setOrganizationName,
  setUserStatus,
  updateUserProfile,
  userSelect,
} from './user.service.js';

const displayNameSchema = z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH).refine(
  (value) => !/\p{Cc}/u.test(value),
  { message: 'ชื่อที่แสดงมีอักขระควบคุมที่ไม่อนุญาต' },
);

/** ชื่อบริษัทของลูกค้า - ข้อความสำหรับมนุษย์ ไม่ใช่ขอบเขตสิทธิ์ */
const organizationSchema = z.string().trim().min(1).max(191).refine(
  (value) => !/\p{Cc}/u.test(value),
  { message: 'ชื่อบริษัทมีอักขระควบคุมที่ไม่อนุญาต' },
);

/**
 * การสร้างบัญชี
 *
 * บัญชีภายในต้องมีบทบาทอย่างน้อยหนึ่งอย่างเสมอ เพราะสิทธิ์ภายในมาจากบทบาท
 * ส่วนบัญชีลูกค้าไม่ต้องมีบทบาทใดเลย และไม่ควรมีด้วย
 * สิทธิ์ของลูกค้ามาจากการแชร์รายทรัพยากรเท่านั้น การให้บทบาทภายในกับลูกค้า
 * ไม่ได้เพิ่มสิทธิ์ให้จริง (นโยบายภายนอกปิดไว้หมด) แต่ทำให้รายชื่อผู้ใช้อ่านแล้วเข้าใจผิด
 */
const createSchema = z
  .object({
    email: z.string().email(),
    displayName: displayNameSchema,
    type: z.enum(['INTERNAL', 'EXTERNAL']).default('INTERNAL'),
    organizationName: organizationSchema.nullish(),
    roleCodes: z.array(z.string().min(1)).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'INTERNAL' && value.roleCodes.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['roleCodes'], message: 'บัญชีภายในต้องมีบทบาทอย่างน้อยหนึ่งอย่าง' });
    }
    if (value.type === 'EXTERNAL' && value.roleCodes.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['roleCodes'], message: 'บัญชีลูกค้าไม่รับบทบาทภายใน' });
    }
  });

const updateSchema = z.object({
  displayName: displayNameSchema.optional(),
  organizationName: organizationSchema.nullish(),
  status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED']).optional(),
  /** ยืนยันว่ารับทราบว่าผู้ใช้รายนี้ยังดูแลทรัพยากรอยู่ และยังยืนยันจะปิดการใช้งาน */
  acknowledgeHandover: z.boolean().optional(),
  roleCodes: z.array(z.string().min(1)).min(1).optional(),
});

/** รหัสผ่านชั่วคราวถูกตรวจความแข็งแรงจริงอีกชั้นในเซอร์วิส */
const passwordSchema = z.object({
  temporaryPassword: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

const idParams = z.object({ id: z.string().min(1) });
const audit = (request: FastifyRequest) => ({
  ipAddress: request.ip,
  userAgent: request.headers['user-agent'],
});

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/users', { preHandler: requirePermission('users:read') }, async (request) => {
    const query = z
      .object({
        q: z.string().trim().max(191).optional(),
        status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED']).optional(),
        roleCode: z.string().min(1).max(64).optional(),
        type: z.enum(['INTERNAL', 'EXTERNAL', 'SERVICE']).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().min(1).optional(),
      })
      .parse(request.query);
    return { success: true, data: await listUsers(query) };
  });

  app.post('/users', { preHandler: requirePermission('users:manage') }, async (request, reply) => {
    const input = createSchema.parse(request.body);
    const roles = await prisma.role.findMany({ where: { code: { in: input.roleCodes } } });
    if (roles.length !== new Set(input.roleCodes).size) throw notFound('ROLE_NOT_FOUND', 'ไม่พบบทบาทที่ระบุ');
    const user = await prisma.user.create({
      data: {
        email: normalizeEmail(input.email),
        displayName: input.displayName,
        type: input.type,
        // ชื่อบริษัทเป็นของบัญชีลูกค้าเท่านั้น บุคลากรภายในสังกัดองค์กรนี้อยู่แล้ว
        organizationName: input.type === 'EXTERNAL' ? input.organizationName ?? null : null,
        /**
         * บัญชีใหม่เริ่มที่ INVITED เสมอ ทั้งภายในและลูกค้า
         * ต้องมีผู้ดูแลตั้งรหัสผ่านชั่วคราวก่อนจึงเข้าใช้งานได้ - ไม่มีการสมัครเองจากภายนอก
         */
        status: 'INVITED',
        roles: { create: roles.map((role) => ({ roleId: role.id })) },
      },
      select: userSelect,
    });
    await prisma.activityLog.create({
      data: {
        userId: request.authUser!.id,
        action: 'CREATE_USER',
        metadata: { targetUserId: user.id, userType: input.type },
      },
    });
    return reply.status(201).send({ success: true, data: user });
  });

  /** แก้ไขข้อมูลทั่วไป สถานะและบทบาทมีเส้นทางเฉพาะของตัวเองที่มีการป้องกันครบกว่า */
  app.patch('/users/:id', { preHandler: requirePermission('users:manage') }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = updateSchema.parse(request.body);
    const actor = request.authUser!;

    if (input.displayName !== undefined) {
      await updateUserProfile(id, { displayName: input.displayName }, actor, audit(request));
    }
    if (input.organizationName !== undefined) {
      await setOrganizationName(id, input.organizationName, actor, audit(request));
    }
    if (input.roleCodes) await changeUserRoles(id, input.roleCodes, actor, audit(request));
    if (input.status) {
      await setUserStatus(
        id,
        input.status,
        { acknowledgeHandover: input.acknowledgeHandover },
        actor,
        audit(request),
      );
    }

    const user = await prisma.user.findUnique({ where: { id }, select: userSelect });
    if (!user) throw notFound('USER_NOT_FOUND', 'ไม่พบผู้ใช้');
    return { success: true, data: user };
  });

  /** เปิดใช้งานบัญชีที่ถูกเชิญไว้ พร้อมตั้งรหัสผ่านชั่วคราว */
  app.post('/users/:id/activate', { preHandler: requirePermission('users:manage') }, async (request) => {
    const body = passwordSchema.parse(request.body);
    return {
      success: true,
      data: await activateUser(
        idParams.parse(request.params).id,
        body.temporaryPassword,
        request.authUser!,
        audit(request),
      ),
    };
  });

  app.post('/users/:id/disable', { preHandler: requirePermission('users:manage') }, async (request) => {
    const body = z.object({ acknowledgeHandover: z.boolean().optional() }).parse(request.body ?? {});
    return {
      success: true,
      data: await setUserStatus(
        idParams.parse(request.params).id,
        'DISABLED',
        { acknowledgeHandover: body.acknowledgeHandover },
        request.authUser!,
        audit(request),
      ),
    };
  });

  app.post('/users/:id/reset-password', { preHandler: requirePermission('users:manage') }, async (request) => {
    const body = passwordSchema.parse(request.body);
    return {
      success: true,
      data: await resetTemporaryPassword(
        idParams.parse(request.params).id,
        body.temporaryPassword,
        request.authUser!,
        audit(request),
      ),
    };
  });

  app.patch('/users/:id/roles', { preHandler: requirePermission('users:manage') }, async (request) => {
    const body = z.object({ roleCodes: z.array(z.string().min(1)).min(1) }).parse(request.body);
    return {
      success: true,
      data: await changeUserRoles(
        idParams.parse(request.params).id,
        body.roleCodes,
        request.authUser!,
        audit(request),
      ),
    };
  });

  /**
   * สรุปว่าลูกค้ารายนี้เข้าถึงเอกสารอะไรได้บ้าง
   *
   * อยู่ใต้ users เพราะเป็นมุมมองของ "ผู้ใช้คนหนึ่ง" ไม่ใช่ของพื้นที่ลูกค้า
   * ด่านจึงเป็นสิทธิ์จัดการผู้ใช้ตามปกติ และเป็นเส้นทางภายในเต็มรูปแบบ
   */
  app.get('/users/:id/portal-access', { preHandler: requirePermission('users:manage') }, async (request) => {
    const { id } = idParams.parse(request.params);
    const user = await prisma.user.findUnique({ where: { id }, select: { id: true, type: true } });
    if (!user) throw notFound('USER_NOT_FOUND', 'ไม่พบผู้ใช้');
    return { success: true, data: await clientPortalSummary(user.id) };
  });

  app.get('/roles', { preHandler: requirePermission('roles:read') }, async () => ({
    success: true,
    data: await prisma.role.findMany({
      include: { permissions: { select: { permission: true } } },
      orderBy: { code: 'asc' },
    }),
  }));

  app.get('/permissions', { preHandler: requirePermission('roles:read') }, async () => ({
    success: true,
    data: await prisma.permission.findMany({ orderBy: { code: 'asc' } }),
  }));
}
