import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { after, describe, test } from 'node:test';
import { prisma } from '../../core/prisma.js';
import { resolveStorageKey } from '../../core/storage-provider.js';
import { isSafeStorageKey } from '../backup/manifest.js';
import { QaFixtureScope, countOrphanStorageReferences } from './qa-fixture.js';

/**
 * ตัวช่วยสร้างของทดสอบต้องไม่สร้างสถานะที่เป็นไปไม่ได้ในระบบจริง (F21)
 *
 * ชุดนี้ตรวจตัวช่วยเอง ไม่ได้ตรวจผู้ช่วยเอกสาร เหตุผลคือของทดสอบที่พังเคยทำให้
 * ชุดตรวจการสำรองข้อมูลล้ม 43 รายการ โดยที่โค้ดจริงไม่มีอะไรผิดเลย
 * เครื่องมือทดสอบที่เชื่อถือไม่ได้ ทำให้ผลทดสอบทั้งหมดเชื่อถือไม่ได้ตามไปด้วย
 */

const scopes: QaFixtureScope[] = [];
const track = (prefix: string) => {
  const scope = new QaFixtureScope(prefix);
  scopes.push(scope);
  return scope;
};

after(async () => { for (const scope of scopes) await scope.destroy(); });

describe('F21 QA fixture leaves no orphan storage references', { concurrency: 1 }, () => {
  /** 1. แถวในฐานข้อมูลกับไฟล์บนดิสก์ต้องเกิดขึ้นคู่กันเสมอ */
  test('creating a fixture writes both the database row and the physical file', async () => {
    const scope = track(`qafix-${process.pid}-${Date.now()}`);
    const user = await scope.createUser('QA fixture owner');
    const resourceId = await scope.createResource({ name: 'qa-fixture-invoice.txt', ownerId: user.id,
      versions: [{ text: 'ใบแจ้งหนี้ทดสอบ ยอด 12,500 บาท' }, { text: 'ใบแจ้งหนี้ทดสอบ ฉบับแก้ไข ยอด 15,000 บาท' }] });

    const versions = await prisma.resourceVersion.findMany({ where: { resourceId }, orderBy: { versionNumber: 'asc' } });
    assert.equal(versions.length, 2);
    for (const version of versions) {
      // ไฟล์ต้องมีอยู่จริง อ่านได้ และขนาดต้องตรงกับที่บันทึกไว้
      const full = resolveStorageKey(version.storageKey);
      await assert.doesNotReject(access(full), `ไม่พบไฟล์จริงของ ${version.storageKey}`);
      const { stat } = await import('node:fs/promises');
      assert.equal((await stat(full)).size, Number(version.size), 'ขนาดไฟล์ต้องตรงกับที่บันทึกในฐานข้อมูล');
      // ต้องใช้แบบแผน path เดียวกับการอัปโหลดจริง ไม่ใช่รูปแบบเฉพาะของเทสต์
      assert.ok(isSafeStorageKey(version.storageKey), 'storageKey ต้องผ่านเกณฑ์ความปลอดภัยเดียวกับของจริง');
      assert.ok(version.storageKey.startsWith(`resources/${resourceId}/`),
        `storageKey ต้องอยู่ใต้ resources/<id>/ แต่ได้ ${version.storageKey}`);
    }
    assert.equal(await countOrphanStorageReferences([resourceId]), 0);
  });

  /** 2. การเก็บกวาดต้องลบทั้งสองฝั่ง ไม่เหลือแถวและไม่เหลือไฟล์ */
  test('destroy removes the database rows and the files together', async () => {
    const scope = new QaFixtureScope(`qafix-destroy-${process.pid}-${Date.now()}`);
    const user = await scope.createUser('QA fixture destroy');
    const resourceId = await scope.createResource({ name: 'qa-fixture-contract.txt', ownerId: user.id,
      versions: [{ text: 'สัญญาทดสอบ กำหนดส่งมอบ 30 กันยายน 2569' }] });
    const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId } });
    const full = resolveStorageKey(version.storageKey);
    await assert.doesNotReject(access(full));

    await scope.destroy();

    assert.equal(await prisma.resource.count({ where: { id: resourceId } }), 0, 'แถวทรัพยากรต้องถูกลบ');
    assert.equal(await prisma.resourceVersion.count({ where: { resourceId } }), 0, 'แถวเวอร์ชันต้องถูกลบ');
    assert.equal(await prisma.user.count({ where: { id: user.id } }), 0, 'ผู้ใช้ทดสอบต้องถูกลบ');
    await assert.rejects(access(full), 'ไฟล์บนดิสก์ต้องถูกลบไปด้วย');
  });

  /**
   * 3. การทำงานที่ถูกขัดจังหวะต้องไม่ทิ้งการอ้างอิงกำพร้าไว้
   *
   * จำลองด้วยการโยนข้อผิดพลาดกลางการทดสอบแล้วให้ finally เก็บกวาด ซึ่งเป็นรูปแบบ
   * เดียวกับที่สคริปต์ QA ใช้จริง กรณีที่โปรเซสถูกฆ่าทันทีอยู่นอกขอบเขตที่ทดสอบได้
   * แต่เป็นกรณีที่การเขียนไฟล์ก่อนบันทึกแถวช่วยจำกัดความเสียหายไว้แล้ว
   */
  test('an interrupted run still cleans up through finally', async () => {
    const scope = new QaFixtureScope(`qafix-interrupt-${process.pid}-${Date.now()}`);
    let resourceId = '';
    let storageKey = '';
    await assert.rejects(async () => {
      try {
        const user = await scope.createUser('QA fixture interrupted');
        resourceId = await scope.createResource({ name: 'qa-fixture-interrupted.txt', ownerId: user.id,
          versions: [{ text: 'เอกสารที่ถูกขัดจังหวะกลางคัน' }] });
        storageKey = (await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId } })).storageKey;
        throw new Error('จำลองความล้มเหลวกลางการทดสอบ');
      } finally {
        await scope.destroy();
      }
    }, /จำลองความล้มเหลว/u);

    assert.notEqual(storageKey, '');
    assert.equal(await prisma.resourceVersion.count({ where: { resourceId } }), 0);
    await assert.rejects(access(resolveStorageKey(storageKey)), 'ไฟล์ต้องไม่ค้างอยู่หลังการขัดจังหวะ');
    assert.equal(await countOrphanStorageReferences([resourceId]), 0);
  });

  /**
   * 4. เกณฑ์ความครบถ้วนของการสำรองข้อมูลต้องยังเข้มเหมือนเดิม
   *
   * ยืนยันว่าการแก้ครั้งนี้ไม่ได้ไปผ่อนเกณฑ์ให้ผ่านง่ายขึ้น โดยสร้างการอ้างอิงกำพร้า
   * ขึ้นมาจริง ๆ แล้วตรวจว่ายังถูกจับได้ จากนั้นจึงเก็บกวาดทิ้ง
   */
  test('backup integrity still detects a genuine orphan reference', async () => {
    const scope = track(`qafix-strict-${process.pid}-${Date.now()}`);
    const user = await scope.createUser('QA fixture strictness');
    const resourceId = await scope.createResource({ name: 'qa-fixture-strict.txt', ownerId: user.id,
      versions: [{ text: 'เอกสารสำหรับตรวจความเข้มของเกณฑ์' }] });
    assert.equal(await countOrphanStorageReferences([resourceId]), 0);

    // ลบไฟล์ทิ้งโดยไม่แตะแถว เพื่อสร้างสภาพกำพร้าแบบเดียวกับที่เคยทำให้ชุดสำรองล้ม
    const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId } });
    const { rm } = await import('node:fs/promises');
    await rm(resolveStorageKey(version.storageKey), { force: true });

    assert.equal(await countOrphanStorageReferences([resourceId]), 1,
      'การอ้างอิงกำพร้าต้องยังถูกตรวจพบ เกณฑ์ต้องไม่ถูกผ่อนลง');

    await scope.destroy();
    assert.equal(await countOrphanStorageReferences([resourceId]), 0);
  });
});
