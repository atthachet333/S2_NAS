import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { googleLoginMessage, googleStartUrl, startGoogleLogin } from './google-login.ts';

/**
 * การเริ่มขั้นตอนเข้าสู่ระบบด้วย Google
 *
 * /api/auth/google/start ตอบด้วย 302 ไปยัง accounts.google.com
 * ถ้าเรียกผ่าน fetch เบราว์เซอร์จะตามรีไดเรกต์เงียบ ๆ แล้วคืนผลให้โค้ด
 * ผู้ใช้จะค้างอยู่ที่หน้าเข้าสู่ระบบและไม่มีวันเห็นหน้าของ Google
 * ชุดทดสอบนี้จึงกันไม่ให้ปุ่มกลับไปเป็นการเรียก API อีก
 */
describe('การเริ่มเข้าสู่ระบบด้วย Google', () => {
  test('สั่งเปลี่ยนหน้าทั้งหน้า ไม่ใช่เรียก API', () => {
    const navigated: string[] = [];

    // ดักทุกช่องทางที่เป็นการเรียก API - ต้องไม่มีตัวใดถูกใช้เลย
    const originalFetch = globalThis.fetch;
    const originalXhr = globalThis.XMLHttpRequest;
    let apiCalls = 0;
    globalThis.fetch = (() => { apiCalls += 1; throw new Error('ห้ามใช้ fetch กับ /api/auth/google/start'); }) as typeof fetch;
    globalThis.XMLHttpRequest = (function () { apiCalls += 1; throw new Error('ห้ามใช้ XHR'); }) as unknown as typeof XMLHttpRequest;

    try {
      startGoogleLogin(undefined, (url) => navigated.push(url));
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.XMLHttpRequest = originalXhr;
    }

    assert.equal(apiCalls, 0, 'ต้องไม่มีการเรียก API ใด ๆ');
    assert.deepEqual(navigated, ['/api/auth/google/start'], 'ต้องนำทางไปที่ปลายทางเริ่มขั้นตอน');
  });

  test('ส่งปลายทางหลังเข้าสู่ระบบไปด้วยเมื่อมี', () => {
    const navigated: string[] = [];
    startGoogleLogin('/system-drive', (url) => navigated.push(url));
    assert.deepEqual(navigated, ['/api/auth/google/start?returnTo=%2Fsystem-drive']);
  });

  test('ใช้เส้นทางสัมพัทธ์ เพื่อให้ผ่าน proxy ของ Vite ไปยัง backend', () => {
    assert.equal(googleStartUrl(), '/api/auth/google/start');
    assert.ok(googleStartUrl().startsWith('/'), 'ต้องไม่ผูกกับโฮสต์หรือพอร์ตใดโดยตรง');
    assert.ok(!googleStartUrl().includes('8889'), 'ต้องไม่ระบุพอร์ตของ backend ตรง ๆ');
  });

  test('ค่าพิเศษใน returnTo ถูก encode ไม่หลุดออกไปเป็นพารามิเตอร์อื่น', () => {
    const url = googleStartUrl('/files?a=1&b=2');
    assert.equal(url, '/api/auth/google/start?returnTo=%2Ffiles%3Fa%3D1%26b%3D2');
    // ต้องมีพารามิเตอร์เดียวเท่านั้น
    assert.equal(url.split('?').length, 2);
  });

  test('ปุ่มบนหน้าเข้าสู่ระบบต้องไม่กลับไปใช้ลิงก์หรือการเรียก API', () => {
    const source = readFileSync(new URL('../pages/LoginPage.tsx', import.meta.url), 'utf8');
    const googleBlock = source.slice(source.indexOf('เข้าสู่ระบบด้วย Google') - 1500);

    assert.ok(source.includes('startGoogleLogin'), 'ต้องเรียกตัวช่วยที่สั่งเปลี่ยนหน้าจริง');
    assert.ok(!googleBlock.includes('googleStartUrl'), 'ต้องไม่ผูก URL กับ href ของลิงก์อีก');
    assert.ok(!/href=\{[^}]*google/i.test(source), 'ปุ่ม Google ต้องไม่เป็น <a href>');
    for (const forbidden of ['apiFetch(', 'axios', 'useMutation']) {
      assert.ok(!googleBlock.includes(forbidden), `ปุ่ม Google ต้องไม่ใช้ ${forbidden}`);
    }
  });
});

describe('ข้อความผลลัพธ์ที่ปลอดภัย', () => {
  test('แปลรหัสเหตุผลเป็นภาษาไทยที่บอกได้ว่าต้องทำอะไรต่อ', () => {
    assert.match(googleLoginMessage('ACCOUNT_NOT_ALLOWED')!, /ยังไม่ได้รับอนุญาต/);
    assert.match(googleLoginMessage('ACCOUNT_DISABLED')!, /ถูกปิดการใช้งาน/);
    assert.match(googleLoginMessage('IDENTITY_CONFLICT')!, /เชื่อมกับผู้ใช้อื่น/);
  });

  test('รหัสที่ไม่รู้จักตกไปที่ข้อความกลาง ไม่แสดงรหัสดิบ', () => {
    const message = googleLoginMessage('SOMETHING_FROM_GOOGLE_INTERNALS')!;
    assert.ok(!message.includes('SOMETHING_FROM_GOOGLE_INTERNALS'));
    assert.match(message, /ไม่สามารถเข้าสู่ระบบด้วย Google ได้/);
  });

  test('ไม่มีข้อความเมื่อไม่มีรหัส', () => {
    assert.equal(googleLoginMessage(null), null);
    assert.equal(googleLoginMessage(undefined), null);
    assert.equal(googleLoginMessage(''), null);
  });
});
