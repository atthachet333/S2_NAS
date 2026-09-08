import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { prisma } from '../../../core/prisma.js';
import { createStoredFileStream, removeResourceDirectory } from '../../../core/file-storage.js';
import { AppError } from '../../../core/errors.js';
import { createFolder } from '../../resources/resource.service.js';
import { uploadFile, uploadVersion } from '../../files/file.service.js';
import { trashResource, restoreResource } from '../../files/trash.service.js';
import { placeLegalHold, releaseLegalHold } from '../../governance/legal-hold.service.js';
import { searchAuditEvents } from '../../audit/audit.service.js';
import { exportAuditCsv } from '../../audit/audit-export.js';
import { EVENT_CATALOG, findPreset } from '../../audit/event-catalog.js';
import {
  CredentialCipher,
  parseEncryptionKey,
  setCredentialCipherForTest,
} from '../integration-crypto.js';
import { FakeDriveProvider } from './fake-provider.js';
import {
  accessTokenFor,
  activeConnectionFor,
  assertCanConnect,
  beginConnect,
  completeConnect,
  consumeState,
  disconnect,
  resetPendingConnects,
  toConnectionDto,
} from './connection.service.js';
import { importFromDrive } from './import.service.js';
import { checkOne, detach, lifecyclePause, resourceSyncInfo } from './sync.service.js';
import { dueSyncsForConnections, runSyncBatch, selectDueSyncs } from './sync.worker.js';
import { classifyEntry, importedFileName, GOOGLE_EXPORT } from './provider.js';
import { Readable } from 'node:stream';
import type { AuthUser } from '../../auth/auth.service.js';

/**
 * F19 - การเชื่อมต่อ Google Drive
 *
 * สองสิ่งที่ต้องพิสูจน์หนักที่สุด:
 *
 *   1. **ข้อมูลรับรองไม่รั่ว** refresh token เปิด Drive ของพนักงานได้หลายเดือน
 *   2. **ไม่มีอะไรลบไฟล์ของผู้ใช้** ต้นทางหาย สิทธิ์หาย บัญชีถูกตัด - ทุกกรณี
 *      สำเนาใน NAS ต้องอยู่ครบ
 */

const prefix = `f19-${Date.now().toString(36)}`;
/** อ่านไฟล์ที่เก็บไว้ทั้งไฟล์ - ใช้ยืนยันว่า checksum ตรงกับไบต์จริง */
async function readStoredFile(storageKey: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of createStoredFileStream(storageKey)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

const audit = { ipAddress: '198.51.100.20', userAgent: 'Mozilla/5.0 Chrome/120' };
const stream = (text: string) => Readable.from([Buffer.from(text, 'utf8')]);

const DOC_MIME = 'application/vnd.google-apps.document';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const makeUser = (
  id: string,
  email: string,
  displayName: string,
  roles: string[],
  extra: string[] = [],
  type: AuthUser['type'] = 'INTERNAL',
): AuthUser => ({
  id,
  email,
  displayName,
  type,
  status: 'ACTIVE',
  mustChangePassword: false,
  roles,
  permissions: ['resources:read', 'resources:write', 'resources:delete', ...extra],
});

const rejects = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;

describe('F19 การเชื่อมต่อ Google Drive', () => {
  const key = randomBytes(32);
  let provider: FakeDriveProvider;

  let owner: AuthUser;
  let other: AuthUser;
  let client: AuthUser;
  let ownerId = '';
  let otherId = '';
  let clientId = '';
  let folderId = '';
  let connectionId = '';

  const created: string[] = [];

  before(async () => {
    setCredentialCipherForTest(key);

    const rows = await Promise.all(
      [
        ['owner', 'INTERNAL'],
        ['other', 'INTERNAL'],
        ['client', 'EXTERNAL'],
      ].map(([role, type]) =>
        prisma.user.create({
          data: {
            email: `${prefix}-${role}@example.invalid`,
            displayName: `F19 ${role}`,
            type: type as 'INTERNAL' | 'EXTERNAL',
            status: 'ACTIVE',
          },
        }),
      ),
    );
    [ownerId, otherId, clientId] = rows.map((row) => row.id);

    /**
     * ผูกบทบาทจริงในฐานข้อมูล
     *
     * การซิงก์ลงมือในนามของเจ้าของการเชื่อมต่อ ซึ่งอ่านสิทธิ์จากฐานข้อมูล
     * ไม่ใช่จาก AuthUser ที่ชุดทดสอบประกอบขึ้นเอง ถ้าผู้ใช้ไม่มีบทบาทจริง
     * เส้นทางการซิงก์จะล้มเหลวด้วยเหตุผลที่ไม่เกี่ยวกับสิ่งที่กำลังทดสอบ
     */
    const adminRole = await prisma.role.findFirstOrThrow({ where: { code: 'ADMIN' } });
    const memberRole = await prisma.role.findFirstOrThrow({ where: { code: 'MEMBER' } });
    await prisma.userRole.createMany({
      data: [
        { userId: ownerId, roleId: adminRole.id },
        { userId: otherId, roleId: memberRole.id },
      ],
    });

    owner = makeUser(ownerId, rows[0].email, rows[0].displayName, ['ADMIN'], ['admin:access']);
    other = makeUser(otherId, rows[1].email, rows[1].displayName, ['MEMBER']);
    client = makeUser(clientId, rows[2].email, rows[2].displayName, ['MEMBER'], [], 'EXTERNAL');

    const folder = await createFolder(owner, { name: `${prefix} ปลายทาง`, parentId: null }, audit);
    folderId = folder.id;
    created.push(folderId);

    const connection = await prisma.googleDriveConnection.create({
      data: {
        userId: ownerId,
        providerSubject: 'fake-subject-1',
        googleAccountEmail: 'drive-user@example.invalid',
        refreshTokenEncrypted: new CredentialCipher(key).encrypt('fake-refresh-token'),
        state: 'ACTIVE',
      },
    });
    connectionId = connection.id;
  });

  beforeEach(() => {
    provider = new FakeDriveProvider();
    resetPendingConnects();
  });

  after(async () => {
    const ids = new Set(created.filter(Boolean));
    const children = await prisma.resource.findMany({
      where: { parentId: { in: [...ids] } },
      select: { id: true },
    });
    for (const child of children) ids.add(child.id);
    const all = [...ids];
    const users = [ownerId, otherId, clientId];

    await prisma.googleDriveSync.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.googleDriveConnection.deleteMany({ where: { userId: { in: users } } });
    await prisma.legalHold.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.activityLog.deleteMany({ where: { userId: { in: users } } });
    await prisma.activityLog.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: all } } });

    let remaining = [...all];
    while (remaining.length > 0) {
      const parents = new Set(
        (
          await prisma.resource.findMany({
            where: { parentId: { in: remaining } },
            select: { parentId: true },
          })
        ).map((row) => row.parentId!),
      );
      const leaves = remaining.filter((id) => !parents.has(id));
      if (leaves.length === 0) break;
      await prisma.resource.deleteMany({ where: { id: { in: leaves } } });
      remaining = remaining.filter((id) => !leaves.includes(id));
    }

    await prisma.userRole.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });

    /**
     * ลบไฟล์ในที่จัดเก็บของทรัพยากรที่ชุดทดสอบสร้างเองด้วย
     *
     * การลบเฉพาะแถวในฐานข้อมูลทิ้งไฟล์ไว้กำพร้าในที่จัดเก็บ ซึ่งการซ้อมกู้คืนนับเป็น
     * orphan และรายงานว่าชุดสำรองกับฐานข้อมูลไม่ตรงกัน - เป็นเสียงรบกวนที่เกิดจาก
     * ชุดทดสอบเอง ไม่ใช่ปัญหาของระบบสำรองข้อมูล
     *
     * ลบเฉพาะไดเรกทอรีของทรัพยากรที่อยู่ในรายการที่สร้างเองเท่านั้น
     */
    for (const resourceId of all) {
      await removeResourceDirectory(resourceId).catch(() => undefined);
    }
    setCredentialCipherForTest(null);
  });

  const connection = () =>
    prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: connectionId } });

  /**
   * ขอบเขตของรอบตรวจในชุดทดสอบ - เฉพาะการเชื่อมต่อที่ชุดทดสอบสร้างเองเท่านั้น
   *
   * ชุดทดสอบรันบนฐานข้อมูลเดียวกับที่ใช้งานจริง และบางชุดสลับกุญแจถอดรหัสเป็น
   * ค่าสุ่ม ถ้ารอบตรวจกวาดทั้งฐานข้อมูล มันจะไปเจอการเชื่อมต่อจริงของผู้ใช้
   * ถอดรหัสไม่ผ่าน แล้วเขียนสถานะ CREDENTIAL_UNREADABLE ทับของจริง (D2)
   *
   * ห้ามเรียก runSyncBatch ในชุดทดสอบโดยไม่ส่งตัวเลือกนี้
   */
  const fixtureOnly = () => dueSyncsForConnections([connectionId]);

  /* ================================================================ */
  /* การเข้ารหัสข้อมูลรับรอง                                             */
  /* ================================================================ */

  describe('การเข้ารหัสข้อมูลรับรอง', () => {
    test('เข้ารหัสแล้วถอดกลับได้ค่าเดิม', () => {
      const cipher = new CredentialCipher(key);
      const secret = 'refresh-token-ที่เป็นความลับ';
      assert.equal(cipher.decrypt(cipher.encrypt(secret)), secret);
    });

    /**
     * ค่าลับเดิมต้องได้ ciphertext ต่างกันทุกครั้ง
     *
     * ถ้าเหมือนกัน ผู้ที่เห็นฐานข้อมูลจะบอกได้ว่าผู้ใช้สองคนมี token เดียวกัน
     * หรือว่า token ของคนหนึ่งไม่เคยเปลี่ยนเลยตั้งแต่วันแรก
     */
    test('ค่าเดิมได้ ciphertext ต่างกันทุกครั้ง', () => {
      const cipher = new CredentialCipher(key);
      const a = cipher.encrypt('same-value');
      const b = cipher.encrypt('same-value');
      assert.notEqual(a, b);
      assert.equal(cipher.decrypt(a), cipher.decrypt(b));
    });

    test('ข้อความธรรมดาไม่ปรากฏใน ciphertext', () => {
      const cipher = new CredentialCipher(key);
      const secret = 'super-secret-refresh-token';
      const encrypted = cipher.encrypt(secret);
      assert.ok(!encrypted.includes(secret));
      assert.ok(!Buffer.from(encrypted, 'utf8').includes(Buffer.from(secret, 'utf8')));
    });

    /** GCM ตรวจจับการแก้ไบต์ได้ - โหมดที่ไม่ยืนยันตัวตนทำไม่ได้ */
    test('ไบต์ที่ถูกแก้ถูกตรวจจับ', () => {
      const cipher = new CredentialCipher(key);
      const encrypted = cipher.encrypt('value');
      const parts = encrypted.split(':');
      const tampered = Buffer.from(parts[3]!, 'base64');
      tampered[0] = tampered[0]! ^ 0xff;

      assert.throws(
        () => cipher.decrypt([parts[0], parts[1], parts[2], tampered.toString('base64')].join(':')),
        rejects('CREDENTIAL_UNREADABLE'),
      );
    });

    test('กุญแจผิดถอดไม่ได้', () => {
      const encrypted = new CredentialCipher(key).encrypt('value');
      assert.throws(
        () => new CredentialCipher(randomBytes(32)).decrypt(encrypted),
        rejects('CREDENTIAL_UNREADABLE'),
      );
    });

    test('รูปแบบที่ผิดถูกปฏิเสธ ไม่ใช่เดาค่า', () => {
      const cipher = new CredentialCipher(key);
      for (const bad of ['', 'ไม่ใช่รูปแบบ', 'v1:a:b', 'v2:a:b:c']) {
        assert.throws(() => cipher.decrypt(bad), rejects('CREDENTIAL_UNREADABLE'));
      }
    });

    test('กุญแจต้องยาว 32 ไบต์พอดี', () => {
      assert.equal(parseEncryptionKey(undefined), null);
      assert.equal(parseEncryptionKey(''), null);
      assert.equal(parseEncryptionKey('สั้นเกินไป'), null);
      assert.equal(parseEncryptionKey(randomBytes(16).toString('base64')), null);

      assert.equal(parseEncryptionKey(key.toString('base64'))?.length, 32);
      assert.equal(parseEncryptionKey(key.toString('hex'))?.length, 32);
    });
  });

  /* ================================================================ */
  /* สิทธิ์ในการเชื่อมต่อ                                                 */
  /* ================================================================ */

  describe('สิทธิ์ในการเชื่อมต่อ', () => {
    test('บัญชีลูกค้าเชื่อมต่อไม่ได้', () => {
      assert.throws(() => assertCanConnect(client), rejects('GOOGLE_DRIVE_CONNECT_DENIED'));
    });

    test('บัญชีบริการเชื่อมต่อไม่ได้', () => {
      const service = makeUser('svc', 'svc@example.invalid', 'Service', [], [], 'SERVICE');
      assert.throws(() => assertCanConnect(service), rejects('GOOGLE_DRIVE_CONNECT_DENIED'));
    });

    test('ผู้ใช้อื่นตัดการเชื่อมต่อของคนอื่นไม่ได้', async () => {
      await assert.rejects(
        () => disconnect(connectionId, other, provider, audit),
        rejects('GOOGLE_DRIVE_CONNECTION_NOT_FOUND'),
      );
    });

    /**
     * ผู้ดูแลระบบก็เข้าไม่ได้
     *
     * การดูแลระบบคือการเห็นสถานะ ไม่ใช่การใช้ Drive ของคนอื่น
     * พนักงานยินยอมให้ระบบอ่าน Drive ของเขา ไม่ได้ยินยอมให้เพื่อนร่วมงานอ่าน
     */
    test('ผู้ดูแลระบบใช้การเชื่อมต่อของคนอื่นไม่ได้', async () => {
      const admin = makeUser(otherId, other.email, other.displayName, ['SUPER_ADMIN'], [
        'admin:access',
      ]);
      await assert.rejects(
        () => disconnect(connectionId, admin, provider, audit),
        rejects('GOOGLE_DRIVE_CONNECTION_NOT_FOUND'),
      );
    });
  });

  /* ================================================================ */
  /* state ของ OAuth                                                  */
  /* ================================================================ */

  describe('state ของ OAuth', () => {
    test('state ใช้ได้ครั้งเดียว', () => {
      const { state } = beginConnect(owner, provider);
      assert.equal(consumeState(state).userId, ownerId);
      assert.throws(() => consumeState(state), rejects('GOOGLE_DRIVE_STATE_INVALID'));
    });

    test('state ที่ไม่รู้จักถูกปฏิเสธ', () => {
      assert.throws(() => consumeState('ไม่เคยมี'), rejects('GOOGLE_DRIVE_STATE_INVALID'));
      assert.throws(() => consumeState(undefined), rejects('GOOGLE_DRIVE_STATE_INVALID'));
    });

    test('state หมดอายุแล้วใช้ไม่ได้', () => {
      const start = Date.now();
      const { state } = beginConnect(owner, provider, {}, start);
      assert.throws(
        () => consumeState(state, start + 11 * 60 * 1000),
        rejects('GOOGLE_DRIVE_STATE_EXPIRED'),
      );
    });

    /** state ผูกกับผู้ใช้ที่กด ไม่ใช่กับใครก็ได้ที่เปิด callback */
    test('state ผูกกับผู้ใช้ที่เริ่มคำขอ', () => {
      const a = beginConnect(owner, provider);
      const b = beginConnect(makeUser(otherId, other.email, other.displayName, ['MEMBER']), provider);
      assert.equal(consumeState(a.state).userId, ownerId);
      assert.equal(consumeState(b.state).userId, otherId);
    });

    test('คำขอเชื่อมต่อใช้ PKCE และขอ offline access', () => {
      const { url } = beginConnect(owner, provider, { forceConsent: true });
      const parsed = new URL(url);
      assert.ok(parsed.searchParams.get('code_challenge'));
      assert.equal(parsed.searchParams.get('access_type'), 'offline');
      assert.equal(parsed.searchParams.get('prompt'), 'consent');
    });
  });

  /* ================================================================ */
  /* วงจรชีวิตของ token                                                 */
  /* ================================================================ */

  describe('วงจรชีวิตของ token', () => {
    test('เชื่อมต่อซ้ำโดยไม่มี refresh token ใหม่ ไม่ลบของเดิม', async () => {
      const before = await connection();
      assert.ok(before.refreshTokenEncrypted);

      provider.nextRefreshToken = null;
      const tokens = await provider.exchangeCode();
      await completeConnect(ownerId, tokens, provider.account, audit);

      const after = await connection();
      assert.equal(
        after.refreshTokenEncrypted,
        before.refreshTokenEncrypted,
        'Google ไม่คืน refresh token ทุกครั้ง - ของเดิมต้องอยู่ต่อ',
      );
    });

    test('access token ที่ยังไม่หมดอายุถูกใช้ซ้ำ ไม่ต่ออายุใหม่', async () => {
      const cipher = new CredentialCipher(key);
      await prisma.googleDriveConnection.update({
        where: { id: connectionId },
        data: {
          accessTokenEncrypted: cipher.encrypt('still-valid'),
          tokenExpiresAt: new Date(Date.now() + 600_000),
        },
      });

      const token = await accessTokenFor(await connection(), provider);
      assert.equal(token, 'still-valid');
      assert.equal(provider.calls.refresh, 0, 'ไม่ควรเรียกต่ออายุโดยไม่จำเป็น');
    });

    test('access token ที่หมดอายุถูกต่อให้เอง', async () => {
      await prisma.googleDriveConnection.update({
        where: { id: connectionId },
        data: { tokenExpiresAt: new Date(Date.now() - 1000) },
      });

      const token = await accessTokenFor(await connection(), provider);
      assert.equal(token, 'fake-access-token-refreshed');
      assert.equal(provider.calls.refresh, 1);
    });

    test('refresh token ที่ถูกเพิกถอนทำให้ต้องเชื่อมต่อใหม่ - ไม่ลบอะไร', async () => {
      await prisma.googleDriveConnection.update({
        where: { id: connectionId },
        data: { tokenExpiresAt: new Date(Date.now() - 1000) },
      });
      provider.refreshFails = true;

      await assert.rejects(
        async () => accessTokenFor(await connection(), provider),
        rejects('GOOGLE_DRIVE_REAUTH_REQUIRED'),
      );

      const after = await connection();
      assert.equal(after.state, 'REAUTH_REQUIRED');
      assert.ok(after.refreshTokenEncrypted, 'ข้อมูลรับรองต้องไม่ถูกลบทิ้ง');

      await prisma.googleDriveConnection.update({
        where: { id: connectionId },
        data: { state: 'ACTIVE' },
      });
    });

    /**
     * กุญแจหาย = ล้มแบบปิดประตู ไม่ใช่ทำลายข้อมูล
     *
     * กุญแจอาจกลับมาได้จากที่สำรอง ถ้าลบข้อมูลรับรองทิ้งตอนนี้
     * การกู้กุญแจคืนในภายหลังจะไม่ช่วยอะไรอีกต่อไป
     */
    test('กุญแจผิดทำให้อ่านข้อมูลรับรองไม่ได้ แต่ไม่ลบทิ้ง', async () => {
      await prisma.googleDriveConnection.update({
        where: { id: connectionId },
        data: { tokenExpiresAt: new Date(Date.now() - 1000) },
      });

      setCredentialCipherForTest(randomBytes(32));
      try {
        await assert.rejects(
          async () => accessTokenFor(await connection(), provider),
          rejects('CREDENTIAL_UNREADABLE'),
        );
      } finally {
        setCredentialCipherForTest(key);
      }

      const after = await connection();
      assert.equal(after.state, 'CREDENTIAL_UNREADABLE');
      assert.ok(after.refreshTokenEncrypted, 'ข้อมูลรับรองต้องยังอยู่ เผื่อกุญแจกลับมา');

      await prisma.googleDriveConnection.update({
        where: { id: connectionId },
        data: { state: 'ACTIVE' },
      });
    });

    test('ข้อมูลที่ส่งให้หน้าจอไม่มี token ใด ๆ', async () => {
      const dto = toConnectionDto(await connection(), 3);
      const payload = JSON.stringify(dto);

      for (const forbidden of [
        'accessToken',
        'refreshToken',
        'accessTokenEncrypted',
        'refreshTokenEncrypted',
        'fake-refresh-token',
      ]) {
        assert.ok(!payload.includes(forbidden), `${forbidden} ต้องไม่อยู่ในข้อมูลที่ส่งออก`);
      }
      assert.equal(dto.syncCapable, true, 'หน้าจอรู้ได้แค่ว่าซิงก์ได้หรือไม่');
    });
  });

  /* ================================================================ */
  /* การจัดประเภทและการส่งออก                                            */
  /* ================================================================ */

  describe('การจัดประเภทไฟล์ Google', () => {
    test('แยกชนิดได้ถูกต้อง', () => {
      assert.equal(classifyEntry(FOLDER_MIME), 'FOLDER');
      assert.equal(classifyEntry(DOC_MIME), 'GOOGLE_DOC');
      assert.equal(classifyEntry(SHEET_MIME), 'GOOGLE_SHEET');
      assert.equal(classifyEntry('application/pdf'), 'BINARY');
      assert.equal(classifyEntry('application/vnd.google-apps.shortcut'), 'SHORTCUT');
      assert.equal(classifyEntry('application/vnd.google-apps.form'), 'UNSUPPORTED');
    });

    /** รูปแบบที่ยังแก้ไขต่อได้ ไม่ใช่ PDF - เอกสารที่แก้ไม่ได้คือภาพถ่ายของเอกสาร */
    test('ส่งออกเป็นรูปแบบที่แก้ไขต่อได้', () => {
      assert.match(GOOGLE_EXPORT[DOC_MIME]!.mimeType, /wordprocessingml/);
      assert.equal(GOOGLE_EXPORT[DOC_MIME]!.extension, 'docx');
      assert.match(GOOGLE_EXPORT[SHEET_MIME]!.mimeType, /spreadsheetml/);
      assert.equal(GOOGLE_EXPORT[SHEET_MIME]!.extension, 'xlsx');
    });

    /** ไฟล์ Google ไม่มีนามสกุลในชื่อ - ถ้าไม่เติม ผู้ใช้จะดาวน์โหลดไปแล้วเปิดไม่ได้ */
    test('เติมนามสกุลให้ไฟล์ Google', () => {
      const entry = {
        id: 'x',
        name: 'รายงานประจำปี',
        kind: 'GOOGLE_DOC' as const,
        mimeType: DOC_MIME,
        size: null,
        modifiedTime: null,
        version: null,
        md5Checksum: null,
        webViewLink: null,
        shortcutTargetId: null,
        parents: [],
      };
      assert.equal(importedFileName(entry), 'รายงานประจำปี.docx');
      assert.equal(importedFileName({ ...entry, name: 'มีอยู่แล้ว.docx' }), 'มีอยู่แล้ว.docx');
      assert.equal(
        importedFileName({ ...entry, mimeType: 'application/pdf', kind: 'BINARY' }),
        'รายงานประจำปี',
      );
    });
  });

  /* ================================================================ */
  /* การนำเข้า                                                         */
  /* ================================================================ */

  describe('การนำเข้า', () => {
    test('นำเข้าไฟล์ไบนารีผ่านท่ออัปโหลดเดิม', async () => {
      provider.add({
        id: 'bin-1',
        name: `${prefix}-เอกสาร.txt`,
        mimeType: 'text/plain',
        content: 'เนื้อหาจาก Google Drive',
        modifiedTime: new Date('2026-09-01T10:00:00Z'),
        version: '1',
        parents: [],
      });

      const result = await importFromDrive(
        owner,
        await connection(),
        provider,
        { fileIds: ['bin-1'], destinationParentId: folderId, mode: 'IMPORT_ONCE' },
        audit,
      );

      assert.equal(result.imported, 1);
      const resourceId = result.items[0]!.resourceId!;
      created.push(resourceId);

      const resource = await prisma.resource.findUniqueOrThrow({ where: { id: resourceId } });
      // ที่มาใช้ฟิลด์เดิมของระบบ ไม่มีระบบที่มาชุดที่สอง
      assert.equal(resource.sourceType, 'GOOGLE');
      assert.equal(resource.sourceSystem, 'GOOGLE_DRIVE');
      assert.equal(resource.sourceEntityId, 'bin-1');
      assert.equal(resource.sourceEntityType, 'text/plain');
      assert.ok(resource.checksum, 'ต้องมี checksum ที่ S2 NAS คำนวณเอง');
      assert.ok(resource.storageKey, 'ต้องผ่านท่อจัดเก็บจริง');
    });

    test('นำเข้า Google Doc โดยส่งออกเป็น DOCX', async () => {
      provider.add({
        id: 'doc-1',
        name: `${prefix}-เอกสารกูเกิล`,
        mimeType: DOC_MIME,
        content: 'เนื้อหาเอกสาร',
        modifiedTime: new Date('2026-09-01T10:00:00Z'),
        version: '1',
        parents: [],
      });

      const result = await importFromDrive(
        owner,
        await connection(),
        provider,
        { fileIds: ['doc-1'], destinationParentId: folderId, mode: 'IMPORT_ONCE' },
        audit,
      );

      assert.equal(result.imported, 1, JSON.stringify(result.items));
      const resourceId = result.items[0]!.resourceId!;
      created.push(resourceId);

      const resource = await prisma.resource.findUniqueOrThrow({ where: { id: resourceId } });
      assert.match(resource.name, /\.docx$/, 'ต้องเติมนามสกุลของรูปแบบที่ส่งออกจริง');
      /** MIME ต้องเป็นของไบต์ที่ได้จริง ไม่ใช่ของไฟล์ Google ต้นทาง */
      assert.ok(!resource.mimeType?.includes('google-apps'));
      assert.equal(provider.calls.export, 1);
      assert.equal(provider.calls.download, 0, 'ไฟล์ Google ต้องส่งออก ไม่ใช่ดาวน์โหลด');
    });

    test('นำเข้า Google Sheet โดยส่งออกเป็น XLSX', async () => {
      provider.add({
        id: 'sheet-1',
        name: `${prefix}-ตาราง`,
        mimeType: SHEET_MIME,
        content: 'ข้อมูลตาราง',
        modifiedTime: new Date('2026-09-01T10:00:00Z'),
        version: '1',
        parents: [],
      });

      const result = await importFromDrive(
        owner,
        await connection(),
        provider,
        { fileIds: ['sheet-1'], destinationParentId: folderId, mode: 'IMPORT_ONCE' },
        audit,
      );

      assert.equal(result.imported, 1, JSON.stringify(result.items));
      created.push(result.items[0]!.resourceId!);
      const resource = await prisma.resource.findUniqueOrThrow({
        where: { id: result.items[0]!.resourceId! },
      });
      assert.match(resource.name, /\.xlsx$/);
    });

    test('ไฟล์ Google ที่ส่งออกไม่ได้ถูกข้าม ไม่ใช่ล้มทั้งชุด', async () => {
      provider.add({
        id: 'form-1',
        name: `${prefix}-ฟอร์ม`,
        mimeType: 'application/vnd.google-apps.form',
        content: '',
        modifiedTime: new Date(),
        version: '1',
        parents: [],
      });

      const result = await importFromDrive(
        owner,
        await connection(),
        provider,
        { fileIds: ['form-1'], destinationParentId: folderId, mode: 'IMPORT_ONCE' },
        audit,
      );

      assert.equal(result.skipped, 1);
      assert.equal(result.failed, 0, 'ชนิดที่ไม่รองรับคือการข้าม ไม่ใช่ความล้มเหลว');
    });

    test('โครงสร้างโฟลเดอร์ถูกสร้างตามต้นทาง', async () => {
      provider.add({
        id: 'folder-1',
        name: `${prefix}-โฟลเดอร์`,
        mimeType: FOLDER_MIME,
        content: '',
        modifiedTime: new Date(),
        version: '1',
        parents: [],
      });
      provider.add({
        id: 'folder-2',
        name: 'ย่อย',
        mimeType: FOLDER_MIME,
        content: '',
        modifiedTime: new Date(),
        version: '1',
        parents: ['folder-1'],
      });
      provider.add({
        id: 'nested-file',
        name: 'ลึก.txt',
        mimeType: 'text/plain',
        content: 'ไฟล์ที่อยู่ลึก',
        modifiedTime: new Date(),
        version: '1',
        parents: ['folder-2'],
      });

      const result = await importFromDrive(
        owner,
        await connection(),
        provider,
        { fileIds: ['folder-1'], destinationParentId: folderId, mode: 'IMPORT_ONCE' },
        audit,
      );

      assert.equal(result.imported, 1, JSON.stringify(result.items));
      const imported = await prisma.resource.findUniqueOrThrow({
        where: { id: result.items[0]!.resourceId! },
        include: { parent: { include: { parent: true } } },
      });
      created.push(imported.id, imported.parentId!, imported.parent!.parentId!);

      assert.equal(imported.parent?.name, 'ย่อย');
      assert.equal(imported.parent?.parent?.name, `${prefix}-โฟลเดอร์`);
    });

    /** ทางลัดไม่มีเนื้อหาของตัวเอง - ต้องคลี่ไปหาไฟล์จริงก่อน */
    test('ทางลัดถูกคลี่ไปยังไฟล์ปลายทาง', async () => {
      provider.add({
        id: 'real-file',
        name: `${prefix}-ของจริง.txt`,
        mimeType: 'text/plain',
        content: 'เนื้อหาของไฟล์จริง',
        modifiedTime: new Date(),
        version: '1',
        parents: [],
      });
      provider.add({
        id: 'shortcut-1',
        name: 'ทางลัด',
        mimeType: 'application/vnd.google-apps.shortcut',
        content: '',
        modifiedTime: new Date(),
        version: '1',
        parents: [],
        shortcutTargetId: 'real-file',
      });

      const result = await importFromDrive(
        owner,
        await connection(),
        provider,
        { fileIds: ['shortcut-1'], destinationParentId: folderId, mode: 'IMPORT_ONCE' },
        audit,
      );

      assert.equal(result.imported, 1, JSON.stringify(result.items));
      created.push(result.items[0]!.resourceId!);
      const resource = await prisma.resource.findUniqueOrThrow({
        where: { id: result.items[0]!.resourceId! },
      });
      assert.equal(resource.sourceEntityId, 'real-file', 'ต้องผูกกับไฟล์จริง ไม่ใช่ทางลัด');
      assert.ok(Number(resource.size) > 0);
    });

    test('การผูกซ้ำในโหมดซิงก์ถูกข้าม', async () => {
      provider.add({
        id: 'dup-1',
        name: `${prefix}-ซ้ำ.txt`,
        mimeType: 'text/plain',
        content: 'เนื้อหา',
        modifiedTime: new Date(),
        version: '1',
        parents: [],
      });

      const first = await importFromDrive(
        owner,
        await connection(),
        provider,
        { fileIds: ['dup-1'], destinationParentId: folderId, mode: 'SYNCED' },
        audit,
      );
      created.push(first.items[0]!.resourceId!);

      const second = await importFromDrive(
        owner,
        await connection(),
        provider,
        { fileIds: ['dup-1'], destinationParentId: folderId, mode: 'SYNCED' },
        audit,
      );

      assert.equal(second.skipped, 1);
      assert.equal(second.imported, 0, 'ไฟล์เดียวกันต้องไม่ผูกกับสองทรัพยากร');
    });

    test('ไฟล์ที่หายจากต้นทางถูกรายงานว่าล้มเหลว ไม่ทำให้ทั้งชุดพัง', async () => {
      provider.add({
        id: 'ok-1',
        name: `${prefix}-ปกติ.txt`,
        mimeType: 'text/plain',
        content: 'ปกติ',
        modifiedTime: new Date(),
        version: '1',
        parents: [],
      });

      const result = await importFromDrive(
        owner,
        await connection(),
        provider,
        { fileIds: ['ok-1', 'ไม่มีอยู่จริง'], destinationParentId: folderId, mode: 'IMPORT_ONCE' },
        audit,
      );

      assert.equal(result.imported, 1);
      assert.equal(result.failed, 1);
      created.push(result.items.find((item) => item.outcome === 'IMPORTED')!.resourceId!);
      assert.match(result.items.find((item) => item.outcome === 'FAILED')!.reason!, /ไม่พบไฟล์/);
    });

    /** การเชื่อมต่อ Google ไม่ขยายสิทธิ์ใน NAS - ปลายทางยังตรวจเหมือนเดิม */
    test('นำเข้าไปยังโฟลเดอร์ที่ไม่มีสิทธิ์ไม่ได้', async () => {
      const restricted = await createFolder(owner, { name: `${prefix}-จำกัด`, parentId: null }, audit);
      /** createFolder สืบทอดการมองเห็นจากปลายทาง จึงตั้งค่าเป็น RESTRICTED หลังสร้าง */
      await prisma.resource.update({
        where: { id: restricted.id },
        data: { visibility: 'RESTRICTED' },
      });
      created.push(restricted.id);

      provider.add({
        id: 'perm-1',
        name: `${prefix}-สิทธิ์.txt`,
        mimeType: 'text/plain',
        content: 'x',
        modifiedTime: new Date(),
        version: '1',
        parents: [],
      });

      const outsiderConnection = await prisma.googleDriveConnection.create({
        data: {
          userId: otherId,
          providerSubject: 'fake-subject-2',
          googleAccountEmail: 'other@example.invalid',
          refreshTokenEncrypted: new CredentialCipher(key).encrypt('fake-refresh-token'),
        },
      });

      const result = await importFromDrive(
        other,
        outsiderConnection,
        provider,
        { fileIds: ['perm-1'], destinationParentId: restricted.id, mode: 'IMPORT_ONCE' },
        audit,
      );

      assert.equal(result.imported, 0);
      assert.equal(result.failed, 1, 'สิทธิ์ปลายทางต้องถูกตรวจโดยท่ออัปโหลดเดิม');
    });
  });

  /* ================================================================ */
  /* การซิงก์                                                          */
  /* ================================================================ */

  describe('การซิงก์', () => {
    /** สร้างทรัพยากรที่ซิงก์อยู่หนึ่งชิ้น พร้อมคืนรหัสที่ต้องใช้ */
    const seedSynced = async (fileId: string, content: string) => {
      provider.add({
        id: fileId,
        name: `${prefix}-${fileId}.txt`,
        mimeType: 'text/plain',
        content,
        modifiedTime: new Date('2026-09-01T10:00:00Z'),
        version: '1',
        parents: [],
      });

      const result = await importFromDrive(
        owner,
        await connection(),
        provider,
        { fileIds: [fileId], destinationParentId: folderId, mode: 'SYNCED' },
        audit,
      );
      const resourceId = result.items[0]!.resourceId!;
      created.push(resourceId);

      const sync = await prisma.googleDriveSync.findFirstOrThrow({ where: { resourceId } });
      return { resourceId, sync };
    };

    test('ต้นทางไม่เปลี่ยน ไม่สร้างเวอร์ชันใหม่', async () => {
      const { resourceId, sync } = await seedSynced('sync-unchanged', 'เนื้อหาเดิม');
      const before = await prisma.resourceVersion.count({ where: { resourceId } });

      const result = await checkOne(sync, provider, audit);

      assert.equal(result.outcome, 'UNCHANGED');
      assert.equal(await prisma.resourceVersion.count({ where: { resourceId } }), before);
    });

    test('ต้นทางเปลี่ยนเนื้อหา สร้างเวอร์ชันใหม่', async () => {
      const { resourceId, sync } = await seedSynced('sync-changed', 'ฉบับแรก');
      const before = await prisma.resourceVersion.count({ where: { resourceId } });

      provider.edit('sync-changed', 'ฉบับที่สอง แก้ไขแล้ว');
      const result = await checkOne(sync, provider, audit);

      assert.equal(result.outcome, 'VERSION_CREATED', result.message);
      assert.equal(
        await prisma.resourceVersion.count({ where: { resourceId } }),
        before + 1,
        'เวอร์ชันเดิมต้องยังอยู่ ไม่ถูกเขียนทับ',
      );
    });

    /**
     * Google ขยับ modifiedTime เมื่อมีคนเปลี่ยนชื่อหรือย้ายโฟลเดอร์
     *
     * ถ้าสร้างเวอร์ชันใหม่ทุกครั้งที่เมทาดาทาขยับ ประวัติจะเต็มไปด้วยเวอร์ชัน
     * ที่เนื้อหาเหมือนกันจนหาเวอร์ชันที่เปลี่ยนจริงไม่เจอ
     */
    test('เมทาดาทาเปลี่ยนแต่เนื้อหาเหมือนเดิม ไม่สร้างเวอร์ชันใหม่', async () => {
      const { resourceId, sync } = await seedSynced('sync-touched', 'เนื้อหาที่ไม่เปลี่ยน');
      const before = await prisma.resourceVersion.count({ where: { resourceId } });

      provider.touch('sync-touched');
      const result = await checkOne(sync, provider, audit);

      assert.equal(result.outcome, 'IDENTICAL_BYTES', result.message);
      assert.equal(await prisma.resourceVersion.count({ where: { resourceId } }), before);
    });

    /* ---- สิ่งที่สำคัญที่สุด: ไม่มีอะไรลบไฟล์ของผู้ใช้ ---- */

    test('ต้นทางหายไป ไม่ลบสำเนาใน NAS', async () => {
      const { resourceId, sync } = await seedSynced('sync-missing', 'เนื้อหาที่ต้องอยู่ต่อ');

      provider.files.get('sync-missing')!.missing = true;
      const result = await checkOne(sync, provider, audit);

      assert.equal(result.outcome, 'SOURCE_MISSING');
      assert.equal(result.status, 'SOURCE_MISSING');

      const resource = await prisma.resource.findUnique({ where: { id: resourceId } });
      assert.ok(resource, 'ทรัพยากรต้องยังอยู่');
      assert.equal(resource!.deletedAt, null, 'ต้องไม่ถูกย้ายไปถังขยะ');
      assert.ok(await prisma.resourceVersion.count({ where: { resourceId } }));
    });

    test('สิทธิ์ที่ต้นทางหายไป ไม่ลบสำเนาใน NAS', async () => {
      const { resourceId, sync } = await seedSynced('sync-forbidden', 'เนื้อหา');

      provider.files.get('sync-forbidden')!.forbidden = true;
      const result = await checkOne(sync, provider, audit);

      assert.equal(result.outcome, 'PERMISSION_LOST');
      assert.ok(await prisma.resource.findUnique({ where: { id: resourceId } }));
    });

    /* ---- วงจรชีวิตหยุดการซิงก์ ---- */

    test('Legal Hold หยุดการซิงก์และไม่สร้างเวอร์ชันใหม่', async () => {
      const { resourceId, sync } = await seedSynced('sync-hold', 'หลักฐานฉบับเดิม');
      const before = await prisma.resourceVersion.count({ where: { resourceId } });

      const hold = await placeLegalHold(
        resourceId,
        owner,
        { reason: 'ทดสอบ F19', caseReference: 'F19-QA' },
        audit,
      );

      provider.edit('sync-hold', 'เนื้อหาใหม่ที่ไม่ควรเข้ามา');
      // นับจากจุดนี้ - การนำเข้าตอนตั้งค่าก็เรียกดาวน์โหลดไปแล้วหนึ่งครั้ง
      const downloadsBefore = provider.calls.download;
      const result = await checkOne(sync, provider, audit);

      assert.equal(result.status, 'PAUSED_LEGAL_HOLD');
      assert.match(result.message, /Legal Hold/);
      assert.equal(
        await prisma.resourceVersion.count({ where: { resourceId } }),
        before,
        'ชุดหลักฐานต้องไม่เปลี่ยนโดยไม่มีมนุษย์ตัดสินใจ',
      );
      // ไม่ควรแตะ Google เลยเมื่อรู้ว่าหยุดอยู่แล้ว
      assert.equal(provider.calls.download, downloadsBefore, 'ไม่ควรมีคำขออ่านต้นทางในนามเอกสารที่ถูกระงับ');

      await releaseLegalHold(hold.id, owner, { reason: 'จบการทดสอบ' }, audit);

      // ปลดแล้วซิงก์ได้อีก
      const after = await checkOne(sync, provider, audit);
      assert.equal(after.outcome, 'VERSION_CREATED', after.message);
    });

    test('เอกสารในคลังหยุดการซิงก์ และนำออกจากคลังแล้วซิงก์ได้อีก', async () => {
      const { resourceId, sync } = await seedSynced('sync-archived', 'เนื้อหา');
      const before = await prisma.resourceVersion.count({ where: { resourceId } });

      await prisma.resource.update({
        where: { id: resourceId },
        data: { lifecycleState: 'ARCHIVED', archivedAt: new Date() },
      });
      provider.edit('sync-archived', 'เนื้อหาใหม่');

      const paused = await checkOne(sync, provider, audit);
      assert.equal(paused.status, 'PAUSED_LIFECYCLE');
      assert.equal(await prisma.resourceVersion.count({ where: { resourceId } }), before);

      await prisma.resource.update({
        where: { id: resourceId },
        data: { lifecycleState: 'ACTIVE', archivedAt: null },
      });
      const resumed = await checkOne(sync, provider, audit);
      assert.equal(resumed.outcome, 'VERSION_CREATED', resumed.message);
    });

    test('เอกสารในถังขยะหยุดการซิงก์ และกู้คืนแล้วซิงก์ได้อีก', async () => {
      const { resourceId, sync } = await seedSynced('sync-trashed', 'เนื้อหา');

      await trashResource(resourceId, owner, audit);
      provider.edit('sync-trashed', 'เนื้อหาใหม่');

      const paused = await checkOne(sync, provider, audit);
      assert.equal(paused.status, 'PAUSED_LIFECYCLE');

      await restoreResource(resourceId, owner, {}, audit);
      const resumed = await checkOne(sync, provider, audit);
      assert.equal(resumed.outcome, 'VERSION_CREATED', resumed.message);
    });

    test('lifecyclePause บอกเหตุที่หยุดได้ถูกต้อง', async () => {
      const { resourceId } = await seedSynced('sync-pause-reason', 'x');
      assert.equal(await lifecyclePause(resourceId), null);

      await prisma.resource.update({
        where: { id: resourceId },
        data: { lifecycleState: 'ARCHIVED' },
      });
      assert.equal(await lifecyclePause(resourceId), 'ARCHIVED');

      await prisma.resource.update({
        where: { id: resourceId },
        data: { lifecycleState: 'ACTIVE', deletedAt: new Date() },
      });
      assert.equal(await lifecyclePause(resourceId), 'TRASHED');

      await prisma.resource.update({ where: { id: resourceId }, data: { deletedAt: null } });
    });

    /* ---- หยุดซิงก์ ---- */

    test('หยุดซิงก์แล้วไฟล์และประวัติยังอยู่ครบ', async () => {
      const { resourceId, sync } = await seedSynced('sync-detach', 'เนื้อหา');
      const versions = await prisma.resourceVersion.count({ where: { resourceId } });

      await detach(resourceId, owner, audit);

      const resource = await prisma.resource.findUnique({ where: { id: resourceId } });
      assert.ok(resource, 'ไฟล์ต้องยังอยู่');
      assert.equal(await prisma.resourceVersion.count({ where: { resourceId } }), versions);
      assert.equal(resource!.sourceEntityId, 'sync-detach', 'ที่มายังอยู่เพื่อการตรวจสอบ');

      const after = await prisma.googleDriveSync.findUniqueOrThrow({ where: { id: sync.id } });
      assert.ok(after.detachedAt);
      assert.equal(after.syncEnabled, false);

      provider.edit('sync-detach', 'เนื้อหาใหม่ที่ไม่ควรเข้ามา');
      const result = await checkOne(after, provider, audit);
      assert.equal(result.status, 'DETACHED');
    });

    /**
     * ห้ามอัปโหลดทับไฟล์ที่กำลังซิงก์
     *
     * ถ้าอนุญาต รอบซิงก์ถัดไปจะทับงานที่คนเพิ่งอัปโหลดโดยไม่ถามใคร
     */
    test('อัปโหลดเวอร์ชันทับไฟล์ที่กำลังซิงก์ไม่ได้', async () => {
      const { resourceId } = await seedSynced('sync-noupload', 'เนื้อหา');

      await assert.rejects(
        () => uploadVersion(owner, resourceId, stream('ฉบับที่คนอัปโหลดเอง'), {}, audit),
        rejects('GOOGLE_DRIVE_SYNC_ACTIVE'),
      );

      // หยุดซิงก์แล้วอัปโหลดได้
      await detach(resourceId, owner, audit);
      const updated = await uploadVersion(
        owner,
        resourceId,
        stream('ฉบับที่คนอัปโหลดเอง'),
        {},
        audit,
      );
      assert.ok(updated.id);
    });

    test('การอัปโหลดด้วยมือยังสร้างเวอร์ชันได้แม้ไบต์เหมือนเวอร์ชันปัจจุบัน', async () => {
      const content = 'เนื้อหาเดิมที่ผู้ใช้ตั้งใจอัปโหลดซ้ำ';
      const { resourceId } = await seedSynced('sync-manual-identical', content);
      await detach(resourceId, owner, audit);
      const before = await prisma.resourceVersion.count({ where: { resourceId } });

      await uploadVersion(owner, resourceId, stream(content), { remark: 'หมุดเวลาโดยผู้ใช้' }, audit);

      assert.equal(
        await prisma.resourceVersion.count({ where: { resourceId } }),
        before + 1,
        'checksum dedupe ต้องใช้เฉพาะ Google sync ไม่เปลี่ยนพฤติกรรมการอัปโหลดด้วยมือ',
      );
    });

    /* ---- ตัวทำงานเบื้องหลัง ---- */

    test('ตัวทำงานเบื้องหลังใช้เส้นทางเดียวกับปุ่มตรวจสอบ', async () => {
      const { resourceId } = await seedSynced('sync-worker', 'เนื้อหาเดิม');
      const before = await prisma.resourceVersion.count({ where: { resourceId } });

      provider.edit('sync-worker', 'เนื้อหาที่ตัวทำงานควรเจอ');
      // ทำให้ถึงคิวตรวจทันที
      await prisma.googleDriveSync.updateMany({
        where: { resourceId },
        data: { lastCheckedAt: new Date('2020-01-01') },
      });

      const done = await runSyncBatch(provider, new Date(), fixtureOnly());
      assert.ok(done >= 1);
      assert.equal(await prisma.resourceVersion.count({ where: { resourceId } }), before + 1);
    });

    test('ตัวทำงานข้ามการเชื่อมต่อที่ต้องยืนยันตัวตนใหม่', async () => {
      const { resourceId } = await seedSynced('sync-skip', 'เนื้อหา');
      await prisma.googleDriveSync.updateMany({
        where: { resourceId },
        data: { lastCheckedAt: new Date('2020-01-01') },
      });
      await prisma.googleDriveConnection.update({
        where: { id: connectionId },
        data: { state: 'REAUTH_REQUIRED' },
      });

      const before = provider.calls.metadata;
      await runSyncBatch(provider, new Date(), fixtureOnly());
      assert.equal(
        provider.calls.metadata,
        before,
        'ไม่ควรยิงคำขอที่รู้ผลอยู่แล้วไปที่ Google',
      );

      await prisma.googleDriveConnection.update({
        where: { id: connectionId },
        data: { state: 'ACTIVE' },
      });
    });



    /* ---- เนื้อหาของไฟล์ Google กับการสร้างเวอร์ชันซ้ำ (D1) ---- */

    /**
     * ไฟล์ Google ที่ซิงก์อยู่หนึ่งชิ้น
     *
     * ต่างจาก seedSynced ตรงที่ชนิดเป็นเอกสารของ Google ซึ่งต้องส่งออกเป็น OOXML
     * และตัวปลอมจะประทับเวลาที่ส่งออกใหม่ทุกครั้ง เหมือนของจริง
     */
    const seedSyncedGoogleDoc = async (fileId: string, body: string) => {
      provider.add({
        id: fileId,
        name: `${prefix}-${fileId}`,
        mimeType: 'application/vnd.google-apps.document',
        content: body,
        modifiedTime: new Date('2026-09-01T10:00:00Z'),
        version: '1',
        parents: [],
      });

      const result = await importFromDrive(
        owner,
        await connection(),
        provider,
        { fileIds: [fileId], destinationParentId: folderId, mode: 'SYNCED' },
        audit,
      );
      const resourceId = result.items[0]!.resourceId!;
      created.push(resourceId);
      const sync = await prisma.googleDriveSync.findFirstOrThrow({ where: { resourceId } });
      return { resourceId, sync };
    };

    const reload = (id: string) => prisma.googleDriveSync.findFirstOrThrow({ where: { id } });
    const versions = (resourceId: string) =>
      prisma.resourceVersion.count({ where: { resourceId } });

    /**
     * หัวใจของ D1
     *
     * Google ขยับ `version` เองโดยที่เอกสารไม่มีใครแก้ การส่งออกครั้งใหม่ได้ไบต์
     * ต่างจากเดิมเพราะเวลาใน ZIP เปลี่ยน ถ้าตัดสินด้วย SHA-256 ของทั้งไฟล์
     * จะได้เวอร์ชันใหม่ที่เอกสารเหมือนเดิมทุกตัวอักษร
     */
    test('ต้นทาง Google ขยับเมทาดาทาแต่เนื้อหาเท่าเดิม ไม่สร้างเวอร์ชันใหม่', async () => {
      const { resourceId, sync } = await seedSyncedGoogleDoc('d1-touch', '<w:p>เนื้อหาคงเดิม</w:p>');
      const before = await versions(resourceId);

      provider.touch('d1-touch');
      const result = await checkOne(await reload(sync.id), provider, audit);

      assert.equal(result.outcome, 'IDENTICAL_BYTES', result.message);
      assert.equal(await versions(resourceId), before, 'ต้องไม่มีเวอร์ชันซ้ำจากเวลาใน ZIP');
    });

    test('ต้นทาง Google ขยับซ้ำหลายรอบ ก็ยังไม่งอกเวอร์ชัน', async () => {
      const { resourceId, sync } = await seedSyncedGoogleDoc('d1-repeat', '<w:p>นิ่ง</w:p>');
      const before = await versions(resourceId);

      for (let round = 0; round < 3; round += 1) {
        provider.touch('d1-repeat');
        const result = await checkOne(await reload(sync.id), provider, audit);
        assert.equal(result.outcome, 'IDENTICAL_BYTES', `รอบที่ ${round + 1}: ${result.message}`);
      }

      assert.equal(await versions(resourceId), before);
    });

    test('เนื้อหาในเอกสาร Google เปลี่ยนจริง สร้างเวอร์ชันใหม่หนึ่งเวอร์ชันพอดี', async () => {
      const { resourceId, sync } = await seedSyncedGoogleDoc('d1-edit', '<w:p>ฉบับแรก</w:p>');
      const before = await versions(resourceId);

      provider.edit('d1-edit', '<w:p>ฉบับแก้ไขแล้ว</w:p>');
      const result = await checkOne(await reload(sync.id), provider, audit);

      assert.equal(result.outcome, 'VERSION_CREATED', result.message);
      assert.equal(await versions(resourceId), before + 1);

      // ตรวจซ้ำโดยไม่มีการแก้เพิ่ม ต้องไม่งอกอีก
      provider.touch('d1-edit');
      const again = await checkOne(await reload(sync.id), provider, audit);
      assert.equal(again.outcome, 'IDENTICAL_BYTES', again.message);
      assert.equal(await versions(resourceId), before + 1);
    });

    /**
     * ResourceVersion.checksum ต้องยังเป็น SHA-256 ของไบต์ที่เก็บจริงเสมอ
     *
     * ลายนิ้วมือเป็นคนละความหมายและอยู่คนละที่ ถ้าเอาลายนิ้วมือไปทับ checksum
     * การตรวจความถูกต้องของไฟล์ที่เก็บไว้จะเชื่อถือไม่ได้อีกต่อไป
     */
    test('checksum ของเวอร์ชันยังเป็นแฮชของไบต์จริง ไม่ใช่ลายนิ้วมือ', async () => {
      const { resourceId, sync } = await seedSyncedGoogleDoc('d1-checksum', '<w:p>ตรวจ checksum</w:p>');
      /**
       * ลายนิ้วมือถูกคำนวณเฉพาะรอบที่ดาวน์โหลดจริงเท่านั้น
       *
       * รอบที่เมทาดาทาไม่ขยับจะตอบ UNCHANGED โดยไม่ดึงไฟล์ - ซึ่งเป็นเจตนา
       * เพราะการดาวน์โหลดทุกรอบเพื่อเติมฟิลด์เป็นการจ่ายค่าโควตาฟรี ๆ
       */
      provider.touch('d1-checksum');
      await checkOne(await reload(sync.id), provider, audit);
      const version = await prisma.resourceVersion.findFirstOrThrow({
        where: { resourceId },
        orderBy: { versionNumber: 'desc' },
      });

      const stored = await readStoredFile(version.storageKey);
      assert.equal(
        createHash('sha256').update(stored).digest('hex'),
        version.checksum,
        'checksum ต้องตรงกับไบต์ที่เก็บไว้จริง',
      );

      const after = await reload(sync.id);
      assert.ok(after.lastContentFingerprint?.startsWith('ooxml:'), 'ลายนิ้วมือต้องถูกเก็บแยกจาก checksum');
      assert.notEqual(after.lastContentFingerprint, version.checksum);
    });

    /**
     * แถวเก่าที่มีอยู่ก่อนฟิลด์ลายนิ้วมือ ต้องไม่ได้เวอร์ชันซ้ำฟรีหนึ่งรอบ
     */
    test('แถวที่ยังไม่มีลายนิ้วมือ ไม่สร้างเวอร์ชันซ้ำตอนเติมค่าครั้งแรก', async () => {
      const { resourceId, sync } = await seedSyncedGoogleDoc('d1-backfill', '<w:p>ของเดิม</w:p>');
      await prisma.googleDriveSync.update({
        where: { id: sync.id },
        data: { lastContentFingerprint: null },
      });
      const before = await versions(resourceId);

      provider.touch('d1-backfill');
      const result = await checkOne(await reload(sync.id), provider, audit);

      assert.equal(result.outcome, 'IDENTICAL_BYTES', result.message);
      assert.equal(await versions(resourceId), before, 'การเติมฟิลด์ใหม่ต้องไม่สร้างเวอร์ชัน');
      const after = await reload(sync.id);
      assert.ok(after.lastContentFingerprint?.startsWith('ooxml:'), 'ต้องเติมลายนิ้วมือไว้แล้ว');
    });

    /** ไฟล์ไบนารีปกติต้องมีพฤติกรรมเดิมทุกประการ */
    test('ไฟล์ไบนารีปกติ: ไบต์เท่าเดิมไม่งอกเวอร์ชัน ไบต์เปลี่ยนได้เวอร์ชันใหม่', async () => {
      const { resourceId, sync } = await seedSynced('d1-binary', 'ไบต์ชุดแรก');
      const before = await versions(resourceId);

      provider.touch('d1-binary');
      const same = await checkOne(await reload(sync.id), provider, audit);
      assert.equal(same.outcome, 'IDENTICAL_BYTES', same.message);
      assert.equal(await versions(resourceId), before);

      provider.edit('d1-binary', 'ไบต์ชุดที่สอง');
      const changed = await checkOne(await reload(sync.id), provider, audit);
      assert.equal(changed.outcome, 'VERSION_CREATED', changed.message);
      assert.equal(await versions(resourceId), before + 1);
    });

    /* ---- ความปลอดภัยของชุดทดสอบ: ห้ามแตะแถวที่ไม่ใช่ของตัวเอง (D2) ---- */

    /**
     * สร้างการเชื่อมต่อและการผูกที่หน้าตาเหมือนของจริงและถึงคิวตรวจแล้ว
     * แต่ไม่ได้อยู่ในขอบเขตของชุดทดสอบ - ตัวแทนของข้อมูลผู้ใช้จริงในฐานข้อมูลเดียวกัน
     */
    const seedOutsider = async (tag: string) => {
      const user = await prisma.user.create({
        data: {
          email: `${prefix}-outsider-${tag}@example.invalid`,
          displayName: 'F19 outsider',
          type: 'INTERNAL',
          status: 'ACTIVE',
        },
      });
      const folder = await createFolder(owner, { name: `${prefix} outsider ${tag}`, parentId: null }, audit);
      const conn = await prisma.googleDriveConnection.create({
        data: {
          userId: user.id,
          providerSubject: `outsider-subject-${tag}`,
          googleAccountEmail: `outsider-${tag}@example.invalid`,
          refreshTokenEncrypted: new CredentialCipher(key).encrypt('outsider-refresh-token'),
          state: 'ACTIVE',
        },
      });
      const sync = await prisma.googleDriveSync.create({
        data: {
          connectionId: conn.id,
          resourceId: folder.id,
          googleFileId: `outsider-file-${tag}`,
          mode: 'SYNCED',
          syncEnabled: true,
          // ถึงคิวตรวจแน่นอน - ถ้าขอบเขตรั่ว รอบตรวจจะหยิบแถวนี้ขึ้นมาแน่
          lastCheckedAt: new Date('2020-01-01'),
        },
      });
      return { userId: user.id, folderId: folder.id, connectionId: conn.id, syncId: sync.id };
    };

    /** ลบเฉพาะแถวที่ตัวเองสร้าง - ห้ามกวาดการเชื่อมต่อทั้งตาราง */
    const dropOutsider = async (o: { userId: string; folderId: string; connectionId: string }) => {
      await prisma.googleDriveSync.deleteMany({ where: { connectionId: o.connectionId } });
      await prisma.googleDriveConnection.deleteMany({ where: { id: o.connectionId } });
      await prisma.resource.deleteMany({ where: { id: o.folderId } });
      await prisma.user.deleteMany({ where: { id: o.userId } });
    };

    test('รอบตรวจของชุดทดสอบไม่แตะการเชื่อมต่อที่ไม่ใช่ของตัวเอง', async () => {
      const outsider = await seedOutsider('batch');
      try {
        const { resourceId } = await seedSynced('sync-isolation', 'เนื้อหาเดิม');
        provider.edit('sync-isolation', 'เนื้อหาใหม่ที่ควรถูกซิงก์');
        await prisma.googleDriveSync.updateMany({
          where: { resourceId },
          data: { lastCheckedAt: new Date('2020-01-01') },
        });

        const connBefore = await prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: outsider.connectionId } });
        const syncBefore = await prisma.googleDriveSync.findUniqueOrThrow({ where: { id: outsider.syncId } });
        const versionsBefore = await prisma.resourceVersion.count({ where: { resourceId } });

        const done = await runSyncBatch(provider, new Date(), fixtureOnly());

        // แถวของ fixture ต้องถูกประมวลผลจริง ไม่งั้นการทดสอบนี้ผ่านแบบว่างเปล่า
        assert.ok(done >= 1, 'รอบตรวจต้องทำงานกับแถวของ fixture จริง');
        assert.equal(
          await prisma.resourceVersion.count({ where: { resourceId } }),
          versionsBefore + 1,
        );

        const connAfter = await prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: outsider.connectionId } });
        const syncAfter = await prisma.googleDriveSync.findUniqueOrThrow({ where: { id: outsider.syncId } });
        assert.deepEqual(connAfter, connBefore, 'การเชื่อมต่อนอกขอบเขตต้องไม่ถูกแตะแม้แต่ฟิลด์เดียว');
        assert.deepEqual(syncAfter, syncBefore, 'การผูกนอกขอบเขตต้องไม่ถูกแตะแม้แต่ฟิลด์เดียว');
      } finally {
        await dropOutsider(outsider);
      }
    });

    /**
     * กรณีที่ทำให้ข้อมูลจริงพังมาแล้ว
     *
     * กุญแจผิด + รอบตรวจที่กวาดทั้งฐานข้อมูล = การเชื่อมต่อจริงถูกเขียนเป็น
     * CREDENTIAL_UNREADABLE ทั้งที่ข้อมูลรับรองไม่มีอะไรผิดเลย
     */
    test('กุญแจถอดรหัสผิดต้องไม่ทำให้การเชื่อมต่อที่ไม่เกี่ยวข้องเสียหาย', async () => {
      const outsider = await seedOutsider('cipher');
      try {
        const connBefore = await prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: outsider.connectionId } });
        const syncBefore = await prisma.googleDriveSync.findUniqueOrThrow({ where: { id: outsider.syncId } });

        setCredentialCipherForTest(randomBytes(32));
        try {
          await runSyncBatch(provider, new Date(), fixtureOnly());
        } finally {
          setCredentialCipherForTest(key);
        }

        const connAfter = await prisma.googleDriveConnection.findUniqueOrThrow({ where: { id: outsider.connectionId } });
        const syncAfter = await prisma.googleDriveSync.findUniqueOrThrow({ where: { id: outsider.syncId } });
        assert.equal(connAfter.state, 'ACTIVE', 'กุญแจผิดของชุดทดสอบต้องไม่ลาม');
        assert.equal(connAfter.lastErrorCode, null);
        assert.deepEqual(connAfter, connBefore);
        assert.deepEqual(syncAfter, syncBefore);
      } finally {
        await dropOutsider(outsider);
      }
    });

    /**
     * ตัวเลือกของจริงยังกวาดทั้งฐานข้อมูลตามเดิม
     *
     * ถ้าการแก้ D2 ทำให้ระบบจริงมองไม่เห็นงาน การซิงก์เบื้องหลังจะเงียบไปทั้งระบบ
     * โดยไม่มีใครรู้ - จึงต้องยืนยันว่าเกณฑ์ของจริงยังหยิบแถวที่ถึงคิวได้อยู่
     */
    test('ตัวเลือกของจริงยังมองเห็นงานที่ถึงคิวตามเกณฑ์เดิม', async () => {
      const outsider = await seedOutsider('selector');
      try {
        const due = await selectDueSyncs(new Date());
        assert.ok(
          due.some((row) => row.id === outsider.syncId),
          'ตัวเลือกของจริงต้องยังหยิบการผูกที่เปิดอยู่และถึงคิว',
        );
        const scoped = await fixtureOnly()(new Date());
        assert.ok(
          scoped.every((row) => row.id !== outsider.syncId),
          'ตัวเลือกที่จำกัดขอบเขตต้องมองไม่เห็นแถวนอกขอบเขต',
        );
      } finally {
        await dropOutsider(outsider);
      }
    });

    test('ข้อมูลการซิงก์ที่ส่งให้หน้าจอไม่มีความลับ', async () => {
      const { resourceId } = await seedSynced('sync-dto', 'เนื้อหา');
      const info = await resourceSyncInfo(resourceId, owner);

      assert.ok(info);
      assert.equal(info!.googleAccountEmail, 'drive-user@example.invalid');
      const payload = JSON.stringify(info);
      for (const secret of ['refreshToken', 'accessToken', 'Encrypted', 'fake-refresh-token']) {
        assert.ok(!payload.includes(secret), `${secret} ต้องไม่อยู่ในข้อมูลของหน้าจอ`);
      }
    });

    test('ผู้ที่ไม่มีสิทธิ์กับทรัพยากรดูข้อมูลการซิงก์ไม่ได้', async () => {
      const restricted = await createFolder(owner, { name: `${prefix}-ซิงก์ลับ`, parentId: null }, audit);
      /** createFolder สืบทอดการมองเห็นจากปลายทาง จึงตั้งค่าเป็น RESTRICTED หลังสร้าง */
      await prisma.resource.update({
        where: { id: restricted.id },
        data: { visibility: 'RESTRICTED' },
      });
      created.push(restricted.id);

      const uploaded = await uploadFile(
        owner,
        stream('ลับ'),
        { parentId: restricted.id, fileName: `${prefix}-ลับ.txt`, allowDuplicateContent: true },
        audit,
      );
      created.push(uploaded.resource.id);

      assert.equal(await resourceSyncInfo(uploaded.resource.id, other), null);
    });
  });

  /* ================================================================ */
  /* การตัดการเชื่อมต่อ                                                  */
  /* ================================================================ */

  describe('การตัดการเชื่อมต่อ', () => {
    test('ตัดการเชื่อมต่อแล้วไฟล์ยังอยู่ครบ และข้อมูลรับรองหายไป', async () => {
      const throwaway = await prisma.googleDriveConnection.create({
        data: {
          userId: ownerId,
          providerSubject: 'fake-subject-disconnect',
          googleAccountEmail: 'disconnect@example.invalid',
          accessTokenEncrypted: new CredentialCipher(key).encrypt('access'),
          refreshTokenEncrypted: new CredentialCipher(key).encrypt('refresh'),
        },
      });

      provider.add({
        id: 'disc-1',
        name: `${prefix}-ตัดการเชื่อมต่อ.txt`,
        mimeType: 'text/plain',
        content: 'เนื้อหาที่ต้องอยู่ต่อ',
        modifiedTime: new Date(),
        version: '1',
        parents: [],
      });

      const imported = await importFromDrive(
        owner,
        throwaway,
        provider,
        { fileIds: ['disc-1'], destinationParentId: folderId, mode: 'SYNCED' },
        audit,
      );
      const resourceId = imported.items[0]!.resourceId!;
      created.push(resourceId);

      const result = await disconnect(throwaway.id, owner, provider, audit);
      assert.equal(result.preservedResources, 1);
      assert.equal(provider.calls.revoke, 1, 'ควรพยายามเพิกถอนที่ฝั่ง Google ด้วย');

      const after = await prisma.googleDriveConnection.findUniqueOrThrow({
        where: { id: throwaway.id },
      });
      assert.equal(after.accessTokenEncrypted, null, 'ค่าที่ไม่มีอยู่รั่วไม่ได้');
      assert.equal(after.refreshTokenEncrypted, null);
      assert.equal(after.state, 'DISCONNECTED');

      const resource = await prisma.resource.findUnique({ where: { id: resourceId } });
      assert.ok(resource, 'ไฟล์ใน NAS ต้องอยู่ครบ');
      assert.ok(await prisma.resourceVersion.count({ where: { resourceId } }));

      const sync = await prisma.googleDriveSync.findFirstOrThrow({ where: { resourceId } });
      assert.equal(sync.syncEnabled, false, 'การซิงก์ต้องหยุด');
      assert.equal(sync.googleFileId, 'disc-1', 'การผูกยังอยู่เพื่อการตรวจสอบ');
    });

    test('การเพิกถอนที่ Google ล้มเหลวไม่ทำให้ตัดการเชื่อมต่อไม่ได้', async () => {
      const throwaway = await prisma.googleDriveConnection.create({
        data: {
          userId: ownerId,
          providerSubject: 'fake-subject-revokefail',
          googleAccountEmail: 'revokefail@example.invalid',
          refreshTokenEncrypted: new CredentialCipher(key).encrypt('refresh'),
        },
      });

      const failing = new FakeDriveProvider();
      failing.revokeToken = async () => {
        throw new Error('Google ไม่ตอบ');
      };

      // ผู้ใช้ที่กดยกเลิกต้องได้ผลลัพธ์เสมอ ไม่ติดอยู่กับการเชื่อมต่อที่ตัดไม่ได้
      await disconnect(throwaway.id, owner, failing, audit);
      const after = await prisma.googleDriveConnection.findUniqueOrThrow({
        where: { id: throwaway.id },
      });
      assert.equal(after.state, 'DISCONNECTED');
      assert.equal(after.refreshTokenEncrypted, null);
    });

    test('การเชื่อมต่อที่ตัดแล้วใช้ต่อไม่ได้', async () => {
      const throwaway = await prisma.googleDriveConnection.create({
        data: {
          userId: ownerId,
          providerSubject: 'fake-subject-used',
          googleAccountEmail: 'used@example.invalid',
          state: 'DISCONNECTED',
        },
      });
      await assert.rejects(
        () => accessTokenFor(throwaway, provider),
        rejects('GOOGLE_DRIVE_DISCONNECTED'),
      );
    });

    test('activeConnectionFor ไม่คืนการเชื่อมต่อที่ตัดแล้ว', async () => {
      const active = await activeConnectionFor(ownerId);
      assert.equal(active?.id, connectionId);
    });
  });

  /* ================================================================ */
  /* การเชื่อมกับเครื่องมือตรวจสอบ                                        */
  /* ================================================================ */

  describe('การเชื่อมกับเครื่องมือตรวจสอบ', () => {
    test('เหตุการณ์ F19 ทุกตัวมีชื่อไทยและอยู่ในชุดสำเร็จรูป', () => {
      const preset = findPreset('google-drive');
      assert.ok(preset, 'ต้องมีชุดสำเร็จรูป Google Drive');

      for (const code of [
        'GOOGLE_DRIVE_CONNECTED',
        'GOOGLE_DRIVE_DISCONNECTED',
        'GOOGLE_DRIVE_REAUTH_REQUIRED',
        'GOOGLE_DRIVE_IMPORT_STARTED',
        'GOOGLE_DRIVE_IMPORTED',
        'GOOGLE_DRIVE_IMPORT_FAILED',
        'GOOGLE_DRIVE_SYNCED',
        'GOOGLE_DRIVE_SYNC_FAILED',
        'GOOGLE_DRIVE_SYNC_DETACHED',
        'GOOGLE_DRIVE_SOURCE_MISSING',
      ]) {
        const definition = EVENT_CATALOG[code];
        assert.ok(definition, `${code} ต้องมีในสารบัญ`);
        assert.match(definition!.label, /[ก-๙A-Za-z]/, `${code} ต้องมีชื่อที่อ่านออก`);
        assert.equal(definition!.category, 'INTEGRATION');
        assert.ok(preset!.actions.includes(code), `${code} ต้องอยู่ในชุด Google Drive`);
      }
    });

    test('บันทึกการนำเข้าไม่มี token', async () => {
      provider.add({
        id: 'audit-1',
        name: `${prefix}-ตรวจสอบ.txt`,
        mimeType: 'text/plain',
        content: 'x',
        modifiedTime: new Date(),
        version: '1',
        parents: [],
      });

      const result = await importFromDrive(
        owner,
        await connection(),
        provider,
        { fileIds: ['audit-1'], destinationParentId: folderId, mode: 'IMPORT_ONCE' },
        audit,
      );
      created.push(result.items[0]!.resourceId!);

      const page = await searchAuditEvents(owner, { action: 'GOOGLE_DRIVE_IMPORTED' }, { limit: 5 });
      const event = page.items[0];
      assert.ok(event);
      assert.equal(event!.label, 'นำเข้าจาก Google Drive สำเร็จ');

      const payload = JSON.stringify(event);
      for (const secret of ['fake-refresh-token', 'fake-access-token', 'refreshToken', 'accessToken']) {
        assert.ok(!payload.includes(secret), `${secret} ต้องไม่อยู่ในบันทึก`);
      }
      assert.equal(event!.details.googleFileId, 'audit-1');
    });

    test('ไฟล์ส่งออกของเครื่องมือตรวจสอบไม่มีความลับของการเชื่อมต่อ', async () => {
      const exported = await exportAuditCsv(owner, { preset: 'google-drive' }, audit);

      assert.ok(exported.content.includes('Google Drive'), 'ต้องมีเหตุการณ์ F19 อยู่จริง');
      for (const secret of [
        'fake-refresh-token',
        'fake-access-token',
        'refreshTokenEncrypted',
        'accessTokenEncrypted',
      ]) {
        assert.ok(!exported.content.includes(secret), `${secret} ต้องไม่ปรากฏในไฟล์ส่งออก`);
      }
      for (const key of ['refreshToken', 'accessToken', 'Authorization', 'storageKey']) {
        assert.ok(
          !exported.content.toLowerCase().includes(key.toLowerCase()),
          `${key} ต้องไม่ปรากฏในไฟล์ส่งออก`,
        );
      }
    });
  });

  /* ================================================================ */
  /* ความลับในฐานข้อมูล                                                  */
  /* ================================================================ */

  test('ฐานข้อมูลไม่มี token เป็นข้อความธรรมดา', async () => {
    const rows = await prisma.googleDriveConnection.findMany({
      where: { userId: { in: [ownerId, otherId] } },
    });
    assert.ok(rows.length > 0);

    for (const row of rows) {
      const serialized = JSON.stringify(row);
      assert.ok(!serialized.includes('fake-refresh-token'), 'refresh token ต้องไม่อยู่เป็นข้อความธรรมดา');
      assert.ok(!serialized.includes('fake-access-token'));

      if (row.refreshTokenEncrypted) {
        assert.match(row.refreshTokenEncrypted, /^v1:/, 'ต้องเป็นรูปแบบที่เข้ารหัสแล้ว');
        assert.equal(row.refreshTokenEncrypted.split(':').length, 4);
      }
    }
  });
});
