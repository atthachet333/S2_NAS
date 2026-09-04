import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DriveEntry } from './drive.ts';
import { MY_DRIVE_LABEL, SYSTEM_DRIVE_LABEL, driveDestination, driveRootLabel } from './drive-labels.ts';
import { destinationLabel, nextSelection, originLabel, responsibleLabel, selectAllState, uploaderLabel } from './resource-table.ts';
import { canCreateInSystemDrive, canViewSystemDrive } from './system-drive.ts';
import { canSelectDriveRoot, isSameLocation, selectableDriveRoots } from './folder-picker.ts';

const capabilities = {
  canView: true, canEdit: true, canRename: true, canMove: true, canDelete: true,
  canShare: true, canLock: true, canDownload: true, canUploadVersion: true, canTransferOwner: true,
};

const entry = (overrides: Partial<DriveEntry> = {}): DriveEntry => ({
  id: 'r1', kind: 'file', resourceType: 'FILE', name: 'test.pdf',
  ownerId: 'owner', ownerName: 'สมชาย ผู้ดูแล', ownerEmail: 'owner@example.invalid',
  modifiedAt: '', createdAt: '', mimeType: 'application/pdf',
  uploadedBy: { id: 'u2', displayName: 'สมหญิง ผู้อัปโหลด', email: 'up@example.invalid' },
  currentVersion: 1, visibility: 'ORGANIZATION', driveRoot: 'MY_DRIVE',
  favorite: false, pinned: false, parentId: null, isLocked: false,
  tags: [], lockReason: null, lockedAt: null, lockedByName: null,
  source: 'MANUAL', capabilities, ...overrides,
});

describe('ป้ายชื่อไดร์ฟ', () => {
  test('ชื่อที่ผู้ใช้เห็นคือ "ไดร์ฟของฉัน" ไม่ใช่ "ไฟล์ของฉัน"', () => {
    assert.equal(MY_DRIVE_LABEL, 'ไดร์ฟของฉัน');
    assert.equal(SYSTEM_DRIVE_LABEL, 'ไดร์ฟของระบบ');
    assert.equal(driveRootLabel('SYSTEM_DRIVE'), 'ไดร์ฟของระบบ');
    // ค่าที่หายไปต้องตกไปที่ไดร์ฟของฉัน ไม่ใช่ช่องว่าง
    assert.equal(driveRootLabel(null), 'ไดร์ฟของฉัน');
  });

  test('ปลายทางเป็นเส้นทางเชิงตรรกะที่อ่านออก', () => {
    assert.equal(driveDestination('SYSTEM_DRIVE', ['คู่มือบริษัท']), 'ไดร์ฟของระบบ / คู่มือบริษัท');
    assert.equal(driveDestination('MY_DRIVE', ['TEST']), 'ไดร์ฟของฉัน / TEST');
    assert.equal(driveDestination('MY_DRIVE'), 'ไดร์ฟของฉัน');
  });
});

describe('ความหมายของคอลัมน์ในตารางทรัพยากร', () => {
  test('ผู้อัปโหลดคือประวัติ ส่วนผู้ดูแลคือผู้รับผิดชอบปัจจุบัน - คนละคนกันได้', () => {
    const row = entry();
    assert.equal(uploaderLabel(row), 'สมหญิง ผู้อัปโหลด');
    assert.equal(responsibleLabel(row), 'สมชาย ผู้ดูแล');
  });

  test('ทรัพยากรที่ระบบเชื่อมต่อสร้าง ต้องแสดงชื่อแอป ไม่ใช่ชื่อคน', () => {
    const row = entry({
      createdByIntegrationApp: { id: 'a1', name: 'S2 Payroll', code: 'S2_PAYROLL' },
      source: 'S2_PAYROLL',
    });
    assert.equal(uploaderLabel(row), 'S2 Payroll');
    assert.equal(originLabel(row), 'S2 Payroll');
  });

  test('ไฟล์ที่ไม่มีประวัติผู้อัปโหลดต้องอ่านออก ไม่ใช่ช่องว่าง', () => {
    assert.equal(uploaderLabel(entry({ uploadedBy: null })), '—');
  });

  test('ต้นทางแสดงระบบที่ทรัพยากรเข้ามาจริง', () => {
    assert.equal(originLabel(entry()), 'Uploaded');
    assert.equal(originLabel(entry({ source: 'GOOGLE' })), 'Google');
  });

  test('ปลายทางอิงไดร์ฟของรายการนั้น และไม่เปิดเผยเส้นทางจริงบนดิสก์', () => {
    assert.equal(destinationLabel(entry({ driveRoot: 'SYSTEM_DRIVE' }), ['คู่มือบริษัท']), 'ไดร์ฟของระบบ / คู่มือบริษัท');
    const label = destinationLabel(entry(), ['TEST']);
    assert.equal(label, 'ไดร์ฟของฉัน / TEST');
    assert.ok(!label.includes('/storage'));
    assert.ok(!label.includes(String.fromCharCode(92)));
  });
});

describe('นโยบายไดร์ฟของระบบฝั่งหน้าจอ', () => {
  const user = (roles: string[], permissions: string[]) => ({ roles, permissions });

  test('ผู้ใช้ภายในทั่วไปเห็นไดร์ฟของระบบ แต่เพิ่มของไม่ได้', () => {
    const member = user(['MEMBER'], ['resources:read', 'resources:write', 'resources:share', 'resources:lock']);
    assert.equal(canViewSystemDrive(member), true);
    assert.equal(canCreateInSystemDrive(member), false);
  });

  test('ผู้ดูแลระบบและผู้ที่ได้รับสิทธิ์เฉพาะเท่านั้นที่เพิ่มของได้', () => {
    assert.equal(canCreateInSystemDrive(user(['ADMIN'], ['resources:read'])), true);
    assert.equal(canCreateInSystemDrive(user(['SUPER_ADMIN'], [])), true);
    assert.equal(canCreateInSystemDrive(user(['MEMBER'], ['system-drive:write'])), true);
  });

  test('ผู้ที่ยังไม่ได้เข้าสู่ระบบไม่ได้สิทธิ์อะไรเลย', () => {
    assert.equal(canViewSystemDrive(null), false);
    assert.equal(canCreateInSystemDrive(undefined), false);
  });
});

describe('เลือกทั้งหมด', () => {
  const loaded = ['a', 'b', 'c'];

  test('สามสถานะสะท้อนสิ่งที่ผู้ใช้เห็นจริง', () => {
    assert.equal(selectAllState(loaded, new Set()), 'unchecked');
    assert.equal(selectAllState(loaded, new Set(['a'])), 'indeterminate');
    assert.equal(selectAllState(loaded, new Set(['a', 'b'])), 'indeterminate');
    assert.equal(selectAllState(loaded, new Set(loaded)), 'checked');
  });

  test('ไม่มีรายการให้เลือก ต้องไม่แสดงว่าเลือกครบ', () => {
    assert.equal(selectAllState([], new Set()), 'unchecked');
    assert.equal(selectAllState([], new Set(['x'])), 'unchecked');
  });

  test('เลือกทั้งหมดครอบเฉพาะรายการที่โหลดมาแล้ว ไม่ลามไปหน้าที่ยังไม่เห็น', () => {
    const next = nextSelection(loaded, new Set());
    assert.deepEqual([...next].sort(), ['a', 'b', 'c']);
    assert.ok(!next.has('d'), 'รายการที่ยังไม่โหลดต้องไม่ถูกเลือก');
  });

  test('กดซ้ำตอนเลือกครบแล้วคือการล้างการเลือก', () => {
    assert.equal(nextSelection(loaded, new Set(loaded)).size, 0);
    // เลือกบางส่วนแล้วกด ต้องเลือกให้ครบก่อน ไม่ใช่ล้างทิ้ง
    assert.equal(nextSelection(loaded, new Set(['a'])).size, 3);
  });
});

describe('กติกาปลายทางของตัวเลือกโฟลเดอร์', () => {
  const admin = { roles: ['SUPER_ADMIN'], permissions: ['resources:write'] };
  const member = { roles: ['MEMBER'], permissions: ['resources:write', 'resources:share'] };

  test('ย้ายภายในไดร์ฟเดิมทำได้เสมอ', () => {
    assert.equal(canSelectDriveRoot(member, 'MY_DRIVE', 'MY_DRIVE'), true);
    assert.equal(canSelectDriveRoot(member, 'SYSTEM_DRIVE', 'SYSTEM_DRIVE'), true);
  });

  test('ผู้ใช้ทั่วไปเลือกปลายทางข้ามไดร์ฟไม่ได้ ตรงกับ CROSS_DRIVE_MOVE_DENIED ที่ backend', () => {
    assert.equal(canSelectDriveRoot(member, 'MY_DRIVE', 'SYSTEM_DRIVE'), false);
    assert.deepEqual(selectableDriveRoots(member, 'MY_DRIVE'), ['MY_DRIVE']);
  });

  test('ผู้ดูแลระบบเลือกได้ทั้งสองไดร์ฟ', () => {
    assert.equal(canSelectDriveRoot(admin, 'MY_DRIVE', 'SYSTEM_DRIVE'), true);
    assert.deepEqual(selectableDriveRoots(admin, 'MY_DRIVE'), ['MY_DRIVE', 'SYSTEM_DRIVE']);
  });

  test('ปลายทางเดียวกับตำแหน่งเดิมถูกตรวจจับได้', () => {
    assert.equal(
      isSameLocation({ driveRoot: 'MY_DRIVE', parentId: 'f1' }, { driveRoot: 'MY_DRIVE', parentId: 'f1' }),
      true,
    );
    assert.equal(
      isSameLocation({ driveRoot: 'MY_DRIVE', parentId: null }, { driveRoot: 'MY_DRIVE', parentId: null }),
      true,
    );
  });

  test('รากของคนละไดร์ฟไม่ใช่ตำแหน่งเดียวกัน แม้ parentId เป็น null ทั้งคู่', () => {
    assert.equal(
      isSameLocation({ driveRoot: 'MY_DRIVE', parentId: null }, { driveRoot: 'SYSTEM_DRIVE', parentId: null }),
      false,
    );
  });
});
