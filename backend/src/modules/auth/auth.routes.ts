import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../core/prisma.js';
import { authenticate } from './auth.guard.js';
import { changePassword, login, revokeRefreshToken, rotateRefreshToken } from './auth.service.js';
import { MAX_DISPLAY_NAME_LENGTH, updateUserProfile } from '../users/user.service.js';
import { AppError } from '../../core/errors.js';
import {
  consumeState,
  createAuthorizationRequest,
  landingPathFor,
  exchangeCodeForIdToken,
  isGoogleConfigured,
  safeReturnTo,
  verifyIdToken,
} from './google-oauth.js';
import { loginWithGoogleIdentity } from './google-identity.service.js';

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

  /* ---------------- เข้าสู่ระบบด้วย Google ---------------- */

  /**
   * บอกหน้าเว็บว่าปุ่ม Google ควรแสดงหรือไม่
   * ส่งออกเฉพาะข้อมูลสาธารณะ - ไม่มี client id หรือ secret อยู่ในคำตอบนี้
   */
  app.get('/auth/google/config', async () => ({
    success: true,
    data: { enabled: isGoogleConfigured() },
  }));

  /** เริ่มขั้นตอน - สร้าง state/nonce/PKCE แล้วพาไป Google */
  app.get('/auth/google/start', async (request, reply) => {
    const query = z.object({ returnTo: z.string().optional() }).parse(request.query);
    const authorization = createAuthorizationRequest(query.returnTo);
    return reply.redirect(authorization.url, 302);
  });

  /**
   * ปลายทางที่ Google ส่งผู้ใช้กลับมา
   *
   * ทุกความล้มเหลวจบที่หน้าเข้าสู่ระบบพร้อมรหัสที่ปลอดภัย ไม่ส่ง payload ดิบของ Google ต่อ
   * และไม่เปิดเผยว่าอีเมลนั้นมีอยู่ในระบบหรือไม่มากไปกว่าที่ผู้ใช้ควรรู้
   */
  app.get('/auth/google/callback', async (request, reply) => {
    const query = z
      .object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
      })
      .parse(request.query);

    const failure = (reason: string): void => {
      void reply.redirect(`${env.S2_NAS_APP_ORIGIN}/login?google=${encodeURIComponent(reason)}`, 302);
    };

    // ผู้ใช้กดยกเลิกที่หน้า Google หรือ Google แจ้ง error กลับมา
    if (query.error || !query.code) {
      return failure('GOOGLE_AUTH_FAILED');
    }

    let pendingLogin;
    try {
      pendingLogin = consumeState(query.state);
    } catch (error) {
      return failure(error instanceof AppError ? error.code : 'GOOGLE_AUTH_FAILED');
    }

    try {
      const idToken = await exchangeCodeForIdToken(query.code, pendingLogin.codeVerifier);
      const identity = await verifyIdToken(idToken, pendingLogin.nonce);
      const session = await loginWithGoogleIdentity(identity, {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
      });

      // session เดียวกับการเข้าสู่ระบบด้วยรหัสผ่านทุกประการ
      reply.setCookie(cookieName, session.refreshToken, {
        ...cookieOptions,
        maxAge: session.refreshMaxAgeSeconds,
      });
      /**
       * ปลายทางหลังเข้าสู่ระบบขึ้นกับชนิดของบัญชี ไม่ใช่ค่าที่ติดมากับคำขอ
       * ผู้ใช้ภายนอกไปที่พื้นที่เอกสารสำหรับลูกค้าเสมอ แม้จะมี returnTo ชี้ไปที่หน้าภายในก็ตาม
       */
      return reply.redirect(
        `${env.S2_NAS_APP_ORIGIN}${landingPathFor(session.user, pendingLogin.returnTo)}`,
        302,
      );
    } catch (error) {
      return failure(error instanceof AppError ? error.code : 'GOOGLE_AUTH_FAILED');
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
