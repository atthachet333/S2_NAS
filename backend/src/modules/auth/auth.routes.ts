import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../core/prisma.js';
import { authenticate } from './auth.guard.js';
import { changePassword, login, revokeRefreshToken, rotateRefreshToken } from './auth.service.js';
import { MAX_DISPLAY_NAME_LENGTH, updateUserProfile } from '../users/user.service.js';

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });
const passwordSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(12).max(200) });
const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH).refine(
    (value) => !/\p{Cc}/u.test(value),
    { message: 'ชื่อที่แสดงมีอักขระควบคุมที่ไม่อนุญาต' },
  ),
});
const cookieName = 's2-refresh';
const cookieOptions = { httpOnly: true, secure: env.isProduction, sameSite: 'strict' as const, path: '/api/auth' };

async function audit(request: FastifyRequest, action: string, userId?: string) {
  await prisma.activityLog.create({ data: { userId, action, ipAddress: request.ip, userAgent: request.headers['user-agent']?.slice(0, 500) } });
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.decorateRequest('authUser', null);

  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const session = await login(input.email, input.password);
    reply.setCookie(cookieName, session.refreshToken, { ...cookieOptions, maxAge: session.refreshMaxAgeSeconds });
    await audit(request, 'LOGIN', session.user.id);
    return { success: true, data: { accessToken: session.accessToken, user: session.user } };
  });

  app.post('/auth/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const rawToken = request.cookies[cookieName];
    if (!rawToken) return reply.status(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'ไม่พบ refresh session' } });
    const session = await rotateRefreshToken(rawToken);
    reply.setCookie(cookieName, session.refreshToken, { ...cookieOptions, maxAge: session.refreshMaxAgeSeconds });
    return { success: true, data: { accessToken: session.accessToken, user: session.user } };
  });

  /**
   * Bootstrap ของ client
   *
   * ใช้ตอนเปิดแอปเพื่อกู้คืน session จาก refresh cookie ซึ่งเป็นแหล่งข้อมูลที่เชื่อถือได้เพียงแหล่งเดียว
   * กรณี "ยังไม่ได้เข้าสู่ระบบ" ถือเป็นคำตอบปกติ ไม่ใช่ข้อผิดพลาด จึงตอบ 200 พร้อม
   * authenticated: false เพื่อไม่ให้เบราว์เซอร์บันทึกเป็น console error ทุกครั้งที่เปิดหน้าเว็บ
   *
   * /auth/refresh ยังคงตอบ 401 ตามเดิมสำหรับการต่ออายุ session ระหว่างใช้งาน
   */
  app.post('/auth/session', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const rawToken = request.cookies[cookieName];
    if (!rawToken) return { success: true, data: { authenticated: false } };

    try {
      const session = await rotateRefreshToken(rawToken);
      reply.setCookie(cookieName, session.refreshToken, { ...cookieOptions, maxAge: session.refreshMaxAgeSeconds });
      return { success: true, data: { authenticated: true, accessToken: session.accessToken, user: session.user } };
    } catch {
      // cookie หมดอายุ ถูกเพิกถอน หรือไม่ถูกต้อง: ล้างทิ้งแล้วถือว่ายังไม่ได้เข้าสู่ระบบ
      reply.clearCookie(cookieName, cookieOptions);
      return { success: true, data: { authenticated: false } };
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    await revokeRefreshToken(request.cookies[cookieName]);
    reply.clearCookie(cookieName, cookieOptions);
    return { success: true, data: { loggedOut: true } };
  });

  app.get('/auth/me', { preHandler: authenticate }, async (request) => ({ success: true, data: request.authUser }));

  app.patch('/auth/profile', { preHandler: authenticate }, async (request) => {
    const input = profileSchema.parse(request.body);
    const actor = request.authUser!;
    const user = await updateUserProfile(actor.id, input, actor, {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });
    return {
      success: true,
      data: { ...actor, displayName: user.displayName },
    };
  });

  app.post('/auth/change-password', { preHandler: authenticate }, async (request, reply) => {
    const input = passwordSchema.parse(request.body);
    await changePassword(request.authUser!.id, input.currentPassword, input.newPassword);
    reply.clearCookie(cookieName, cookieOptions);
    await audit(request, 'CHANGE_PASSWORD', request.authUser!.id);
    return { success: true, data: { changed: true, loginRequired: true } };
  });
}
