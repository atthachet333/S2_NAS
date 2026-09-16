import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DISMISS_QUIET_DAYS, INSTALL_DISMISSED_KEY, installCapability, readDismissedAt, shouldAutoInvite,
} from './install-prompt.ts';

/**
 * คำเชิญให้ติดตั้งแอป (F24-J)
 *
 * **สิ่งที่ชุดนี้กันไว้:** การตื๊อ คำเชิญที่โผล่ซ้ำ ๆ คือเหตุผลที่ผู้ใช้เรียนรู้จะกดปิด
 * ทุกอย่างโดยไม่อ่าน ซึ่งทำให้คำเตือนที่สำคัญจริง ๆ ถูกปิดทิ้งไปด้วย
 */
const DAY = 24 * 60 * 60 * 1000;

describe('F24-J ความสามารถในการติดตั้ง', { concurrency: 1 }, () => {
  test('ติดตั้งไปแล้วสำคัญกว่าทุกสัญญาณ', () => {
    assert.equal(installCapability({ promptCaptured: true, standalone: true, ios: false }), 'INSTALLED');
    assert.equal(installCapability({ promptCaptured: false, standalone: true, ios: true }), 'INSTALLED');
  });

  test('เบราว์เซอร์ที่ให้สั่งกล่องติดตั้งได้', () => {
    assert.equal(installCapability({ promptCaptured: true, standalone: false, ios: false }), 'PROMPTABLE');
  });

  /**
   * iOS ไม่มี beforeinstallprompt และสั่งติดตั้งจากโค้ดไม่ได้เลย
   * จึงต้องเป็นคนละสถานะกับ PROMPTABLE ไม่ใช่แค่ซ่อนปุ่ม
   */
  test('iOS ติดตั้งได้ด้วยมือเท่านั้น', () => {
    assert.equal(installCapability({ promptCaptured: false, standalone: false, ios: true }), 'MANUAL_ONLY');
  });

  test('เบราว์เซอร์อื่นที่ติดตั้งไม่ได้', () => {
    assert.equal(installCapability({ promptCaptured: false, standalone: false, ios: false }), 'UNSUPPORTED');
  });
});

describe('F24-J จังหวะที่เชิญได้', { concurrency: 1 }, () => {
  const base = { capability: 'PROMPTABLE' as const, dismissedAt: null, now: 1_000_000, busy: false, anonymous: false };

  test('ครั้งแรกของผู้ใช้ที่เข้าระบบแล้วและไม่มีงานค้าง', () => {
    assert.equal(shouldAutoInvite(base), true);
  });

  /** ขอให้ติดตั้งก่อนที่ผู้ใช้จะได้เห็นว่าแอปมีประโยชน์ คือการขอเร็วเกินไป */
  test('ยังไม่เข้าสู่ระบบก็ยังไม่เชิญ', () => {
    assert.equal(shouldAutoInvite({ ...base, anonymous: true }), false);
  });

  /** คำเชิญที่บังความคืบหน้าการอัปโหลดคือคำเชิญที่มาผิดเวลา */
  test('มีงานค้างอยู่ก็ไม่เชิญ', () => {
    assert.equal(shouldAutoInvite({ ...base, busy: true }), false);
  });

  test('ติดตั้งแล้วหรือทำไม่ได้ ก็ไม่ต้องเชิญ', () => {
    assert.equal(shouldAutoInvite({ ...base, capability: 'INSTALLED' }), false);
    assert.equal(shouldAutoInvite({ ...base, capability: 'UNSUPPORTED' }), false);
  });

  /** iOS ยังเชิญได้ เพราะคำเชิญคือการบอกวิธี ไม่ใช่การสั่งติดตั้ง */
  test('iOS ยังเชิญให้ดูวิธีทำได้', () => {
    assert.equal(shouldAutoInvite({ ...base, capability: 'MANUAL_ONLY' }), true);
  });

  test('เพิ่งปิดไปก็ต้องเงียบ', () => {
    const now = 1_000_000_000;
    assert.equal(shouldAutoInvite({ ...base, now, dismissedAt: now - DAY }), false);
    assert.equal(shouldAutoInvite({ ...base, now, dismissedAt: now - 29 * DAY }), false);
  });

  test('ผ่านช่วงเงียบแล้วจึงเชิญได้อีกครั้ง', () => {
    const now = 1_000_000_000;
    assert.equal(shouldAutoInvite({ ...base, now, dismissedAt: now - DISMISS_QUIET_DAYS * DAY }), true);
  });
});

describe('F24-J ความจำเรื่องการปิดคำเชิญ', { concurrency: 1 }, () => {
  /** เก็บแค่เวลา ไม่มีอะไรที่ระบุตัวผู้ใช้ได้ */
  test('เก็บเฉพาะเวลา ไม่มีข้อมูลส่วนบุคคล', () => {
    assert.equal(INSTALL_DISMISSED_KEY, 's2-install-dismissed-at');
    assert.ok(!/token|user|email|session|auth/i.test(INSTALL_DISMISSED_KEY));
  });

  test('อ่านค่าที่เสียหายแล้วถือว่าไม่เคยปิด', () => {
    assert.equal(readDismissedAt(null), null);
    assert.equal(readDismissedAt(''), null);
    assert.equal(readDismissedAt('ไม่ใช่ตัวเลข'), null);
    assert.equal(readDismissedAt('-5'), null);
    assert.equal(readDismissedAt('1700000000000'), 1700000000000);
  });
});
