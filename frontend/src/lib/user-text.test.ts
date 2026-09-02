import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  canActivate,
  canDisable,
  userStatusHint,
  userStatusLabel,
  userStatusTone,
} from './user-text.ts';

describe('สถานะบัญชีผู้ใช้', () => {
  test('แปลงสถานะจริงทั้งสี่เป็นภาษาไทย', () => {
    assert.equal(userStatusLabel('ACTIVE'), 'เปิดใช้งาน');
    assert.equal(userStatusLabel('INVITED'), 'รอเปิดใช้งาน');
    assert.equal(userStatusLabel('SUSPENDED'), 'ระงับชั่วคราว');
    assert.equal(userStatusLabel('DISABLED'), 'ปิดใช้งาน');
  });

  test('สถานะที่ไม่รู้จักต้องอ่านออก ไม่ใช่ช่องว่าง', () => {
    assert.equal(userStatusLabel('SOMETHING_ELSE'), 'SOMETHING_ELSE');
    assert.equal(userStatusTone('SOMETHING_ELSE'), 'neutral');
    assert.equal(userStatusHint('SOMETHING_ELSE'), '');
  });

  test('โทนสีสะท้อนความหมายของสถานะ', () => {
    assert.equal(userStatusTone('ACTIVE'), 'positive');
    assert.equal(userStatusTone('INVITED'), 'warning');
    assert.equal(userStatusTone('DISABLED'), 'danger');
  });

  test('เปิดใช้งานได้เฉพาะบัญชีที่ยังเข้าระบบไม่ได้', () => {
    assert.equal(canActivate('INVITED'), true);
    assert.equal(canActivate('DISABLED'), true);
    assert.equal(canActivate('ACTIVE'), false);
  });

  test('ปิดใช้งานได้เฉพาะบัญชีที่เปิดอยู่ และห้ามปิดบัญชีตัวเอง', () => {
    assert.equal(canDisable('ACTIVE', false), true);
    assert.equal(canDisable('ACTIVE', true), false, 'ปิดบัญชีตัวเองไม่ได้');
    assert.equal(canDisable('INVITED', false), false);
    assert.equal(canDisable('DISABLED', false), false);
  });
});
