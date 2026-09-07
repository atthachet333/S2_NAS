import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { env } from '../../config/env.js';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { createFolder } from '../resources/resource.service.js';
import { uploadFile } from '../files/file.service.js';
import { createPublicShare, revokePublicShare } from '../sharing/public-share.service.js';
import { hashShareToken } from '../sharing/share-token.js';
import { BACKUP_PATHS, backupDirectory, createBackup, deleteBackup } from './backup.service.js';
import { disconnectLockClient } from './distributed-lock.js';
import { importDump, parseDatabaseUrl, runSql } from './mariadb-cli.js';
import { readManifest } from './manifest.js';
import { resetOperationLock } from './operation-lock.js';
import { assertScratchDatabase } from './rehearsal.service.js';

/**
 * F18 - การตั้งค่าลิงก์แชร์ต้องรอดจากการกู้คืน
 *
 * คำถามที่ต้องตอบให้ชัดคือ: หลังกู้คืนระบบ ลิงก์ที่ส่งให้ลูกค้าไปแล้วยังใช้ได้ไหม
 *
 * คำตอบคือ **ยังใช้ได้** เพราะ tokenHash ถูกกู้คืนมาด้วย และนั่นถูกต้อง
 * ลูกค้าที่ถือลิงก์อยู่ไม่ได้ทำอะไรผิด การกู้คืนระบบของเราไม่ควรทำให้เขา
 * ต้องโทรมาถามว่าทำไมเอกสารเปิดไม่ได้
 *
 * ผลที่ตามมาที่ต้องรู้ตัว: ถ้ากู้คืนไปยังจุดก่อนที่จะมีคนกดยกเลิกลิงก์
 * ลิงก์นั้นจะกลับมาใช้ได้อีก การกู้คืนจึงต้องตามด้วยการทบทวนลิงก์ที่เปิดอยู่
 */
describe('F18 การตั้งค่าลิงก์แชร์ต้องรอดจากการกู้คืน', () => {
  const prefix = `f18-restore-${Date.now().toString(36)}`;
  const audit = { ipAddress: '10.1.2.3', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' };
  const stream = (text: string) => Readable.from([Buffer.from(text, 'utf8')]);

  let user: AuthUser;
  let userId = '';
  let folderId = '';
  let fileId = '';
  let backupId = '';
  let scratchDatabase = '';

  /** สี่สภาพที่ต่างกัน เพื่อพิสูจน์ว่าทุกสถานะกลับมาเหมือนเดิม ไม่ใช่แค่สถานะเดียว */
  let activeId = '';
  let protectedId = '';
  let revokedId = '';
  let expiredId = '';
  let activeTokenHash = '';

  before(async () => {
    const row = await prisma.user.create({
      data: {
        email: `${prefix}@example.invalid`,
        displayName: 'F18 Restore',
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
      stream('เอกสารสำหรับทดสอบการกู้คืนลิงก์แชร์'),
      { parentId: folderId, fileName: `${prefix}.txt`, allowDuplicateContent: true },
      audit,
    );
    fileId = uploaded.resource.id;

    /* ---- ลิงก์ที่ใช้งานอยู่ พร้อมโควตาและตัวนับที่ขยับแล้ว ---- */
    const active = await createPublicShare(
      fileId,
      user,
      { allowDownload: true, maxViews: 10, maxDownloads: 5, label: 'ส่งให้ลูกค้า ก' },
      audit,
    );
    activeId = active.link.id;
    /**
     * เก็บแฮชไว้เทียบหลังกู้คืน - **ไม่เก็บโทเคนดิบ**
     *
     * โทเคนดิบไม่ควรอยู่ในตัวแปรของชุดทดสอบที่อาจถูกพิมพ์ออก log
     * แฮชพิสูจน์ได้เท่ากันว่าค่าเดิมกลับมาครบ โดยไม่พกกุญแจติดตัว
     */
    activeTokenHash = hashShareToken(active.url.split('/s/')[1]!);

    await prisma.publicShareLink.update({
      where: { id: activeId },
      data: { viewCount: 3, downloadCount: 2, lastAccessedAt: new Date() },
    });

    /* ---- ลิงก์ที่มีรหัสผ่าน ---- */
    const guarded = await createPublicShare(fileId, user, { password: 'ทดสอบกู้คืน-1234' }, audit);
    protectedId = guarded.link.id;

    /* ---- ลิงก์ที่ถูกยกเลิก ---- */
    const revoked = await createPublicShare(fileId, user, {}, audit);
    revokedId = revoked.link.id;
    await revokePublicShare(revokedId, user, audit);

    /* ---- ลิงก์ที่หมดอายุแล้ว ---- */
    const expired = await createPublicShare(fileId, user, {}, audit);
    expiredId = expired.link.id;
    await prisma.publicShareLink.update({
      where: { id: expiredId },
      data: { expiresAt: new Date(Date.now() - 86_400_000) },
    });
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
    await prisma.publicShareLink.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.publicShareLink.deleteMany({ where: { createdById: userId } });
    await prisma.activityLog.deleteMany({ where: { userId } });
    await prisma.activityLog.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resource.deleteMany({ where: { id: fileId } });
    await prisma.resource.deleteMany({ where: { id: folderId } });
    await prisma.user.deleteMany({ where: { id: userId } });

    resetOperationLock();
    await disconnectLockClient();
  });

  test('ลิงก์แชร์กลับมาครบทุกสถานะ พร้อมสิทธิ์ โควตา และตัวนับ', async () => {
    const liveCount = await prisma.publicShareLink.count();

    const { backup } = await createBackup(user, audit, 'MANUAL');
    assert.equal(backup.status, 'COMPLETED', backup.errorMessage ?? 'สร้างชุดสำรองไม่สำเร็จ');
    backupId = backup.id;

    const row = await prisma.backupLog.findUnique({
      where: { id: backupId },
      select: { backupName: true },
    });

    const target = parseDatabaseUrl();
    scratchDatabase = `${env.S2_NAS_RESTORE_DB_PREFIX}f18_${process.pid}`;
    assertScratchDatabase(scratchDatabase);

    await runSql(target, `DROP DATABASE IF EXISTS \`${scratchDatabase}\``);
    await runSql(
      target,
      `CREATE DATABASE \`${scratchDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );

    const root = backupDirectory(row!.backupName);
    const manifest = await readManifest(path.join(root, BACKUP_PATHS.MANIFEST_FILE));
    await importDump(target, scratchDatabase, path.join(root, ...manifest.database.fileName.split('/')));

    /* ---- จำนวนลิงก์ต้องไม่หายไป ---- */
    const restoredCount = Number(
      (await runSql(target, 'SELECT COUNT(*) FROM public_share_links', scratchDatabase)).trim(),
    );
    assert.ok(
      restoredCount >= liveCount,
      `ลิงก์ที่กู้คืนได้ (${restoredCount}) ต้องไม่น้อยกว่าตอนสำรอง (${liveCount})`,
    );

    /* ---- ลิงก์ที่ใช้งานอยู่: แฮชโทเคนและทุกเงื่อนไขต้องเหมือนเดิมทุกไบต์ ---- */
    const active = (
      await runSql(
        target,
        `SELECT tokenHash, allowPreview, allowDownload, maxViews, viewCount,
                maxDownloads, downloadCount, HEX(label), revokedAt
         FROM public_share_links WHERE id = '${activeId}'`,
        scratchDatabase,
      )
    )
      .trim()
      .split('\t');

    assert.equal(
      active[0],
      activeTokenHash,
      'แฮชโทเคนต้องกลับมาเหมือนเดิม - ลิงก์ที่ส่งให้ลูกค้าไปแล้วจึงยังใช้ได้',
    );
    assert.equal(active[1], '1', 'สิทธิ์ดูตัวอย่างต้องกลับมา');
    assert.equal(active[2], '1', 'สิทธิ์ดาวน์โหลดต้องกลับมา');
    assert.equal(active[3], '10', 'เพดานการเปิดต้องกลับมา');
    assert.equal(active[4], '3', 'จำนวนครั้งที่เปิดไปแล้วต้องกลับมา');
    assert.equal(active[5], '5', 'เพดานการดาวน์โหลดต้องกลับมา');
    assert.equal(
      active[6],
      '2',
      'ตัวนับดาวน์โหลดต้องกลับมา มิฉะนั้นโควตาที่ใช้ไปแล้วจะถูกคืนให้ฟรี',
    );
    assert.match(
      Buffer.from(active[7] ?? '', 'hex').toString('utf8'),
      /ส่งให้ลูกค้า ก/,
      'ชื่อกำกับภาษาไทยต้องกลับมาครบทุกตัวอักษร',
    );
    assert.equal(active[8], 'NULL', 'ลิงก์ที่ยังใช้งานอยู่ต้องไม่กลายเป็นถูกยกเลิก');

    /* ---- ลิงก์ที่มีรหัสผ่าน: แฮชต้องกลับมา ---- */
    const guarded = (
      await runSql(
        target,
        `SELECT passwordHash FROM public_share_links WHERE id = '${protectedId}'`,
        scratchDatabase,
      )
    ).trim();
    assert.match(guarded, /^\$2[aby]\$/, 'แฮชรหัสผ่านต้องกลับมาเป็นแฮช bcrypt ที่ใช้ได้จริง');
    assert.ok(!guarded.includes('ทดสอบกู้คืน-1234'), 'รหัสผ่านดิบต้องไม่เคยอยู่ในฐานข้อมูล');

    /* ---- ลิงก์ที่ถูกยกเลิก: ต้องยังถูกยกเลิกอยู่ ---- */
    const revoked = (
      await runSql(
        target,
        `SELECT revokedAt IS NOT NULL, revokedById FROM public_share_links WHERE id = '${revokedId}'`,
        scratchDatabase,
      )
    )
      .trim()
      .split('\t');
    assert.equal(revoked[0], '1', 'ลิงก์ที่ยกเลิกแล้วต้องไม่ฟื้นคืนชีพจากการกู้คืน');
    assert.equal(revoked[1], userId, 'ต้องยังรู้ว่าใครเป็นคนยกเลิก');

    /* ---- ลิงก์ที่หมดอายุ: วันหมดอายุต้องยังอยู่ในอดีต ---- */
    const expired = (
      await runSql(
        target,
        `SELECT expiresAt < NOW() FROM public_share_links WHERE id = '${expiredId}'`,
        scratchDatabase,
      )
    ).trim();
    assert.equal(expired, '1', 'ลิงก์ที่หมดอายุแล้วต้องยังหมดอายุอยู่');

    /* ---- ไม่มีโทเคนดิบอยู่ในชุดสำรอง ---- */
    const anyRaw = (
      await runSql(
        target,
        `SELECT COUNT(*) FROM public_share_links WHERE LENGTH(tokenHash) <> 64`,
        scratchDatabase,
      )
    ).trim();
    assert.equal(
      anyRaw,
      '0',
      'ทุกแถวต้องเก็บแฮช SHA-256 ยาว 64 อักขระ ไม่ใช่โทเคนดิบยาว 43',
    );

    /* ---- การซ้อมต้องไม่แตะระบบจริง ---- */
    const stillLive = await prisma.publicShareLink.count({ where: { id: activeId } });
    assert.equal(stillLive, 1, 'การซ้อมกู้คืนต้องไม่แตะลิงก์ในระบบจริง');
  });
});
