import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { ApiError } from './api.ts';
import { classifyFailure, failureMessage, shouldBlockWrite } from './network-state.ts';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * การแยกแยะสาเหตุของความล้มเหลว (F24-K)
 *
 * **ข้อผิดพลาดที่ชุดนี้กันไว้เป็นหลัก:** การบอกผู้ใช้ว่า "คุณออฟไลน์" ทั้งที่เน็ตของเขาปกติดี
 * แต่เซิร์ฟเวอร์ของเราล่ม ผู้ใช้จะไปรีสตาร์ตเราเตอร์ เปลี่ยน Wi-Fi และเสียเวลาไปกับ
 * ปัญหาที่ไม่ได้อยู่ฝั่งเขาเลย แล้วสุดท้ายก็ยังใช้งานไม่ได้อยู่ดี
 */
describe('F24-K การแยกแยะสาเหตุ', { concurrency: 1 }, () => {
  test('เบราว์เซอร์บอกว่าออฟไลน์ คือออฟไลน์', () => {
    assert.equal(classifyFailure(new Error('อะไรก็ตาม'), { online: false }), 'DEVICE_OFFLINE');
  });

  /** หัวใจของข้อนี้: ออนไลน์อยู่แต่เซิร์ฟเวอร์ไปไม่ถึง ต้องไม่โทษเครื่องของผู้ใช้ */
  test('ออนไลน์แต่ติดต่อเซิร์ฟเวอร์ไม่ได้ ไม่ใช่ออฟไลน์', () => {
    const failure = classifyFailure(new ApiError('NETWORK_ERROR', 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้', 0), { online: true });
    assert.equal(failure, 'BACKEND_UNAVAILABLE');
    assert.notEqual(failure, 'DEVICE_OFFLINE');
    assert.ok(!failureMessage(failure).includes('อุปกรณ์ของคุณ'),
      'ข้อความต้องไม่ชี้ไปที่เครื่องของผู้ใช้');
  });

  test('เซิร์ฟเวอร์พังภายในก็เป็นปัญหาฝั่งเซิร์ฟเวอร์', () => {
    for (const status of [500, 502, 503]) {
      assert.equal(classifyFailure(new ApiError('INTERNAL', 'พัง', status), { online: true }), 'BACKEND_UNAVAILABLE');
    }
  });

  test('หมดเวลาใช้งานต้องบอกให้เข้าระบบใหม่ ไม่ใช่บอกว่าเน็ตมีปัญหา', () => {
    const failure = classifyFailure(new ApiError('UNAUTHORIZED', 'หมดอายุ', 401), { online: true });
    assert.equal(failure, 'SESSION_EXPIRED');
    assert.ok(failureMessage(failure).includes('เข้าสู่ระบบ'));
  });

  /** ฟีเจอร์ที่ผู้ดูแลยังไม่เปิด ไม่ใช่ความผิดพลาดของเครือข่ายหรือของผู้ใช้ */
  test('ฟีเจอร์ยังไม่พร้อมเป็นคนละเรื่องกับเครือข่าย', () => {
    for (const code of ['ASSISTANT_DISABLED', 'SMART_FILING_TEXT_NOT_READY', 'SEMANTIC_SEARCH_UNAVAILABLE']) {
      assert.equal(classifyFailure(new ApiError(code, 'ยังไม่พร้อม', 409), { online: true }), 'FEATURE_UNAVAILABLE');
    }
  });

  test('ข้อผิดพลาดทางธุรกิจตามปกติไม่ถูกเหมารวมเป็นปัญหาเครือข่าย', () => {
    assert.equal(classifyFailure(new ApiError('VALIDATION_ERROR', 'ข้อมูลไม่ถูกต้อง', 400), { online: true }), 'REQUEST_ERROR');
    assert.equal(classifyFailure(new ApiError('RESOURCE_ACCESS_DENIED', 'ไม่มีสิทธิ์', 403), { online: true }), 'REQUEST_ERROR');
  });

  test('ทุกสาเหตุมีข้อความของตัวเอง และไม่ซ้ำกัน', () => {
    const all = ['DEVICE_OFFLINE', 'BACKEND_UNAVAILABLE', 'SESSION_EXPIRED', 'FEATURE_UNAVAILABLE', 'REQUEST_ERROR'] as const;
    const messages = all.map((failure) => failureMessage(failure));
    assert.equal(new Set(messages).size, all.length, 'ข้อความซ้ำกันจะทำให้แยกสาเหตุไม่ออก');
    assert.ok(messages.every((message) => message.length > 0));
  });

  /** กันการเขียนไว้ก่อน เฉพาะเมื่อรู้แน่ ไม่ใช่เมื่อสงสัย */
  test('กันการเขียนเฉพาะตอนที่รู้แน่ว่าออฟไลน์', () => {
    assert.equal(shouldBlockWrite(false), true);
    assert.equal(shouldBlockWrite(true), false);
  });
});

describe('F24-K นโยบายการเขียนเมื่อเน็ตกลับมา', { concurrency: 1 }, () => {
  /**
   * คำสั่งเขียนต้องล้มเหลวทันที ไม่ใช่ถูกพักแล้วเล่นซ้ำเอง
   *
   * ค่าเริ่มต้นของ TanStack Query คือ networkMode 'online' ซึ่งพักคำสั่งเขียนไว้
   * ขณะออฟไลน์แล้วส่งให้เองเมื่อกลับมาออนไลน์ นั่นคือการย้ายหรือแก้เอกสารเกิดขึ้น
   * ในจังหวะที่ผู้ใช้ไม่ได้สั่ง ซึ่งขัดกับข้อตกลงว่าการเขียนต้องมาจากการกระทำใหม่เสมอ
   */
  test('ตั้งค่า mutations ไม่ให้ถูกพักไว้ส่งทีหลัง', () => {
    const main = fs.readFileSync(path.join(srcDir, 'main.tsx'), 'utf8');
    assert.ok(/mutations:\s*\{[\s\S]*networkMode:\s*'always'/.test(main),
      'ต้องตั้ง networkMode ของ mutations เป็น always เพื่อไม่ให้ไลบรารีเล่นซ้ำเอง');
  });

  /** การอ่านรีเฟรชเองได้ - เป็นอีกครึ่งของกฎเดียวกัน */
  test('การอ่านยังรีเฟรชเองเมื่อเน็ตกลับมา', () => {
    const main = fs.readFileSync(path.join(srcDir, 'main.tsx'), 'utf8');
    assert.ok(/refetchOnReconnect:\s*true/.test(main));
  });

  /** ไม่มีคิวการเขียนเบื้องหลังที่ไหนในระบบ */
  test('ไม่มีการสร้างคิวการเขียนเบื้องหลัง', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry.name) || entry.name.includes('.test.')) continue;
        const content = fs.readFileSync(full, 'utf8');
        if (/SyncManager|backgroundSync|registration\.sync|periodicSync/.test(content)) {
          offenders.push(path.relative(srcDir, full));
        }
      }
    };
    walk(srcDir);
    assert.deepEqual(offenders, [], 'ระบบนี้ตกลงกันไว้ว่าไม่มีการซิงก์เบื้องหลัง');
  });
});
