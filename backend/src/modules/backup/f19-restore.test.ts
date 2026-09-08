import assert from 'node:assert/strict';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { env } from '../../config/env.js';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { createFolder } from '../resources/resource.service.js';
import { uploadFile } from '../files/file.service.js';
import {
  CredentialCipher,
  setCredentialCipherForTest,
} from '../integrations/integration-crypto.js';
import { BACKUP_PATHS, backupDirectory, createBackup, deleteBackup } from './backup.service.js';
import { disconnectLockClient } from './distributed-lock.js';
import { importDump, parseDatabaseUrl, runSql } from './mariadb-cli.js';
import { readManifest } from './manifest.js';
import { resetOperationLock } from './operation-lock.js';
import { assertScratchDatabase } from './rehearsal.service.js';

/**
 * F19 - การเชื่อมต่อและการผูกไฟล์ Google Drive ต้องรอดจากการกู้คืน
 *
 * **การซ้อมนี้ไม่แตะ Google จริงเลย** ทั้งชุดทำงานกับข้อมูลในฐานข้อมูลเท่านั้น
 * การเรียก API ภายนอกระหว่างการซ้อมกู้คืนจะทำให้ผลลัพธ์ขึ้นกับสิ่งที่เราควบคุมไม่ได้
 * และอาจไปแตะบัญชีจริงของใครบางคนโดยไม่ตั้งใจ
 *
 * คำถามที่ต้องตอบ: หลังกู้คืน ระบบยังรู้ไหมว่าไฟล์ไหนผูกกับ Google ไฟล์ไหน
 * และข้อมูลรับรองที่เข้ารหัสไว้ยังใช้ได้หรือไม่
 */
describe('F19 การเชื่อมต่อ Google Drive ต้องรอดจากการกู้คืน', () => {
  const prefix = `f19-restore-${Date.now().toString(36)}`;
  const audit = { ipAddress: '10.1.2.3', userAgent: 'Mozilla/5.0 Chrome/120' };
  const stream = (text: string) => Readable.from([Buffer.from(text, 'utf8')]);
  const key = randomBytes(32);

  let user: AuthUser;
  let userId = '';
  let folderId = '';
  let fileId = '';
  let connectionId = '';
  let syncId = '';
  let backupId = '';
  let scratchDatabase = '';

  /** แฮชของข้อมูลรับรองที่เข้ารหัสไว้ - ใช้เทียบว่ากลับมาตรงทุกไบต์ */
  let encryptedRefresh = '';

  before(async () => {
    setCredentialCipherForTest(key);

    const row = await prisma.user.create({
      data: {
        email: `${prefix}@example.invalid`,
        displayName: 'F19 Restore',
        type: 'INTERNAL',
        status: 'ACTIVE',
      },
    });
    userId = row.id;
    user = {
      id: userId,
      email: row.email,
      displayName: row.displayName,
      type: 'INTERNAL',
      status: 'ACTIVE',
      mustChangePassword: false,
      roles: ['ADMIN'],
      permissions: ['resources:read', 'resources:write', 'resources:delete', 'admin:access'],
    };

    const folder = await createFolder(user, { name: `${prefix} งาน`, parentId: null }, audit);
    folderId = folder.id;

    const uploaded = await uploadFile(
      user,
      stream('เอกสารที่นำเข้าจาก Google Drive'),
      {
        parentId: folderId,
        fileName: `${prefix}.txt`,
        allowDuplicateContent: true,
        /** ที่มาแบบเดียวกับที่การนำเข้าจริงเขียนไว้ */
        sourceType: 'GOOGLE',
        sourceSystem: 'GOOGLE_DRIVE',
        sourceEntityType: 'text/plain',
        sourceEntityId: 'restore-google-file-1',
        sourceUrl: 'https://drive.google.com/file/d/restore-google-file-1/view',
      },
      audit,
    );
    fileId = uploaded.resource.id;

    encryptedRefresh = new CredentialCipher(key).encrypt('refresh-token-ที่ต้องรอด');

    const connection = await prisma.googleDriveConnection.create({
      data: {
        userId,
        providerSubject: 'restore-subject-1',
        googleAccountEmail: 'restore@example.invalid',
        refreshTokenEncrypted: encryptedRefresh,
        accessTokenEncrypted: new CredentialCipher(key).encrypt('access-token'),
        tokenExpiresAt: new Date('2026-12-31T00:00:00Z'),
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        state: 'ACTIVE',
        lastSuccessfulSyncAt: new Date('2026-09-05T08:00:00Z'),
      },
    });
    connectionId = connection.id;

    const sync = await prisma.googleDriveSync.create({
      data: {
        connectionId,
        resourceId: fileId,
        googleFileId: 'restore-google-file-1',
        mode: 'SYNCED',
        remoteName: 'เอกสารต้นฉบับภาษาไทย',
        remoteMimeType: 'text/plain',
        remoteWebUrl: 'https://drive.google.com/file/d/restore-google-file-1/view',
        lastRemoteModifiedTime: new Date('2026-09-04T10:00:00Z'),
        lastRemoteVersion: '42',
        lastSyncedAt: new Date('2026-09-04T10:05:00Z'),
        syncEnabled: true,
      },
    });
    syncId = sync.id;
  });

  after(async () => {
    if (scratchDatabase) {
      assertScratchDatabase(scratchDatabase);
      await runSql(parseDatabaseUrl(), `DROP DATABASE IF EXISTS \`${scratchDatabase}\``);
    }
    if (backupId) {
      try {
        await deleteBackup(backupId, user, audit);
      } catch {
        /* อาจถูกลบไปแล้ว */
      }
    }

    const all = [fileId, folderId].filter(Boolean);
    await prisma.googleDriveSync.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.googleDriveConnection.deleteMany({ where: { userId } });
    await prisma.activityLog.deleteMany({ where: { userId } });
    await prisma.activityLog.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resource.deleteMany({ where: { id: fileId } });
    await prisma.resource.deleteMany({ where: { id: folderId } });
    await prisma.user.deleteMany({ where: { id: userId } });

    setCredentialCipherForTest(null);
    resetOperationLock();
    await disconnectLockClient();
  });

  test('การเชื่อมต่อ การผูกไฟล์ และที่มา กลับมาครบหลังกู้คืน', async () => {
    const { backup } = await createBackup(user, audit, 'MANUAL');
    assert.equal(backup.status, 'COMPLETED', backup.errorMessage ?? 'สร้างชุดสำรองไม่สำเร็จ');
    backupId = backup.id;

    const row = await prisma.backupLog.findUnique({
      where: { id: backupId },
      select: { backupName: true },
    });

    const target = parseDatabaseUrl();
    scratchDatabase = `${env.S2_NAS_RESTORE_DB_PREFIX}f19_${process.pid}`;
    assertScratchDatabase(scratchDatabase);

    await runSql(target, `DROP DATABASE IF EXISTS \`${scratchDatabase}\``);
    await runSql(
      target,
      `CREATE DATABASE \`${scratchDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );

    const root = backupDirectory(row!.backupName);
    const manifest = await readManifest(path.join(root, BACKUP_PATHS.MANIFEST_FILE));
    await importDump(target, scratchDatabase, path.join(root, ...manifest.database.fileName.split('/')));

    /* ---- การเชื่อมต่อ ---- */
    const connection = (
      await runSql(
        target,
        `SELECT providerSubject, googleAccountEmail, refreshTokenEncrypted, state, scope
         FROM google_drive_connections WHERE id = '${connectionId}'`,
        scratchDatabase,
      )
    )
      .trim()
      .split('\t');

    assert.equal(connection[0], 'restore-subject-1', 'ตัวระบุบัญชี Google ต้องกลับมา');
    assert.equal(connection[1], 'restore@example.invalid');
    assert.equal(
      connection[2],
      encryptedRefresh,
      'ข้อมูลรับรองที่เข้ารหัสต้องกลับมาตรงทุกไบต์',
    );
    assert.equal(connection[3], 'ACTIVE');
    assert.match(connection[4]!, /drive\.readonly/, 'ขอบเขตสิทธิ์ต้องกลับมา');

    /**
     * ข้อมูลรับรองที่กู้คืนมาต้องถอดรหัสได้จริงด้วยกุญแจเดิม
     *
     * นี่คือหัวใจของ §102: ชุดสำรองอย่างเดียวไม่พอ ต้องมีกุญแจด้วย
     * และเมื่อมีทั้งคู่ การเชื่อมต่อต้องใช้งานต่อได้โดยไม่ต้องให้ผู้ใช้ยินยอมใหม่
     */
    assert.equal(
      new CredentialCipher(key).decrypt(connection[2]!),
      'refresh-token-ที่ต้องรอด',
      'ข้อมูลรับรองที่กู้คืนต้องถอดรหัสได้ด้วยกุญแจเดิม',
    );

    /**
     * กุญแจคนละดอกถอดไม่ได้ - ล้มแบบปิดประตู ไม่ใช่คืนค่าที่เดาเอา
     *
     * ชุดสำรองที่รั่วโดยไม่มีกุญแจจึงไม่ได้ทำให้ Drive ของพนักงานรั่วตามไปด้วย
     */
    assert.throws(
      () => new CredentialCipher(randomBytes(32)).decrypt(connection[2]!),
      /CREDENTIAL_UNREADABLE|ข้อมูลรับรองอ่านไม่ได้/,
    );

    /* ---- ไม่มี token เป็นข้อความธรรมดาในชุดสำรอง ---- */
    const plaintext = (
      await runSql(
        target,
        `SELECT COUNT(*) FROM google_drive_connections
         WHERE refreshTokenEncrypted IS NOT NULL AND refreshTokenEncrypted NOT LIKE 'v1:%'`,
        scratchDatabase,
      )
    ).trim();
    assert.equal(plaintext, '0', 'ทุกข้อมูลรับรองในชุดสำรองต้องอยู่ในรูปที่เข้ารหัสแล้ว');

    /* ---- การผูกไฟล์ ---- */
    const sync = (
      await runSql(
        target,
        `SELECT googleFileId, resourceId, mode, lastRemoteVersion, syncEnabled, HEX(remoteName)
         FROM google_drive_syncs WHERE id = '${syncId}'`,
        scratchDatabase,
      )
    )
      .trim()
      .split('\t');

    assert.equal(sync[0], 'restore-google-file-1', 'ตัวระบุไฟล์ฝั่ง Google ต้องกลับมา');
    assert.equal(sync[1], fileId, 'การผูกกับทรัพยากรใน NAS ต้องกลับมา');
    assert.equal(sync[2], 'SYNCED');
    assert.equal(sync[3], '42', 'เบาะแสรุ่นล่าสุดต้องกลับมา มิฉะนั้นจะซิงก์ซ้ำโดยไม่จำเป็น');
    assert.equal(sync[4], '1');
    assert.match(
      Buffer.from(sync[5] ?? '', 'hex').toString('utf8'),
      /เอกสารต้นฉบับภาษาไทย/,
      'ชื่อต้นทางภาษาไทยต้องกลับมาครบทุกตัวอักษร',
    );

    /* ---- ที่มาบนตัวทรัพยากร ---- */
    const resource = (
      await runSql(
        target,
        `SELECT sourceType, sourceSystem, sourceEntityId FROM resources WHERE id = '${fileId}'`,
        scratchDatabase,
      )
    )
      .trim()
      .split('\t');
    assert.equal(resource[0], 'GOOGLE');
    assert.equal(resource[1], 'GOOGLE_DRIVE');

    /* ---- เวอร์ชันของไฟล์ยังอยู่ ---- */
    const versions = Number(
      (
        await runSql(
          target,
          `SELECT COUNT(*) FROM resource_versions WHERE resourceId = '${fileId}'`,
          scratchDatabase,
        )
      ).trim(),
    );
    assert.ok(versions >= 1, 'เวอร์ชันของไฟล์ที่นำเข้าต้องกลับมา');

    /* ---- การซ้อมต้องไม่แตะระบบจริง ---- */
    const stillLive = await prisma.googleDriveConnection.count({ where: { id: connectionId } });
    assert.equal(stillLive, 1, 'การซ้อมกู้คืนต้องไม่แตะการเชื่อมต่อในระบบจริง');
  });
});
