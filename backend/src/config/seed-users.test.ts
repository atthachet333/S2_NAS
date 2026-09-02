import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  SEED_USERS,
  UNCONFIRMED_SEED_EMAILS,
  getSeedableUsers,
  isValidEmail,
  normalizeEmail,
} from './seed-users.js';

describe('seed users', () => {
  test('normalize อีเมลเป็นตัวพิมพ์เล็กและตัดช่องว่าง', () => {
    assert.equal(normalizeEmail('  S2A.Manage@Gmail.COM '), 's2a.manage@gmail.com');
  });

  test('อีเมลใน SEED_USERS เป็นตัวพิมพ์เล็กทั้งหมด', () => {
    for (const user of SEED_USERS) {
      assert.equal(user.email, user.email.toLowerCase());
    }
  });

  test('มีผู้ใช้ระดับ SUPER_ADMIN เพียงคนเดียว', () => {
    const admins = SEED_USERS.filter((user) => user.role === 'SUPER_ADMIN');
    assert.equal(admins.length, 1);
  });

  test('ไม่มีอีเมลซ้ำ', () => {
    const emails = getSeedableUsers().map((user) => user.email);
    assert.equal(new Set(emails).size, emails.length);
  });

  test('อีเมลที่ยังไม่ยืนยันต้องไม่ผ่านการตรวจรูปแบบ และต้องไม่อยู่ในรายการ seed', () => {
    for (const email of UNCONFIRMED_SEED_EMAILS) {
      assert.equal(isValidEmail(email), false);
      assert.equal(
        SEED_USERS.some((user) => user.email === normalizeEmail(email)),
        false,
      );
    }
  });

  test('getSeedableUsers คืนเฉพาะอีเมลที่ถูกต้อง', () => {
    const users = getSeedableUsers([
      { email: 'GOOD@Example.com', role: 'MEMBER' },
      { email: '@wpueng@gmail.com', role: 'MEMBER' },
      { email: 'good@example.com', role: 'VIEWER' },
    ]);
    assert.deepEqual(users, [{ email: 'good@example.com', role: 'MEMBER' }]);
  });
});
