import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../../core/prisma.js';
import { AppError } from '../../core/errors.js';
import { createFolder } from '../resources/resource.service.js';
import { uploadFile } from '../files/file.service.js';
import { trashResource, permanentlyDelete } from '../files/trash.service.js';
import { placeLegalHold } from '../governance/legal-hold.service.js';
import {
  canExportAudit,
  canViewAudit,
  getAuditEvent,
  resourceTimeline,
  safeDetails,
  searchAuditEvents,
  summarizeUserAgent,
} from './audit.service.js';
import {
  EXPORT_MAX_ROWS,
  escapeCsvValue,
  exportAuditCsv,
  exportFilename,
  formatExportTimestamp,
  summarizeFilters,
} from './audit-export.js';
import { AUDIT_PRESETS, EVENT_CATALOG, actionsInCategory, describeEvent, findPreset } from './event-catalog.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * F17 - เครื่องมือตรวจสอบและการส่งออก
 *
 * สิ่งที่ต้องรับประกันมากที่สุดคือ **ความลับไม่รั่วออกทางนี้**
 * เครื่องมือตรวจสอบเห็นทุกเหตุการณ์ในระบบ ถ้ามันรั่ว มันรั่วทั้งระบบพร้อมกัน
 */

const prefix = `f17-${Date.now().toString(36)}`;
const audit = { ipAddress: '10.0.0.9', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537' };
const stream = (text: string) => Readable.from([Buffer.from(text, 'utf8')]);

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

describe('F17 เครื่องมือตรวจสอบ', () => {
  let admin: AuthUser;
  let auditor: AuthUser;
  let staff: AuthUser;
  let client: AuthUser;
  let adminId = '';
  let auditorId = '';
  let staffId = '';
  let clientId = '';
  let folderId = '';
  let fileId = '';
  const created: string[] = [];

  before(async () => {
    const rows = await Promise.all(
      [
        ['admin', 'INTERNAL'],
        ['auditor', 'INTERNAL'],
        ['staff', 'INTERNAL'],
        ['client', 'EXTERNAL'],
      ].map(([role, type]) =>
        prisma.user.create({
          data: {
            email: `${prefix}-${role}@example.invalid`,
            displayName: `F17 ${role}`,
            type: type as 'INTERNAL' | 'EXTERNAL',
            status: 'ACTIVE',
          },
        }),
      ),
    );
    [adminId, auditorId, staffId, clientId] = rows.map((row) => row.id);

    admin = makeUser(adminId, rows[0].email, rows[0].displayName, ['ADMIN'], ['admin:access']);
    // ผู้ตรวจสอบที่ดูได้แต่ส่งออกไม่ได้ - ใช้พิสูจน์ว่าสองสิทธิ์แยกกันจริง
    auditor = makeUser(auditorId, rows[1].email, rows[1].displayName, ['MEMBER'], ['system:audit:view']);
    staff = makeUser(staffId, rows[2].email, rows[2].displayName, ['MEMBER']);
    client = makeUser(clientId, rows[3].email, rows[3].displayName, ['MEMBER'], [], 'EXTERNAL');

    const folder = await createFolder(admin, { name: `${prefix} งาน`, parentId: null }, audit);
    folderId = folder.id;
    created.push(folderId);

    const uploaded = await uploadFile(
      admin,
      stream('เอกสารสำหรับทดสอบการตรวจสอบ'),
      { parentId: folderId, fileName: `${prefix}-เอกสาร.txt`, allowDuplicateContent: true },
      audit,
    );
    fileId = uploaded.resource.id;
    created.push(fileId);
  });

  after(async () => {
    const ids = new Set(created.filter(Boolean));
    const children = await prisma.resource.findMany({
      where: { parentId: { in: [...ids] } },
      select: { id: true },
    });
    for (const child of children) ids.add(child.id);
    const all = [...ids];
    const users = [adminId, auditorId, staffId, clientId];

    await prisma.legalHold.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.activityLog.deleteMany({ where: { userId: { in: users } } });
    await prisma.activityLog.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resource.updateMany({ where: { id: { in: all } }, data: { retentionPolicyId: null } });
    await prisma.resource.deleteMany({ where: { parentId: { not: null }, id: { in: all } } });
    await prisma.resource.deleteMany({ where: { id: { in: all } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  });

  /* ---------------- สารบัญเหตุการณ์ ---------------- */

  describe('สารบัญเหตุการณ์', () => {
    test('ทุกรหัสที่ระบบบันทึกจริงมีชื่อภาษาไทยและหมวดหมู่', () => {
      /**
       * ดึงรหัสจากซอร์สโดยตรง เพื่อให้การเพิ่มเหตุการณ์ใหม่โดยลืมใส่ชื่อภาษาไทย
       * ทำให้ชุดทดสอบล้ม แทนที่จะไปโผล่เป็นรหัสดิบบนหน้าจอของผู้ตรวจสอบ
       */
      const scan = (dir: string, found = new Set<string>()): Set<string> => {
        for (const name of fs.readdirSync(dir)) {
          const full = path.join(dir, name);
          if (fs.statSync(full).isDirectory()) scan(full, found);
          else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
            const text = fs.readFileSync(full, 'utf8');
            /**
             * ดูเฉพาะไฟล์ที่เขียนบันทึกกิจกรรมจริง
             *
             * คำว่า action: ถูกใช้ในที่อื่นด้วย เช่นชนิดของการตัดสินใจใน
             * schedule-policy.ts ที่มี { action: 'SKIP' | 'RUN' } ซึ่งไม่ใช่เหตุการณ์
             * ที่ถูกบันทึก การนับรวมจะทำให้สารบัญมีรายการที่ไม่มีวันเกิดขึ้นจริง
             */
            if (!text.includes('activityLog') && !text.includes('logActivity')) continue;
            for (const match of text.matchAll(/action:\s*'([A-Z][A-Z0-9_]+)'/g)) found.add(match[1]);
            for (const match of text.matchAll(/logActivity\(\s*'([A-Z][A-Z0-9_]+)'/g)) found.add(match[1]);
          }
        }
        return found;
      };

      const emitted = scan(path.join(process.cwd(), 'src'));
      const missing = [...emitted].filter((code) => !EVENT_CATALOG[code]);
      assert.deepEqual(missing, [], 'รหัสเหล่านี้ถูกบันทึกจริงแต่ยังไม่มีชื่อภาษาไทยในสารบัญ');
    });

    test('ไม่มีชื่อเหตุการณ์ที่เป็นรหัสดิบ', () => {
      for (const [code, definition] of Object.entries(EVENT_CATALOG)) {
        assert.notEqual(definition.label, code, `${code} ต้องมีชื่อที่คนอ่านออก ไม่ใช่รหัสดิบ`);
        assert.ok(definition.label.length > 0);
      }
    });

    test('รหัสที่ไม่รู้จักยังแสดงได้ ไม่ถูกซ่อน', () => {
      const unknown = describeEvent('SOMETHING_NEW_WE_DID_NOT_MAP');
      assert.equal(unknown.label, 'SOMETHING_NEW_WE_DID_NOT_MAP');
      assert.equal(unknown.category, 'SYSTEM');
    });

    test('ชุดสำเร็จรูปทุกชุดอ้างถึงรหัสที่มีอยู่จริง', () => {
      for (const preset of AUDIT_PRESETS) {
        for (const action of preset.actions) {
          assert.ok(EVENT_CATALOG[action], `ชุด ${preset.slug} อ้างถึง ${action} ที่ไม่มีในสารบัญ`);
        }
      }
      // ชุดการกำกับดูแลต้องมีเหตุการณ์ของ F16 ครบ
      const governance = findPreset('governance')!;
      for (const code of [
        'LEGAL_HOLD_CREATED',
        'LEGAL_HOLD_RELEASED',
        'RESOURCE_ARCHIVED',
        'RESOURCE_UNARCHIVED',
        'RETENTION_POLICY_ASSIGNED',
        'PERMANENT_DELETE_BLOCKED_HOLD',
      ]) {
        assert.ok(governance.actions.includes(code), `ชุดการกำกับดูแลต้องมี ${code}`);
      }
    });
  });

  /* ---------------- สิทธิ์ ---------------- */

  describe('ความล้มเหลว', () => {
    /**
     * "ล้มเหลว" กับ "น่าตกใจ" เป็นคนละคำถาม
     *
     * การลบถาวรที่สำเร็จเป็นเหตุการณ์ที่ต้องจับตา แต่ไม่ใช่ความล้มเหลว
     * ถ้ามันปนมาในตัวกรอง "เฉพาะที่ล้มเหลว" ผู้ตรวจสอบจะสรุปว่าระบบมีเหตุขัดข้อง
     * มากกว่าความเป็นจริง และอาจไล่สอบสวนเรื่องที่ไม่มีอยู่
     */
    test('การกระทำที่สำเร็จไม่ถูกนับเป็นความล้มเหลว แม้จะน่าตกใจ', () => {
      const deleted = EVENT_CATALOG.RESOURCE_PERMANENTLY_DELETED;
      assert.equal(deleted.tone, 'DANGER', 'การลบถาวรยังต้องเด่นบนหน้าจอ');
      assert.notEqual(deleted.failure, true, 'แต่ต้องไม่ถูกนับว่าเป็นความล้มเหลว');
    });

    test('ความล้มเหลวและการถูกปฏิเสธถูกทำเครื่องหมายไว้', () => {
      for (const code of [
        'GOOGLE_LOGIN_FAILED',
        'RESOURCE_PERMANENT_DELETE_FAILED',
        'PERMANENT_DELETE_BLOCKED_RETENTION',
        'PERMANENT_DELETE_BLOCKED_HOLD',
        'BACKUP_FAILED',
        'RESTORE_REHEARSAL_FAILED',
      ]) {
        assert.equal(EVENT_CATALOG[code]?.failure, true, `${code} ต้องถูกนับเป็นความล้มเหลว`);
      }
    });

    /** ทุกเหตุการณ์ที่ชื่อบอกว่าล้มเหลว ต้องถูกทำเครื่องหมายไว้ - กันคนเพิ่มใหม่แล้วลืม */
    test('ไม่มีเหตุการณ์ที่ชื่อบอกว่าล้มเหลวแล้วหลุดจากตัวกรอง', () => {
      for (const [code, definition] of Object.entries(EVENT_CATALOG)) {
        if (!/_FAILED$|_BLOCKED_/.test(code)) continue;
        assert.equal(definition.failure, true, `${code} ชื่อบอกว่าล้มเหลวแต่ไม่ถูกทำเครื่องหมาย`);
      }
    });
  });

  describe('สิทธิ์', () => {
    test('ผู้ใช้ภายในทั่วไปเข้าไม่ได้', async () => {
      assert.equal(canViewAudit(staff), false);
      await assert.rejects(
        () => searchAuditEvents(staff, {}),
        (error: unknown) => error instanceof AppError && error.code === 'AUDIT_DENIED',
      );
    });

    test('บัญชีลูกค้าเข้าไม่ได้ แม้จะมีสิทธิ์ติดมา', async () => {
      const sneaky = { ...client, permissions: [...client.permissions, 'system:audit:view'] };
      assert.equal(canViewAudit(sneaky), false, 'ประเภทบัญชีต้องมาก่อน permission เสมอ');
      await assert.rejects(
        () => searchAuditEvents(sneaky, {}),
        (error: unknown) => error instanceof AppError && error.code === 'AUDIT_DENIED',
      );
    });

    test('บัญชีบริการเข้าไม่ได้', async () => {
      const service: AuthUser = { ...staff, type: 'SERVICE', permissions: ['system:audit:view'] };
      assert.equal(canViewAudit(service), false);
      await assert.rejects(
        () => searchAuditEvents(service, {}),
        (error: unknown) => error instanceof AppError && error.code === 'AUDIT_DENIED',
      );
    });

    test('ผู้ดูแลระบบและผู้ที่มีสิทธิ์ audit เข้าได้', async () => {
      assert.equal(canViewAudit(admin), true);
      assert.equal(canViewAudit(auditor), true);
      const page = await searchAuditEvents(auditor, {}, { limit: 5 });
      assert.ok(Array.isArray(page.items));
    });

    test('สิทธิ์ดูกับสิทธิ์ส่งออกแยกจากกันจริง', async () => {
      assert.equal(canViewAudit(auditor), true);
      assert.equal(canExportAudit(auditor), false, 'ผู้ที่ดูได้ต้องไม่ส่งออกได้โดยอัตโนมัติ');

      await assert.rejects(
        () => exportAuditCsv(auditor, {}, audit),
        (error: unknown) => error instanceof AppError && error.code === 'AUDIT_EXPORT_DENIED',
      );

      assert.equal(canExportAudit(admin), true);
    });

    test('ขอรายละเอียดเหตุการณ์โดยไม่มีสิทธิ์ถูกปฏิเสธ', async () => {
      const page = await searchAuditEvents(admin, {}, { limit: 1 });
      const target = page.items[0];
      assert.ok(target);
      await assert.rejects(
        () => getAuditEvent(target.id, staff),
        (error: unknown) => error instanceof AppError && error.code === 'AUDIT_DENIED',
      );
    });
  });

  /* ---------------- ตัวกรอง ---------------- */

  describe('ตัวกรอง', () => {
    test('กรองตามทรัพยากรได้เฉพาะเหตุการณ์ของทรัพยากรนั้น', async () => {
      const page = await searchAuditEvents(admin, { resourceId: fileId }, { limit: 50 });
      assert.ok(page.items.length > 0);
      assert.ok(page.items.every((item) => item.resource?.id === fileId));
    });

    test('กรองตามผู้ดำเนินการ', async () => {
      const page = await searchAuditEvents(admin, { actorId: adminId }, { limit: 50 });
      assert.ok(page.items.length > 0);
      assert.ok(page.items.every((item) => item.actor.id === adminId));
    });

    test('กรองตามหมวดหมู่คืนเฉพาะเหตุการณ์ในหมวดนั้น', async () => {
      const page = await searchAuditEvents(admin, { category: 'FILE' }, { limit: 50 });
      const fileActions = new Set(actionsInCategory('FILE'));
      assert.ok(page.items.every((item) => fileActions.has(item.action)));
    });

    test('กรองตามช่วงเวลา', async () => {
      const future = new Date(Date.now() + 86_400_000);
      const empty = await searchAuditEvents(admin, { from: future }, { limit: 10 });
      assert.equal(empty.items.length, 0, 'อนาคตต้องไม่มีเหตุการณ์');

      const past = new Date(Date.now() - 86_400_000);
      const some = await searchAuditEvents(admin, { from: past }, { limit: 10 });
      assert.ok(some.items.length > 0);
    });

    test('กรองตามชุดสำเร็จรูป', async () => {
      const preset = findPreset('files')!;
      const page = await searchAuditEvents(admin, { preset: 'files' }, { limit: 50 });
      const allowed = new Set(preset.actions);
      assert.ok(page.items.every((item) => allowed.has(item.action)));
    });

    test('ชุด "ทั้งหมด" ไม่กรองอะไรออก', async () => {
      const all = await searchAuditEvents(admin, { preset: 'all' }, { limit: 10 });
      const none = await searchAuditEvents(admin, {}, { limit: 10 });
      assert.equal(all.items.length, none.items.length);
    });

    test('กรองตามประเภทผู้ดำเนินการ - ระบบคือไม่มีผู้ใช้และไม่มีการเชื่อมต่อ', async () => {
      const page = await searchAuditEvents(admin, { actorType: 'SYSTEM' }, { limit: 20 });
      assert.ok(page.items.every((item) => item.actor.type === 'SYSTEM'));
      assert.ok(page.items.every((item) => item.actor.displayName === 'ระบบ'));
    });

    test('ค้นข้อความหาจากชื่อผู้ดำเนินการได้', async () => {
      const page = await searchAuditEvents(admin, { q: 'F17 admin' }, { limit: 20 });
      assert.ok(page.items.length > 0);
      assert.ok(page.items.every((item) => item.actor.id === adminId));
    });

    test('การแบ่งหน้าด้วย cursor ไม่คืนแถวซ้ำ', async () => {
      const first = await searchAuditEvents(admin, {}, { limit: 3 });
      assert.equal(first.items.length, 3);
      assert.ok(first.nextCursor);

      const second = await searchAuditEvents(admin, {}, { limit: 3, cursor: first.nextCursor! });
      const firstIds = new Set(first.items.map((item) => item.id));
      assert.ok(
        second.items.every((item) => !firstIds.has(item.id)),
        'หน้าถัดไปต้องไม่มีแถวที่เห็นไปแล้ว',
      );
    });
  });

  /* ---------------- การกรองข้อมูลอ่อนไหว ---------------- */

  describe('ความปลอดภัยของข้อมูล', () => {
    test('metadata ที่ไม่อยู่ในบัญชีอนุญาตถูกตัดทิ้ง', () => {
      const details = safeDetails('LEGAL_HOLD_CREATED', {
        legalHoldId: 'hold-1',
        reason: 'คดีความลับที่ต้องไม่หลุด',
        password: 'should-never-appear',
      });
      assert.equal(details.legalHoldId, 'hold-1');
      assert.equal(details.reason, undefined, 'เหตุผลของ Legal Hold ต้องไม่หลุดออกมา');
      assert.equal(details.password, undefined);
    });

    test('คำที่อ่อนไหวถูกกันไว้แม้จะอยู่ในบัญชีอนุญาต', () => {
      const details = safeDetails('BACKUP_CREATED', {
        backupId: 'b-1',
        accessToken: 'secret',
        storageKey: 'path/to/file',
      });
      assert.equal(details.backupId, 'b-1');
      assert.equal(details.accessToken, undefined);
      assert.equal(details.storageKey, undefined);
    });

    test('เหตุการณ์ที่ไม่มีบัญชีอนุญาตคืนรายละเอียดว่าง', () => {
      assert.deepEqual(safeDetails('LOGIN', { secretThing: 'x', ip: '1.2.3.4' }), {});
    });

    test('ผลลัพธ์ที่ส่งออกไปไม่มีความลับ', async () => {
      const page = await searchAuditEvents(admin, {}, { limit: 100 });

      /**
       * ตรวจที่ "ค่า" ไม่ใช่ที่ชื่อเหตุการณ์
       *
       * รหัสอย่าง CHANGE_PASSWORD และ USER_TEMP_PASSWORD_RESET มีคำว่า password
       * อยู่ในชื่อโดยชอบธรรม การค้นคำดิบ ๆ ทั้งก้อนจึงเตือนผิดตลอดเวลา
       * จนสุดท้ายไม่มีใครเชื่อการเตือนนั้น
       *
       * สิ่งที่อันตรายจริงคือ "ค่า" ที่หลุดมากับรายละเอียด จึงตรวจเฉพาะส่วนนั้น
       */
      const payload = JSON.stringify(
        page.items.map((item) => ({
          details: item.details,
          actor: item.actor,
          resource: item.resource,
          userAgent: item.userAgent,
          ipAddress: item.ipAddress,
        })),
      ).toLowerCase();

      for (const secret of [
        'passwordhash',
        'refreshtoken',
        'accesstoken',
        'idtoken',
        'authorization',
        'clientsecret',
        'credentialhash',
        'storagekey',
        '"password"',
      ]) {
        assert.equal(
          payload.includes(secret),
          false,
          `คำว่า "${secret}" ต้องไม่ปรากฏในรายละเอียดของเหตุการณ์`,
        );
      }
    });

    test('สรุป user agent อ่านออกและไม่ทิ้งค่าดิบยาว ๆ', () => {
      assert.equal(
        summarizeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/120.0 Safari/537.36'),
        'Chrome / Windows',
      );
      assert.equal(summarizeUserAgent('Mozilla/5.0 (Macintosh) Firefox/121.0'), 'Firefox / macOS');
      assert.equal(summarizeUserAgent(null), null);
      // สิ่งที่ไม่ใช่เบราว์เซอร์ก็ยังบอกตามจริง ไม่ทิ้งเป็นค่าว่าง
      assert.ok((summarizeUserAgent('curl/8.0') ?? '').length > 0);
    });
  });

  /* ---------------- ทรัพยากรที่ถูกลบ ---------------- */

  describe('เหตุการณ์ยังมีความหมายหลังของถูกลบ', () => {
    test('เหตุการณ์ของทรัพยากรที่ถูกลบยังอ่านได้ และบอกว่าถูกลบแล้ว', async () => {
      const temp = await uploadFile(
        admin,
        stream('เอกสารที่จะถูกลบ'),
        { parentId: folderId, fileName: `${prefix}-จะลบ.txt`, allowDuplicateContent: true },
        audit,
      );
      const tempId = temp.resource.id;

      await trashResource(tempId, admin, audit);
      await permanentlyDelete(tempId, admin, audit);

      const page = await searchAuditEvents(admin, { resourceId: tempId }, { limit: 20 });
      assert.ok(page.items.length > 0, 'ประวัติต้องไม่หายไปพร้อมเอกสาร');
      for (const item of page.items) {
        assert.equal(item.resource?.deleted, true);
        assert.equal(item.resource?.name, null, 'หน้าจอจะแสดงว่า "ทรัพยากรถูกลบแล้ว"');
        assert.ok(item.label.length > 0, 'ชื่อเหตุการณ์ต้องยังอ่านออก');
      }

      await prisma.activityLog.deleteMany({ where: { resourceId: tempId } });
    });
  });

  /* ---------------- การกำกับดูแล ---------------- */

  describe('การเชื่อมกับการกำกับดูแล', () => {
    test('การลบที่ถูกปฏิเสธเพราะ Legal Hold ถูกบันทึกไว้ โดยไม่มีเหตุผลของการระงับ', async () => {
      const target = await uploadFile(
        admin,
        stream('เอกสารที่ถูกระงับ'),
        { parentId: folderId, fileName: `${prefix}-ระงับ.txt`, allowDuplicateContent: true },
        audit,
      );
      created.push(target.resource.id);

      await trashResource(target.resource.id, admin, audit);
      const secret = 'เหตุผลลับของการระงับ';
      await placeLegalHold(target.resource.id, admin, { reason: secret }, audit);

      await assert.rejects(() => permanentlyDelete(target.resource.id, admin, audit));

      const page = await searchAuditEvents(
        admin,
        { resourceId: target.resource.id, action: 'PERMANENT_DELETE_BLOCKED_HOLD' },
        { limit: 10 },
      );
      assert.equal(page.items.length, 1, 'ความพยายามลบที่ถูกปฏิเสธต้องถูกบันทึก');
      assert.equal(page.items[0].tone, 'DANGER');
      assert.equal(
        JSON.stringify(page.items[0]).includes(secret),
        false,
        'เหตุผลของการระงับต้องไม่หลุดมาที่เครื่องมือตรวจสอบ',
      );
    });

    test('ไทม์ไลน์ของทรัพยากรเรียงจากใหม่ไปเก่า', async () => {
      const timeline = await resourceTimeline(fileId, admin, { limit: 20 });
      assert.ok(timeline.items.length > 0);
      for (let index = 1; index < timeline.items.length; index += 1) {
        assert.ok(
          timeline.items[index - 1].createdAt >= timeline.items[index].createdAt,
          'ไทม์ไลน์ต้องเรียงจากใหม่ไปเก่า',
        );
      }
    });
  });

  /* ---------------- การส่งออก ---------------- */

  describe('การส่งออก CSV', () => {
    test('ป้องกันสูตรของ spreadsheet', () => {
      // ค่าที่ขึ้นต้นด้วยอักขระเหล่านี้ถูก Excel ตีความเป็นสูตร
      for (const dangerous of ['=cmd|calc', '+1+1', '-1+1', '@SUM(A1)', '\tx', '\rx']) {
        const escaped = escapeCsvValue(dangerous);
        assert.ok(
          escaped.startsWith(`"'`),
          `ค่า ${JSON.stringify(dangerous)} ต้องถูกทำให้เป็นข้อความ ไม่ใช่สูตร`,
        );
      }
      // ค่าปกติไม่ถูกแตะ
      assert.equal(escapeCsvValue('ปกติ'), '"ปกติ"');
      assert.equal(escapeCsvValue(42), '"42"');
      // อัญประกาศถูกซ้ำตามมาตรฐาน CSV
      assert.equal(escapeCsvValue('เขา "พูด" ว่า'), '"เขา ""พูด"" ว่า"');
      assert.equal(escapeCsvValue(null), '');
    });

    test('ส่งออกได้ พร้อม BOM และหัวคอลัมน์ภาษาไทย', async () => {
      const result = await exportAuditCsv(admin, { resourceId: fileId }, audit);

      assert.ok(result.content.startsWith('﻿'), 'ต้องมี BOM เพื่อให้ Excel อ่านภาษาไทยออก');
      assert.ok(result.content.includes('วันที่เวลา'));
      assert.ok(result.content.includes('ผู้ดำเนินการ'));
      assert.ok(result.rowCount > 0);
      assert.match(result.filename, /^s2-nas-audit-\d{4}-\d{2}-\d{2}\.csv$/);
    });

    test('ไฟล์ที่ส่งออกไม่มีความลับ', async () => {
      const result = await exportAuditCsv(admin, {}, audit);
      const lower = result.content.toLowerCase();

      /**
       * ชื่อเหตุการณ์อย่าง CHANGE_PASSWORD อยู่ในคอลัมน์รหัสเหตุการณ์โดยชอบธรรม
       * จึงตรวจรูปแบบที่บ่งบอกว่าเป็น "ค่า" ที่หลุดมา เช่น key=value ในคอลัมน์รายละเอียด
       */
      for (const secret of [
        'passwordhash',
        'refreshtoken',
        'accesstoken',
        'idtoken',
        'clientsecret',
        'credentialhash',
        'storagekey',
        'password=',
        'token=',
      ]) {
        assert.equal(lower.includes(secret), false, `ไฟล์ส่งออกต้องไม่มี "${secret}"`);
      }
    });

    test('ส่งออกใช้ตัวกรองชุดเดียวกับหน้าจอ', async () => {
      const filters = { resourceId: fileId };
      const onScreen = await searchAuditEvents(admin, filters, { limit: 100 });
      const exported = await exportAuditCsv(admin, filters, audit);
      // หัวตารางหนึ่งบรรทัด + ท้ายไฟล์หนึ่งบรรทัดว่าง
      assert.equal(exported.rowCount, onScreen.items.length);
    });

    test('การส่งออกถูกบันทึกเป็นเหตุการณ์ พร้อมจำนวนแถวแต่ไม่มีเนื้อหา', async () => {
      const before = await prisma.activityLog.count({
        where: { userId: adminId, action: 'AUDIT_LOG_EXPORTED' },
      });
      const result = await exportAuditCsv(admin, { resourceId: fileId }, audit);
      const log = await prisma.activityLog.findFirst({
        where: { userId: adminId, action: 'AUDIT_LOG_EXPORTED' },
        orderBy: { createdAt: 'desc' },
      });

      assert.ok(
        (await prisma.activityLog.count({
          where: { userId: adminId, action: 'AUDIT_LOG_EXPORTED' },
        })) > before,
      );
      const metadata = log!.metadata as Record<string, unknown>;
      assert.equal(metadata.rowCount, result.rowCount);
      assert.equal(metadata.format, 'CSV');
      assert.ok(typeof metadata.filterSummary === 'string');
      // ต้องไม่มีสำเนาของเนื้อหาที่ส่งออก
      assert.ok(JSON.stringify(metadata).length < 400);
    });

    test('สรุปตัวกรองไม่เปิดเผยค่าที่ระบุไป', () => {
      const summary = summarizeFilters({ actorId: 'user-secret-id', resourceId: 'res-secret', q: 'ลับ' });
      assert.ok(summary.includes('actor=set'));
      assert.equal(summary.includes('user-secret-id'), false);
      assert.equal(summary.includes('res-secret'), false);
      assert.equal(summary.includes('ลับ'), false);
    });

    test('เพดานจำนวนแถวถูกกำหนดไว้และไม่ใหญ่จนอันตราย', () => {
      assert.equal(EXPORT_MAX_ROWS, 50_000);
    });

    /**
     * เวลาในไฟล์ต้องเป็นเวลาเดียวกับที่ผู้ตรวจสอบเห็นบนหน้าจอ
     *
     * ถ้าไฟล์เป็น UTC แต่หน้าจอเป็นเวลาไทย ตัวเลขจะต่างกัน 7 ชั่วโมง
     * และผู้ตรวจสอบอาจสรุปว่าเหตุการณ์เกิดนอกเวลาทำการทั้งที่เกิดตอนบ่าย
     */
    test('เวลาในไฟล์เป็นเวลาไทย ไม่ใช่ UTC', () => {
      // 03:00 UTC = 10:00 ตามเวลาไทย
      assert.equal(formatExportTimestamp(new Date('2026-09-07T03:00:00.000Z')), '2026-09-07 10:00:00');
      // ข้ามวันเมื่อแปลงโซนเวลา
      assert.equal(formatExportTimestamp(new Date('2026-09-07T20:30:15.000Z')), '2026-09-08 03:30:15');
    });

    test('ชื่อไฟล์มาจากเซิร์ฟเวอร์ ไม่มีส่วนใดมาจากผู้ใช้', () => {
      const name = exportFilename(new Date('2026-09-07T10:00:00Z'));
      assert.equal(name, 's2-nas-audit-2026-09-07.csv');
      assert.equal(/[/\\.]{2}|[/\\]/.test(name.replace('.csv', '')), false, 'ต้องไม่มีเส้นทางไฟล์');
    });
  });

  /* ---------------- ข้อความอันตราย ---------------- */

  describe('ข้อความที่อาจเป็นอันตราย', () => {
    test('ชื่อทรัพยากรที่มี HTML ถูกส่งกลับเป็นข้อความล้วน', async () => {
      /**
       * ใช้ "โฟลเดอร์" ไม่ใช่ไฟล์
       *
       * ชั้นอัปโหลดปฏิเสธอักขระ < > ในชื่อไฟล์อยู่แล้ว (sanitizeFileName)
       * แต่ชื่อโฟลเดอร์ผ่าน validateResourceName ซึ่งอนุญาต จึงเป็นทางเข้าจริง
       * ของข้อความที่อาจถูกตีความเป็น HTML
       */
      // ไม่มีเครื่องหมาย / เพราะ validateResourceName กันไว้ - จึงใช้เพย์โหลดที่ไม่ต้องปิดแท็ก
      const nasty = `${prefix} <img src=x onerror=alert(1)>`;
      const uploaded = { resource: await createFolder(admin, { name: nasty, parentId: folderId }, audit) };
      created.push(uploaded.resource.id);

      const page = await searchAuditEvents(admin, { resourceId: uploaded.resource.id }, { limit: 10 });
      const item = page.items[0];
      assert.ok(item);
      /**
       * ระบบส่งข้อความกลับมาตามจริง ไม่แปลง entity ให้ - การป้องกันอยู่ที่หน้าจอ
       * ซึ่งแสดงผ่าน children ของ React เสมอ สิ่งที่ต้องยืนยันคือมันเป็นข้อความ
       * ไม่ใช่โครงสร้างที่ถูกตีความ
       */
      assert.equal(typeof item.resource?.name, 'string');

      const exported = await exportAuditCsv(admin, { resourceId: uploaded.resource.id }, audit);

      /**
       * สิ่งที่ต้องพิสูจน์คือค่าอันตรายไม่ "แตกออก" จากช่องของมัน
       *
       * วิธีตรวจที่ตรงประเด็นที่สุดคือนับจำนวนแถว - ถ้าชื่อไฟล์ที่มีอักขระพิเศษ
       * ทำให้เกิดแถวใหม่หรือคอลัมน์ใหม่ จำนวนแถวจะไม่ตรงกับจำนวนเหตุการณ์
       */
      const lines = exported.content.trimEnd().split('\r\n');
      assert.equal(
        lines.length,
        exported.rowCount + 1,
        'ชื่อที่มีอักขระพิเศษต้องไม่ทำให้เกิดแถวเกินในไฟล์ CSV',
      );
      // ค่าที่มีอักขระพิเศษต้องอยู่ในอัญประกาศเสมอ
      assert.ok(exported.content.includes('onerror=alert(1)'), 'ค่าต้องยังอยู่ครบ ไม่ถูกตัดทิ้ง');
    });
  });
});
