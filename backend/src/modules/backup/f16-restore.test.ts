import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { env } from '../../config/env.js';
import { prisma } from '../../core/prisma.js';
import type { AuthUser } from '../auth/auth.service.js';
import { createFolder } from '../resources/resource.service.js';
import { uploadFile } from '../files/file.service.js';
import { archiveResource } from '../governance/archive.service.js';
import { assignPolicy, createPolicy } from '../governance/retention.service.js';
import { placeLegalHold, releaseLegalHold } from '../governance/legal-hold.service.js';
import { BACKUP_PATHS, backupDirectory, createBackup, deleteBackup } from './backup.service.js';
import { disconnectLockClient } from './distributed-lock.js';
import { importDump, parseDatabaseUrl, runSql } from './mariadb-cli.js';
import { readManifest } from './manifest.js';
import { resetOperationLock } from './operation-lock.js';
import { assertScratchDatabase } from './rehearsal.service.js';

/**
 * F16 - สถานะการกำกับดูแลต้องรอดจากการกู้คืน
 *
 * นโยบายการเก็บรักษา สถานะคลัง และการระงับการลบ เป็น **ข้อมูลธุรกิจหลัก**
 * ไม่ใช่ข้อมูลที่คำนวณใหม่ได้จากที่อื่น
 *
 * ถ้าสิ่งเหล่านี้หายไปตอนกู้คืน ผลที่ตามมาไม่ใช่แค่ความไม่สะดวก:
 * เอกสารที่ถูกระงับการลบตามคำสั่งทางกฎหมายจะกลายเป็นเอกสารธรรมดาที่ลบได้
 * และไม่มีใครรู้ว่าเคยมีการระงับอยู่
 */
describe('F16 การกำกับดูแลต้องรอดจากการกู้คืน', () => {
  const prefix = `f16-restore-${Date.now().toString(36)}`;
  const audit = { ipAddress: '127.0.0.1', userAgent: 'f16-restore-test' };
  const stream = (text: string) => Readable.from([Buffer.from(text, 'utf8')]);

  const policyName = `${prefix} เก็บ 7 ปี`;
  const holdReason = 'ตรวจสอบภาษีย้อนหลัง 2569';

  let user: AuthUser;
  let userId = '';
  let folderId = '';
  let policyId = '';
  let foreverPolicyId = '';
  let archivedId = '';
  let retainedId = '';
  let foreverId = '';
  let expiredId = '';
  let heldId = '';
  let activeHoldId = '';
  let releasedHoldId = '';
  let backupId = '';
  let scratchDatabase = '';

  before(async () => {
    const row = await prisma.user.create({
      data: {
        email: `${prefix}@example.invalid`,
        displayName: 'F16 Restore',
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
      permissions: [
        'resources:read',
        'resources:write',
        'resources:delete',
        'admin:access',
        'system:retention:manage',
      ],
    };

    const folder = await createFolder(user, { name: `${prefix} งาน`, parentId: null }, audit);
    folderId = folder.id;

    const make = async (name: string) => {
      const uploaded = await uploadFile(
        user,
        stream('เอกสารทดสอบการกู้คืน'),
        { parentId: folderId, fileName: name, allowDuplicateContent: true },
        audit,
      );
      return uploaded.resource.id;
    };

    policyId = (await createPolicy(user, { name: policyName, retentionDays: 365 * 7 })).id;
    foreverPolicyId = (await createPolicy(user, { name: `${prefix} ถาวร`, retainForever: true })).id;

    archivedId = await make(`${prefix}-คลัง.txt`);
    await archiveResource(archivedId, user, audit);

    retainedId = await make(`${prefix}-เก็บรักษา.txt`);
    await assignPolicy(retainedId, user, { policyId }, audit);

    foreverId = await make(`${prefix}-ถาวร.txt`);
    await assignPolicy(foreverId, user, { policyId: foreverPolicyId }, audit);

    expiredId = await make(`${prefix}-หมดอายุ.txt`);
    await assignPolicy(expiredId, user, { policyId }, audit);
    await prisma.resource.update({
      where: { id: expiredId },
      data: { retentionUntil: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    heldId = await make(`${prefix}-ระงับ.txt`);
    const active = await placeLegalHold(heldId, user, { reason: holdReason, caseReference: 'AUD-2569' }, audit);
    activeHoldId = active.id;

    // การระงับที่ปลดไปแล้ว - ประวัติต้องรอดมาด้วย ไม่ใช่แค่ที่ยังมีผล
    const released = await placeLegalHold(archivedId, user, { reason: 'ระงับชั่วคราว' }, audit);
    releasedHoldId = released.id;
    await releaseLegalHold(released.id, user, { releaseReason: 'ตรวจเสร็จแล้ว' }, audit);
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

    const all = [archivedId, retainedId, foreverId, expiredId, heldId, folderId].filter(Boolean);
    await prisma.legalHold.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.activityLog.deleteMany({ where: { userId } });
    await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: all } } });
    await prisma.resource.updateMany({ where: { id: { in: all } }, data: { retentionPolicyId: null } });
    await prisma.resource.deleteMany({ where: { id: { in: all.filter((id) => id !== folderId) } } });
    await prisma.resource.deleteMany({ where: { id: folderId } });
    await prisma.retentionPolicy.deleteMany({ where: { createdById: userId } });
    await prisma.user.deleteMany({ where: { id: userId } });

    resetOperationLock();
    await disconnectLockClient();
  });

  test('นโยบาย สถานะคลัง และการระงับการลบ กลับมาครบหลังกู้ดัมป์จริง', async () => {
    const { backup } = await createBackup(user, audit, 'MANUAL');
    assert.equal(backup.status, 'COMPLETED', backup.errorMessage ?? 'สร้างชุดสำรองไม่สำเร็จ');
    backupId = backup.id;

    const row = await prisma.backupLog.findUnique({
      where: { id: backupId },
      select: { backupName: true },
    });

    const target = parseDatabaseUrl();
    scratchDatabase = `${env.S2_NAS_RESTORE_DB_PREFIX}f16_${process.pid}`;
    assertScratchDatabase(scratchDatabase);

    await runSql(target, `DROP DATABASE IF EXISTS \`${scratchDatabase}\``);
    await runSql(
      target,
      `CREATE DATABASE \`${scratchDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );

    const root = backupDirectory(row!.backupName);
    const manifest = await readManifest(path.join(root, BACKUP_PATHS.MANIFEST_FILE));
    await importDump(target, scratchDatabase, path.join(root, ...manifest.database.fileName.split('/')));

    /* ---- ตารางใหม่ของ F16 ต้องอยู่ในชุดสำรอง ---- */
    const tables = await runSql(
      target,
      "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('retention_policies','legal_holds')",
      scratchDatabase,
    );
    assert.equal(Number(tables.trim()), 2, 'ตารางนโยบายและการระงับต้องอยู่ในชุดสำรอง');

    /* ---- นโยบาย ---- */
    const policy = await runSql(
      target,
      `SELECT HEX(name), retentionDays, retainForever FROM retention_policies WHERE id = '${policyId}'`,
      scratchDatabase,
    );
    const [nameHex, days, forever] = policy.trim().split('\t');
    assert.equal(
      Buffer.from(nameHex ?? '', 'hex').toString('utf8'),
      policyName,
      'ชื่อนโยบายภาษาไทยต้องกลับมาครบทุกตัวอักษร',
    );
    assert.equal(Number(days), 365 * 7);
    assert.equal(Number(forever), 0);

    /* ---- สถานะคลัง ---- */
    const archived = await runSql(
      target,
      `SELECT lifecycleState, archivedById, deletedAt FROM resources WHERE id = '${archivedId}'`,
      scratchDatabase,
    );
    const [state, archivedBy, deletedAt] = archived.trim().split('\t');
    assert.equal(state, 'ARCHIVED');
    assert.equal(archivedBy, userId, 'ผู้ที่เก็บเข้าคลังต้องกลับมาด้วย');
    assert.equal(deletedAt, 'NULL', 'เอกสารในคลังต้องไม่กลายเป็นของในถังขยะ');

    /* ---- นโยบายที่ผูกกับเอกสาร ---- */
    const retained = await runSql(
      target,
      `SELECT retentionPolicyId, retentionUntil, retentionForever, retentionStartBasis FROM resources WHERE id = '${retainedId}'`,
      scratchDatabase,
    );
    const [rPolicy, rUntil, rForever, rBasis] = retained.trim().split('\t');
    assert.equal(rPolicy, policyId);
    assert.notEqual(rUntil, 'NULL', 'วันหมดอายุที่คำนวณไว้ต้องกลับมา');
    assert.equal(Number(rForever), 0);
    assert.equal(rBasis, 'CREATED_AT');

    /* ---- เก็บถาวร ---- */
    const forever2 = await runSql(
      target,
      `SELECT retentionForever, retentionUntil FROM resources WHERE id = '${foreverId}'`,
      scratchDatabase,
    );
    const [fForever, fUntil] = forever2.trim().split('\t');
    assert.equal(Number(fForever), 1, 'เก็บถาวรต้องกลับมาเป็นเก็บถาวร');
    assert.equal(fUntil, 'NULL', 'เก็บถาวรต้องไม่มีวันหมดอายุ');

    /* ---- หมดอายุแล้ว ---- */
    const expired = await runSql(
      target,
      `SELECT retentionUntil < NOW() FROM resources WHERE id = '${expiredId}'`,
      scratchDatabase,
    );
    assert.equal(expired.trim(), '1', 'เอกสารที่หมดอายุแล้วต้องยังหมดอายุหลังกู้คืน');

    /* ---- การระงับที่ยังมีผล พร้อมเหตุผล ---- */
    const hold = await runSql(
      target,
      `SELECT isActive, HEX(reason), caseReference FROM legal_holds WHERE id = '${activeHoldId}'`,
      scratchDatabase,
    );
    const [hActive, hReasonHex, hCase] = hold.trim().split('\t');
    assert.equal(Number(hActive), 1, 'การระงับที่ยังมีผลต้องยังมีผลหลังกู้คืน');
    assert.equal(
      Buffer.from(hReasonHex ?? '', 'hex').toString('utf8'),
      holdReason,
      'เหตุผลของการระงับต้องกลับมาครบ ไม่อย่างนั้นจะไม่มีใครกล้าปลด',
    );
    assert.equal(hCase, 'AUD-2569');

    /* ---- ประวัติการระงับที่ปลดไปแล้ว ---- */
    const released = await runSql(
      target,
      `SELECT isActive, releasedById, HEX(releaseReason) FROM legal_holds WHERE id = '${releasedHoldId}'`,
      scratchDatabase,
    );
    const [relActive, relBy, relReasonHex] = released.trim().split('\t');
    assert.equal(Number(relActive), 0);
    assert.equal(relBy, userId);
    assert.equal(
      Buffer.from(relReasonHex ?? '', 'hex').toString('utf8'),
      'ตรวจเสร็จแล้ว',
      'ประวัติการปลดต้องรอดมาด้วย ไม่ใช่เฉพาะการระงับที่ยังมีผล',
    );

    /* ---- การกู้คืนต้องไม่ไปลบอะไรในระบบจริง ---- */
    const liveStill = await prisma.resource.count({
      where: { id: { in: [archivedId, retainedId, foreverId, expiredId, heldId] } },
    });
    assert.equal(liveStill, 5, 'การซ้อมกู้คืนต้องไม่แตะข้อมูลจริงเลย');
  });
});
