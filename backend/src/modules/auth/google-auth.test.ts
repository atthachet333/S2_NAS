import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { prisma } from '../../core/prisma.js';
import { loginWithGoogleIdentity, googleLinkFor } from './google-identity.service.ts';
import {
  GOOGLE_SCOPES,
  consumeState,
  createAuthorizationRequest,
  resetPendingLogins,
  safeReturnTo,
} from './google-oauth.ts';
import type { GoogleIdentity } from './google-oauth.ts';

/**
 * เข้าสู่ระบบด้วย Google
 *
 * ชุดทดสอบนี้เน้นค่าคงที่ด้านความปลอดภัยเป็นหลัก: ไม่สร้างผู้ใช้ใหม่ ไม่เพิ่มสิทธิ์
 * และตัวตนไม่ย้ายเจ้าของตามอีเมล
 */
describe('เข้าสู่ระบบด้วย Google', () => {
  const prefix = `google-auth-${process.pid}`;
  let activeId = '';
  let disabledId = '';
  let secondId = '';
  let memberRoleId = '';

  const identity = (overrides: Partial<GoogleIdentity> = {}): GoogleIdentity => ({
    subject: 'google-sub-primary',
    email: `${prefix}-active@example.invalid`,
    emailNormalized: `${prefix}-active@example.invalid`,
    ...overrides,
  });

  before(async () => {
    const role = await prisma.role.findUnique({ where: { code: 'MEMBER' } });
    memberRoleId = role?.id ?? '';

    const [active, disabled, second] = await Promise.all([
      prisma.user.create({
        data: { email: `${prefix}-active@example.invalid`, displayName: 'Active', status: 'ACTIVE' },
      }),
      prisma.user.create({
        data: { email: `${prefix}-disabled@example.invalid`, displayName: 'Disabled', status: 'DISABLED' },
      }),
      prisma.user.create({
        data: { email: `${prefix}-second@example.invalid`, displayName: 'Second', status: 'ACTIVE' },
      }),
    ]);
    activeId = active.id;
    disabledId = disabled.id;
    secondId = second.id;

    if (memberRoleId) {
      await prisma.userRole.create({ data: { userId: activeId, roleId: memberRoleId } });
    }
  });

  after(async () => {
    const ids = [activeId, disabledId, secondId];
    await prisma.userIdentity.deleteMany({ where: { userId: { in: ids } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.activityLog.deleteMany({ where: { userId: { in: ids } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: prefix } } });
    resetPendingLogins();
  });

  beforeEach(async () => {
    await prisma.userIdentity.deleteMany({ where: { userId: { in: [activeId, disabledId, secondId] } } });
    resetPendingLogins();
  });

  /* ---------------- ขอบเขตสิทธิ์ที่ขอจาก Google ---------------- */

  test('ขอเฉพาะ scope สำหรับยืนยันตัวตน ไม่มี Drive/Docs/Sheets', () => {
    assert.deepEqual([...GOOGLE_SCOPES], ['openid', 'email', 'profile']);
    const joined = GOOGLE_SCOPES.join(' ');
    for (const forbidden of ['drive', 'drive.file', 'spreadsheets', 'documents', 'cloud-platform']) {
      assert.ok(!joined.includes(forbidden), `ต้องไม่ขอ scope ${forbidden}`);
    }
  });

  /* ---------------- state / PKCE / open redirect ---------------- */

  /** ข้อมูลรับรองสมมติ - ทดสอบกติกาได้โดยไม่ต้องมีของจริงในเครื่อง */
  const fakeConfig = {
    clientId: 'test-client-id.apps.googleusercontent.com',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:8889/api/auth/google/callback',
  };

  test('state ใช้ได้ครั้งเดียว และคำขอที่ไม่รู้จักถูกปฏิเสธ', () => {
    const request = createAuthorizationRequest('/files', Date.now(), fakeConfig);
    const first = consumeState(request.state);
    assert.equal(first.returnTo, '/files');

    // ใช้ซ้ำไม่ได้ - กัน replay
    assert.throws(() => consumeState(request.state), (error: { code?: string }) => error.code === 'GOOGLE_STATE_INVALID');
    assert.throws(() => consumeState('never-issued'), (error: { code?: string }) => error.code === 'GOOGLE_STATE_INVALID');
    assert.throws(() => consumeState(undefined), (error: { code?: string }) => error.code === 'GOOGLE_STATE_INVALID');
  });

  test('state ที่หมดอายุถูกปฏิเสธ', () => {
    const start = Date.UTC(2026, 8, 3, 10, 0, 0);
    const request = createAuthorizationRequest('/dashboard', start, fakeConfig);
    // เกินอายุ 10 นาที
    assert.throws(
      () => consumeState(request.state, start + 11 * 60 * 1000),
      (error: { code?: string }) => error.code === 'GOOGLE_STATE_EXPIRED',
    );
  });

  test('คำขอมี state, nonce และ PKCE ครบ', () => {
    const request = createAuthorizationRequest(undefined, Date.now(), fakeConfig);
    const url = new URL(request.url);
    assert.ok(url.searchParams.get('state'));
    assert.ok(url.searchParams.get('nonce'));
    assert.ok(url.searchParams.get('code_challenge'));
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('response_type'), 'code');
    // ความลับของ client ต้องไม่โผล่ใน URL ที่ผู้ใช้เห็น
    assert.ok(!request.url.includes('client_secret'));
    assert.ok(!request.url.includes(fakeConfig.clientSecret));

    // scope ที่ขอจริงต้องเป็นชุดยืนยันตัวตนเท่านั้น
    assert.equal(url.searchParams.get('scope'), 'openid email profile');
  });

  test('ทุกคำขอได้ state และ PKCE ที่ไม่ซ้ำกัน', () => {
    const first = createAuthorizationRequest('/files', Date.now(), fakeConfig);
    const second = createAuthorizationRequest('/files', Date.now(), fakeConfig);

    assert.notEqual(first.state, second.state, 'state ต้องไม่ซ้ำกัน');
    const challengeOf = (request: { url: string }) => new URL(request.url).searchParams.get('code_challenge');
    assert.notEqual(challengeOf(first), challengeOf(second), 'PKCE challenge ต้องไม่ซ้ำกัน');

    // ปลายทางที่ไม่ปลอดภัยถูกทำให้ปลอดภัยตั้งแต่ตอนสร้างคำขอ
    const evil = createAuthorizationRequest('https://evil.example', Date.now(), fakeConfig);
    assert.equal(consumeState(evil.state).returnTo, '/dashboard');
  });

  test('ปลายทางหลังเข้าสู่ระบบต้องเป็นเส้นทางภายในเท่านั้น', () => {
    assert.equal(safeReturnTo('/files'), '/files');
    assert.equal(safeReturnTo('/system-drive/abc'), '/system-drive/abc');

    for (const evil of [
      'https://evil.example',
      '//evil.example',
      'http://evil.example',
      'javascript:alert(1)',
      '/\\evil.example',
      'files',
      '',
      undefined,
    ]) {
      assert.equal(safeReturnTo(evil), '/dashboard', `${String(evil)} ต้องถูกปฏิเสธ`);
    }
  });

  /* ---------------- ไม่สร้างผู้ใช้ใหม่ ---------------- */

  test('อีเมล Google ที่ไม่มีในระบบถูกปฏิเสธ และจำนวนผู้ใช้ต้องไม่เปลี่ยน', async () => {
    const before = await prisma.user.count();

    await assert.rejects(
      () =>
        loginWithGoogleIdentity(
          identity({
            subject: 'google-sub-stranger',
            email: `${prefix}-stranger@example.invalid`,
            emailNormalized: `${prefix}-stranger@example.invalid`,
          }),
        ),
      (error: { code?: string }) => error.code === 'ACCOUNT_NOT_ALLOWED',
    );

    assert.equal(await prisma.user.count(), before, 'ห้ามสร้างผู้ใช้ใหม่จากบัญชี Google เด็ดขาด');
    assert.equal(
      await prisma.userIdentity.count({ where: { providerSubject: 'google-sub-stranger' } }),
      0,
      'ห้ามสร้างการเชื่อมตัวตนให้บัญชีที่ไม่ได้รับอนุญาต',
    );
  });

  /* ---------------- เชื่อมครั้งแรกและครั้งถัดไป ---------------- */

  test('ผู้ใช้เดิมที่ ACTIVE เข้าสู่ระบบได้ และเกิดการเชื่อมตัวตนครั้งแรก', async () => {
    const session = await loginWithGoogleIdentity(identity());

    assert.equal(session.user.id, activeId);
    assert.ok(session.accessToken);
    assert.ok(session.refreshToken);

    const link = await prisma.userIdentity.findFirst({ where: { userId: activeId } });
    assert.ok(link, 'ต้องบันทึกการเชื่อมตัวตนไว้');
    assert.equal(link!.providerSubject, 'google-sub-primary');
  });

  test('ตัวตนที่เชื่อมแล้วเข้าสู่ระบบซ้ำได้เป็นผู้ใช้คนเดิม', async () => {
    await loginWithGoogleIdentity(identity());
    const second = await loginWithGoogleIdentity(identity());

    assert.equal(second.user.id, activeId);
    assert.equal(await prisma.userIdentity.count({ where: { userId: activeId } }), 1, 'ต้องไม่เชื่อมซ้ำ');
  });

  test('อีเมลต่างตัวพิมพ์ใหญ่เล็กยังหาผู้ใช้คนเดิมเจอ', async () => {
    const session = await loginWithGoogleIdentity(
      identity({
        subject: 'google-sub-case',
        email: `${prefix}-ACTIVE@Example.Invalid`.toUpperCase(),
        emailNormalized: `${prefix}-active@example.invalid`,
      }),
    );
    assert.equal(session.user.id, activeId);
  });

  /* ---------------- สถานะบัญชี ---------------- */

  test('บัญชีที่ถูกปิดใช้งานเข้าสู่ระบบไม่ได้', async () => {
    await assert.rejects(
      () =>
        loginWithGoogleIdentity(
          identity({
            subject: 'google-sub-disabled',
            email: `${prefix}-disabled@example.invalid`,
            emailNormalized: `${prefix}-disabled@example.invalid`,
          }),
        ),
      (error: { code?: string }) => error.code === 'ACCOUNT_DISABLED',
    );
  });

  test('บัญชีที่ถูกปิดหลังเชื่อมแล้ว ก็ยังเข้าไม่ได้', async () => {
    await loginWithGoogleIdentity(identity());
    await prisma.user.update({ where: { id: activeId }, data: { status: 'DISABLED' } });
    try {
      await assert.rejects(
        () => loginWithGoogleIdentity(identity()),
        (error: { code?: string }) => error.code === 'ACCOUNT_DISABLED',
      );
    } finally {
      await prisma.user.update({ where: { id: activeId }, data: { status: 'ACTIVE' } });
    }
  });

  /* ---------------- ตัวตนชนกัน ---------------- */

  test('ผู้ใช้ที่เชื่อมบัญชี Google ไว้แล้ว ไม่ถูกเปลี่ยนตัวตนเงียบ ๆ', async () => {
    await loginWithGoogleIdentity(identity());

    // บัญชี Google คนละอันแต่ชี้อีเมลเดียวกัน - ต้องปฏิเสธ ไม่ใช่เขียนทับ
    await assert.rejects(
      () => loginWithGoogleIdentity(identity({ subject: 'google-sub-different' })),
      (error: { code?: string }) => error.code === 'IDENTITY_CONFLICT',
    );

    const link = await prisma.userIdentity.findFirstOrThrow({ where: { userId: activeId } });
    assert.equal(link.providerSubject, 'google-sub-primary', 'การเชื่อมเดิมต้องไม่ถูกแทนที่');
  });

  test('อีเมลของบัญชี Google เปลี่ยน ตัวตนต้องไม่ย้ายไปหาผู้ใช้คนอื่น', async () => {
    await loginWithGoogleIdentity(identity());

    // subject เดิม แต่ตอนนี้อีเมลตรงกับผู้ใช้อีกคน
    const session = await loginWithGoogleIdentity(
      identity({ email: `${prefix}-second@example.invalid`, emailNormalized: `${prefix}-second@example.invalid` }),
    );

    assert.equal(session.user.id, activeId, 'ต้องยังเป็นผู้ใช้เดิม ไม่ย้ายไปตามอีเมล');
    assert.notEqual(session.user.id, secondId);

    const link = await prisma.userIdentity.findFirstOrThrow({ where: { providerSubject: 'google-sub-primary' } });
    assert.equal(link.userId, activeId);
    // อีเมลถูกอัปเดตเป็นข้อมูลประกอบเท่านั้น
    assert.equal(link.providerEmailNormalized, `${prefix}-second@example.invalid`);
  });

  /* ---------------- ไม่มีการเลื่อนสิทธิ์ ---------------- */

  test('บทบาทและสิทธิ์ต้องไม่เปลี่ยนเพราะเข้าสู่ระบบด้วย Google', async () => {
    const before = await prisma.userRole.findMany({ where: { userId: activeId }, select: { roleId: true } });
    const session = await loginWithGoogleIdentity(identity());
    const afterRoles = await prisma.userRole.findMany({ where: { userId: activeId }, select: { roleId: true } });

    assert.deepEqual(afterRoles, before, 'จำนวนและชนิดของบทบาทต้องเท่าเดิม');
    assert.ok(!session.user.roles.includes('SUPER_ADMIN'), 'ห้ามอนุมานสิทธิ์ผู้ดูแลระบบ');
    assert.ok(!session.user.roles.includes('ADMIN'));
    for (const permission of ['system-drive:write', 'system:backup:manage', 'system:settings:manage']) {
      assert.ok(!session.user.permissions.includes(permission), `ห้ามได้รับ ${permission} จากการเข้าสู่ระบบด้วย Google`);
    }
  });

  /* ---------------- audit ---------------- */

  test('บันทึก audit โดยไม่มีความลับปนมา', async () => {
    await loginWithGoogleIdentity(identity());

    const logs = await prisma.activityLog.findMany({
      where: { userId: activeId, action: { in: ['GOOGLE_LOGIN_SUCCEEDED', 'GOOGLE_IDENTITY_LINKED'] } },
    });
    assert.ok(logs.length >= 2, 'ต้องบันทึกทั้งการเชื่อมและการเข้าสู่ระบบ');

    const dump = JSON.stringify(logs);
    for (const secret of ['id_token', 'access_token', 'client_secret', 'code_verifier', 'authorization']) {
      assert.ok(!dump.toLowerCase().includes(secret), `audit ต้องไม่มี ${secret}`);
    }
  });

  /* ---------------- ข้อมูลสำหรับผู้ดูแล ---------------- */

  test('ข้อมูลการเชื่อมบัญชีสำหรับผู้ดูแลไม่เปิดเผย provider subject', async () => {
    await loginWithGoogleIdentity(identity());

    const link = await googleLinkFor(activeId);
    assert.equal(link.linked, true);
    assert.equal(link.email, `${prefix}-active@example.invalid`);
    assert.ok(link.linkedAt instanceof Date);
    assert.ok(!JSON.stringify(link).includes('google-sub-primary'), 'ต้องไม่ส่ง providerSubject ออกไป');

    const unlinked = await googleLinkFor(secondId);
    assert.equal(unlinked.linked, false);
  });
});
