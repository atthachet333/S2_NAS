import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  SECTION_ORDER,
  SECTION_TITLE,
  SOURCE_LABEL,
  UNIT_LABEL,
  changedEntries,
  retentionWarning,
  validateSettingValue,
  type SettingView,
} from './system-settings.ts';

const setting = (overrides: Partial<SettingView> = {}): SettingView => ({
  key: 'TRASH_RETENTION_DAYS',
  section: 'TRASH',
  label: 'ลบถาวรอัตโนมัติหลัง',
  description: 'คำอธิบาย',
  unit: 'DAYS',
  value: 14,
  source: 'ENVIRONMENT',
  defaultValue: 14,
  envKey: 'S2_NAS_TRASH_RETENTION_DAYS',
  hotReload: 'FULL',
  ...overrides,
});

describe('การตรวจค่าตั้งค่าก่อนบันทึก', () => {
  test('ค่าที่ถูกต้องผ่าน', () => {
    assert.equal(validateSettingValue('TRASH_RETENTION_DAYS', '14'), null);
    assert.equal(validateSettingValue('TRASH_RETENTION_DAYS', '365'), null);
    assert.equal(validateSettingValue('MAX_UPLOAD_SIZE_MB', '100'), null);
    assert.equal(validateSettingValue('ZIP_MAX_RESOURCES', '1000'), null);
  });

  test('ค่าว่าง ตัวอักษร และค่าที่ไม่ใช่จำนวนเต็ม ถูกปฏิเสธพร้อมเหตุผล', () => {
    assert.equal(validateSettingValue('TRASH_RETENTION_DAYS', ''), 'กรุณากรอกค่า');
    assert.equal(validateSettingValue('TRASH_RETENTION_DAYS', '   '), 'กรุณากรอกค่า');
    assert.equal(validateSettingValue('TRASH_RETENTION_DAYS', 'abc'), 'ต้องเป็นตัวเลข');
    assert.equal(validateSettingValue('TRASH_RETENTION_DAYS', '1.5'), 'ต้องเป็นจำนวนเต็ม');
  });

  test('ค่าติดลบและศูนย์ถูกปฏิเสธ - ถังขยะ 0 วันคือลบทิ้งทันที', () => {
    assert.ok(validateSettingValue('TRASH_RETENTION_DAYS', '0'));
    assert.ok(validateSettingValue('TRASH_RETENTION_DAYS', '-1'));
    assert.ok(validateSettingValue('MAX_UPLOAD_SIZE_MB', '0'));
  });

  test('ค่าที่เกินเพดานถูกปฏิเสธ', () => {
    assert.ok(validateSettingValue('TRASH_RETENTION_DAYS', '366'));
    assert.ok(validateSettingValue('MAX_UPLOAD_SIZE_MB', '10241'));
    assert.ok(validateSettingValue('ZIP_MAX_RESOURCES', '100001'));
  });

  test('ตัวเลขที่เกินช่วงปลอดภัยของ JavaScript ถูกปฏิเสธ ไม่ปล่อยให้ล้นเงียบ ๆ', () => {
    assert.equal(
      validateSettingValue('ZIP_MAX_BYTES', String(Number.MAX_SAFE_INTEGER + 2)),
      'ตัวเลขเกินช่วงที่ระบบรองรับ',
    );
    assert.ok(validateSettingValue('ZIP_MAX_BYTES', '1e400'));
  });
});

describe('คำเตือนเมื่อลดอายุถังขยะ', () => {
  test('การลดจำนวนวันต้องเตือน เพราะทำให้เกิดการลบถาวรเร็วขึ้น', () => {
    const warning = retentionWarning(30, 7);
    assert.ok(warning);
    assert.ok(warning!.includes('30'));
    assert.ok(warning!.includes('7'));
  });

  test('การเพิ่มหรือคงเดิมไม่ต้องเตือน', () => {
    assert.equal(retentionWarning(14, 30), null);
    assert.equal(retentionWarning(14, 14), null);
  });
});

describe('การหาค่าที่เปลี่ยนไป', () => {
  const settings = [
    setting({ key: 'TRASH_RETENTION_DAYS', value: 14 }),
    setting({ key: 'ZIP_MAX_RESOURCES', section: 'ZIP', unit: 'ITEMS', value: 1000 }),
  ];

  test('ไม่มีการแก้ ต้องไม่ส่งอะไรไปบันทึก', () => {
    assert.deepEqual(changedEntries(settings, {}), []);
  });

  test('พิมพ์ค่าเดิมกลับเข้าไปไม่นับเป็นการเปลี่ยน', () => {
    assert.deepEqual(changedEntries(settings, { TRASH_RETENTION_DAYS: '14' }), []);
  });

  test('ส่งเฉพาะค่าที่เปลี่ยนจริง ไม่ส่งทั้งชุด', () => {
    const changed = changedEntries(settings, { TRASH_RETENTION_DAYS: '30', ZIP_MAX_RESOURCES: '1000' });
    assert.deepEqual(changed, [{ key: 'TRASH_RETENTION_DAYS', value: 30 }]);
  });

  test('ช่องที่ถูกล้างว่างไม่ถูกส่งไปเป็น 0', () => {
    assert.deepEqual(changedEntries(settings, { TRASH_RETENTION_DAYS: '' }), []);
    assert.deepEqual(changedEntries(settings, { TRASH_RETENTION_DAYS: '  ' }), []);
  });
});

describe('ป้ายชื่อบนหน้าจอ', () => {
  test('แหล่งที่มาของค่าอ่านออกทั้งสามแบบ', () => {
    assert.equal(SOURCE_LABEL.DATABASE, 'ค่าจากระบบ');
    assert.equal(SOURCE_LABEL.ENVIRONMENT, 'ค่าจาก Environment');
    assert.equal(SOURCE_LABEL.DEFAULT, 'ค่าเริ่มต้นของระบบ');
  });

  test('หัวข้อครบทั้งสามกลุ่มตามที่ตกลงไว้', () => {
    assert.deepEqual(SECTION_ORDER, ['UPLOAD', 'TRASH', 'ZIP']);
    assert.equal(SECTION_TITLE.UPLOAD, 'ไฟล์และการอัปโหลด');
    assert.equal(SECTION_TITLE.TRASH, 'ถังขยะ');
    assert.equal(SECTION_TITLE.ZIP, 'ดาวน์โหลด ZIP');
  });

  test('ทุกหน่วยมีคำอ่านภาษาไทย', () => {
    for (const unit of ['DAYS', 'MEGABYTES', 'ITEMS', 'BYTES'] as const) {
      assert.ok(UNIT_LABEL[unit], `${unit} ต้องมีป้ายชื่อ`);
    }
  });
});
