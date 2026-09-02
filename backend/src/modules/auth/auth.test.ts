import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import bcrypt from 'bcryptjs';
import { prisma } from '../../core/prisma.js';

describe('authentication boundary', () => {
  let app: FastifyInstance;
  const testEmail = `auth-test-${process.pid}@example.invalid`;
  const testPassword = 'PhaseA-Test-Password-2026!';
  before(async () => {
    app = await buildApp();
    const viewer = await prisma.role.findUniqueOrThrow({ where: { code: 'VIEWER' } });
    await prisma.user.create({
      data: {
        email: testEmail, displayName: 'Auth Test', status: 'ACTIVE', mustChangePassword: false,
        passwordHash: await bcrypt.hash(testPassword, 4), roles: { create: { roleId: viewer.id } },
      },
    });
  });
  after(async () => {
    await prisma.user.deleteMany({ where: { email: testEmail } });
    await app.close();
  });

  test('auth/me ปฏิเสธ request ที่ไม่มี access token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'UNAUTHORIZED');
  });

  test('users endpoint บังคับ authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/users' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'UNAUTHORIZED');
  });

  test('login ไม่เปิดเผยว่าบัญชีมีอยู่หรือไม่', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'nobody@example.com', password: 'incorrect' },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.message, 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
  });

  test('refresh ต้องมี HttpOnly cookie', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/refresh' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'UNAUTHORIZED');
  });

  test('login, access token และ refresh rotation ทำงานจริง', async () => {
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: testEmail, password: testPassword },
    });
    assert.equal(login.statusCode, 200);
    const accessToken = login.json().data.accessToken as string;
    const setCookie = login.headers['set-cookie'];
    assert.match(String(setCookie), /s2-refresh=.*HttpOnly.*SameSite=Strict/i);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${accessToken}` } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().data.email, testEmail);
    assert.deepEqual(me.json().data.permissions, ['resources:read']);

    const cookie = String(setCookie).split(';')[0]!;
    const refreshed = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie } });
    assert.equal(refreshed.statusCode, 200);
    const replay = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie } });
    assert.equal(replay.statusCode, 401, 'refresh token เดิมต้องใช้ซ้ำไม่ได้หลัง rotation');
  });

  /**
   * Session bootstrap
   *
   * refresh cookie (httpOnly) เป็นแหล่งข้อมูล session ที่เชื่อถือได้เพียงแหล่งเดียว
   * client ไม่มีสิทธิ์ตัดสินใจแทน และสถานะฝั่ง client ที่หายไปต้องไม่ขวางการกู้คืน session
   */
  describe('session bootstrap (/auth/session)', () => {
    const loginAndGetCookie = async () => {
      const login = await app.inject({
        method: 'POST', url: '/api/auth/login', payload: { email: testEmail, password: testPassword },
      });
      assert.equal(login.statusCode, 200);
      return String(login.headers['set-cookie']).split(';')[0]!;
    };

    test('cookie ที่ใช้งานได้กู้คืน session ได้ แม้ client ไม่มีสถานะใด ๆ เก็บไว้', async () => {
      const cookie = await loginAndGetCookie();

      // ส่งเฉพาะ cookie ไม่มี access token และไม่มีสถานะฝั่ง client อื่นเลย
      // เทียบเท่ากับเบราว์เซอร์ที่ localStorage ถูกล้างจนหมด
      const bootstrap = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { cookie } });

      assert.equal(bootstrap.statusCode, 200);
      const body = bootstrap.json();
      assert.equal(body.data.authenticated, true);
      assert.equal(body.data.user.email, testEmail);
      assert.ok(body.data.accessToken, 'ต้องได้ access token ใหม่กลับมา');

      // access token ที่ได้ต้องใช้งานได้จริง
      const me = await app.inject({
        method: 'GET', url: '/api/auth/me',
        headers: { authorization: `Bearer ${body.data.accessToken}` },
      });
      assert.equal(me.statusCode, 200);
      assert.equal(me.json().data.email, testEmail);
    });

    test('bootstrap หมุน refresh token และ cookie เดิมใช้ซ้ำไม่ได้', async () => {
      const cookie = await loginAndGetCookie();

      const first = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { cookie } });
      assert.equal(first.json().data.authenticated, true);
      assert.match(String(first.headers['set-cookie']), /s2-refresh=.*HttpOnly.*SameSite=Strict/i);

      const replay = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { cookie } });
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.json().data.authenticated, false, 'cookie เดิมต้องใช้ซ้ำไม่ได้หลัง rotation');
    });

    test('ไม่มี cookie จบลงที่สถานะยังไม่ได้เข้าสู่ระบบ โดยไม่ถือเป็น error', async () => {
      const response = await app.inject({ method: 'POST', url: '/api/auth/session' });

      assert.equal(response.statusCode, 200, 'ต้องไม่ตอบ 401 เพื่อไม่ให้เบราว์เซอร์บันทึกเป็น console error');
      const body = response.json();
      assert.equal(body.success, true);
      assert.equal(body.data.authenticated, false);
      assert.equal(body.data.accessToken, undefined);
      assert.equal(body.data.user, undefined);
    });

    test('cookie ที่ไม่ถูกต้องจบลงที่สถานะยังไม่ได้เข้าสู่ระบบ และถูกล้างทิ้ง', async () => {
      const response = await app.inject({
        method: 'POST', url: '/api/auth/session',
        headers: { cookie: 's2-refresh=ไม่ใช่โทเคนจริง-invalid-token-value' },
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().data.authenticated, false);
      assert.match(String(response.headers['set-cookie'] ?? ''), /s2-refresh=;|s2-refresh=(?=;|$)/, 'ต้องล้าง cookie ที่ใช้ไม่ได้ทิ้ง');
    });

    test('logout ยังยกเลิก session ได้จริง ทั้ง bootstrap และ refresh', async () => {
      const cookie = await loginAndGetCookie();

      const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
      assert.equal(logout.statusCode, 200);

      const bootstrap = await app.inject({ method: 'POST', url: '/api/auth/session', headers: { cookie } });
      assert.equal(bootstrap.statusCode, 200);
      assert.equal(bootstrap.json().data.authenticated, false, 'หลัง logout ต้องกู้คืน session ไม่ได้');

      // /auth/refresh ยังคงพฤติกรรมเดิมคือ 401 สำหรับ session ที่ใช้ไม่ได้
      const refresh = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie } });
      assert.equal(refresh.statusCode, 401);
      assert.equal(refresh.json().error.code, 'UNAUTHORIZED');
    });
  });

  test('first-login password change บังคับ session เดิมหมดอายุและปิด mustChangePassword', async () => {
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: testEmail, password: testPassword },
    });
    const accessToken = login.json().data.accessToken as string;
    const newPassword = 'Changed-PhaseA-Password-2026!';

    const changed = await app.inject({
      method: 'POST', url: '/api/auth/change-password',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { currentPassword: testPassword, newPassword },
    });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().data.loginRequired, true);

    const oldSession = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${accessToken}` } });
    assert.equal(oldSession.statusCode, 401);

    const relogin = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: testEmail, password: newPassword },
    });
    assert.equal(relogin.statusCode, 200);
    assert.equal(relogin.json().data.user.mustChangePassword, false);
  });
});
