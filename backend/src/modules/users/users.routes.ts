import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../core/prisma.js';
import { notFound } from '../../core/errors.js';
import { requirePermission } from '../auth/auth.guard.js';
import { normalizeEmail } from '../../config/seed-users.js';

const createSchema = z.object({
  email: z.string().email(),
  displayName: z.string().trim().min(1).max(191),
  roleCodes: z.array(z.string().min(1)).min(1),
});
const updateSchema = z.object({
  displayName: z.string().trim().min(1).max(191).optional(),
  status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED']).optional(),
  roleCodes: z.array(z.string().min(1)).min(1).optional(),
});

const publicSelect = {
  id: true, email: true, displayName: true, type: true, status: true,
  mustChangePassword: true, lastLoginAt: true, createdAt: true,
  roles: { select: { role: { select: { code: true, name: true } } } },
} as const;

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/users', { preHandler: requirePermission('users:read') }, async () => ({
    success: true,
    data: await prisma.user.findMany({ select: publicSelect, orderBy: { createdAt: 'asc' } }),
  }));

  app.post('/users', { preHandler: requirePermission('users:manage') }, async (request, reply) => {
    const input = createSchema.parse(request.body);
    const roles = await prisma.role.findMany({ where: { code: { in: input.roleCodes } } });
    if (roles.length !== new Set(input.roleCodes).size) throw notFound('ROLE_NOT_FOUND', 'ไม่พบบทบาทที่ระบุ');
    const user = await prisma.user.create({
      data: {
        email: normalizeEmail(input.email), displayName: input.displayName, status: 'INVITED',
        roles: { create: roles.map((role) => ({ roleId: role.id })) },
      }, select: publicSelect,
    });
    await prisma.activityLog.create({ data: { userId: request.authUser!.id, action: 'CREATE_USER', metadata: { targetUserId: user.id } } });
    return reply.status(201).send({ success: true, data: user });
  });

  app.patch('/users/:id', { preHandler: requirePermission('users:manage') }, async (request) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = updateSchema.parse(request.body);
    const roles = input.roleCodes ? await prisma.role.findMany({ where: { code: { in: input.roleCodes } } }) : null;
    if (roles && roles.length !== new Set(input.roleCodes).size) throw notFound('ROLE_NOT_FOUND', 'ไม่พบบทบาทที่ระบุ');
    const user = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id } });
      if (!existing) throw notFound('USER_NOT_FOUND', 'ไม่พบผู้ใช้');
      if (roles) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({ data: roles.map((role) => ({ userId: id, roleId: role.id })) });
      }
      return tx.user.update({ where: { id }, data: { displayName: input.displayName, status: input.status, tokenVersion: input.status && input.status !== 'ACTIVE' ? { increment: 1 } : undefined }, select: publicSelect });
    });
    await prisma.activityLog.create({ data: { userId: request.authUser!.id, action: 'UPDATE_USER', metadata: { targetUserId: id } } });
    return { success: true, data: user };
  });

  app.get('/roles', { preHandler: requirePermission('roles:read') }, async () => ({
    success: true,
    data: await prisma.role.findMany({ include: { permissions: { select: { permission: true } } }, orderBy: { code: 'asc' } }),
  }));
  app.get('/permissions', { preHandler: requirePermission('roles:read') }, async () => ({
    success: true, data: await prisma.permission.findMany({ orderBy: { code: 'asc' } }),
  }));
}
