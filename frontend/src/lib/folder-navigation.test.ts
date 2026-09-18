import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { BreadcrumbNode } from './drive.ts';
import { parentDestination } from './folder-navigation.ts';
import { isLikelyTruncated, mobileMetaLine } from './mobile-entry.ts';
import type { DriveEntry } from './drive.ts';

/**
 * การขึ้นไปหนึ่งชั้นบนมือถือ (F24-C)
 *
 * **ทำไมไม่ใช้ประวัติของเบราว์เซอร์:** ผู้ใช้ที่เข้าโฟลเดอร์นี้มาจากผลการค้นหา
 * ถ้ากดย้อนกลับแล้วไปโผล่ที่หน้าค้นหา จะขัดกับสิ่งที่ปุ่มในแถบโฟลเดอร์สื่อความหมายไว้
 * ปุ่มนี้หมายถึง "ขึ้นไปหนึ่งชั้น" ซึ่งเป็นคนละเรื่องกับ "กลับไปหน้าก่อนหน้า"
 */
const node = (id: string | null, name: string): BreadcrumbNode => ({ id, name });

describe('F24-C การนำทางโฟลเดอร์บนมือถือ', { concurrency: 1 }, () => {
  test('อยู่ที่รากแล้ว ไม่มีที่ให้ขึ้นไปอีก', () => {
    const destination = parentDestination([], '/files');
    assert.equal(destination.atRoot, true);
    assert.equal(destination.to, '/files');
  });

  /** ลึกหนึ่งชั้น กลับไปที่รากของไดร์ฟ */
  test('โฟลเดอร์ชั้นแรกกลับไปยังรากของไดร์ฟ', () => {
    const destination = parentDestination([node('a', 'ลูกค้า ก')], '/files');
    assert.equal(destination.atRoot, false);
    assert.equal(destination.to, '/files');
  });

  test('โฟลเดอร์ชั้นลึกกลับไปยังโฟลเดอร์แม่โดยตรง', () => {
    const nodes = [node('a', 'ลูกค้า ก'), node('b', 'ภาษี'), node('c', '2568')];
    const destination = parentDestination(nodes, '/files');
    assert.equal(destination.to, '/files/b');
    assert.equal(destination.label, 'ภาษี');
    assert.equal(destination.atRoot, false);
  });

  /** ไดร์ฟของระบบต้องไม่กลับไปโผล่ที่ไดร์ฟของฉัน */
  test('เคารพรากของไดร์ฟที่กำลังอยู่', () => {
    const destination = parentDestination([node('x', 'คู่มือ')], '/system-drive');
    assert.equal(destination.to, '/system-drive');
  });

  /** ชั้นที่ไม่มีรหัสคือรากที่ใส่มาเพื่อแสดงผล ไม่ใช่โฟลเดอร์ที่เปิดได้ */
  test('ชั้นที่ไม่มีรหัสถูกมองเป็นรากของไดร์ฟ', () => {
    const nodes = [node(null, 'ไดร์ฟของฉัน'), node('b', 'ภาษี')];
    assert.equal(parentDestination(nodes, '/files').to, '/files');
  });
});

const entry = (overrides: Partial<DriveEntry>): DriveEntry => ({
  id: 'r1', kind: 'file', resourceType: 'FILE', name: 'เอกสาร.pdf',
  sizeBytes: 2048, ownerId: 'u1', ownerName: 'ผู้ดูแล', ownerEmail: 'owner@example.invalid',
  modifiedAt: new Date().toISOString(), createdAt: new Date().toISOString(), mimeType: 'application/pdf',
  uploadedBy: null, currentVersion: 1, visibility: 'ORGANIZATION', driveRoot: 'MY_DRIVE',
  classification: 'INTERNAL', classifiedAt: null, classificationRestrictions: null,
  favorite: false, pinned: false, parentId: null, isLocked: false, tags: [],
  lockReason: null, lockedAt: null, lockedByName: null,
  capabilities: {} as DriveEntry['capabilities'],
  ...overrides,
});

describe('F24-C ข้อมูลประกอบของรายการบนมือถือ', { concurrency: 1 }, () => {
  /** ไฟล์บอกขนาด เพราะเป็นสิ่งที่แยกไฟล์ชื่อคล้ายกันได้ */
  test('ไฟล์แสดงขนาดและเวลาที่แก้ล่าสุด', () => {
    const line = mobileMetaLine(entry({ sizeBytes: 2048 }));
    assert.ok(line.includes('KB') || line.includes('2'), `ควรมีขนาด: ${line}`);
    assert.ok(line.includes('·'), 'ควรมีทั้งสองส่วนคั่นกัน');
  });

  /** โฟลเดอร์ไม่มีขนาดรวมที่เชื่อถือได้ จึงบอกจำนวนรายการแทน */
  test('โฟลเดอร์บอกจำนวนรายการ ไม่ใช่ขนาด', () => {
    const line = mobileMetaLine(entry({ kind: 'folder', itemCount: 12, sizeBytes: undefined }));
    assert.ok(line.includes('12 รายการ'), line);
    assert.ok(!line.includes('KB') && !line.includes('MB'), 'ห้ามเดาขนาดของโฟลเดอร์');
  });

  test('โฟลเดอร์ที่ไม่รู้จำนวนรายการยังอ่านออก', () => {
    const line = mobileMetaLine(entry({ kind: 'folder', itemCount: undefined, sizeBytes: undefined }));
    assert.ok(line.includes('โฟลเดอร์'), line);
  });

  /** ชื่อยาวต้องถูกตรวจพบ เพื่อเปิดทางให้ผู้ใช้ดูชื่อเต็ม */
  test('รู้ว่าชื่อยาวเกินกว่าจะแสดงครบบนจอแคบ', () => {
    assert.equal(isLikelyTruncated('รายงาน.pdf'), false);
    assert.equal(isLikelyTruncated('ก'.repeat(80)), true);
    assert.equal(isLikelyTruncated('report-2568-quarterly-summary-final-version-approved.pdf'), false,
      'ยาวแต่ยังอยู่ในสองบรรทัด');
  });
});
