import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { findForbiddenCacheEntries, isCacheableShellAsset, mustBypassCache } from './pwa-cache-policy.ts';

/**
 * เอกสารของผู้ใช้ต้องไม่ตกค้างอยู่บนเครื่อง (F24-B)
 *
 * **ทำไมชุดนี้จึงเป็นชุดที่สำคัญที่สุดของ F24-B:** service worker เขียนลงดิสก์ของเครื่อง
 * ผู้ใช้ในที่ที่ไม่ถูกล้างตอนออกจากระบบ ถ้าคำตอบของ API หรือไบต์ของเอกสารหลุดลงไป
 * เพียงครั้งเดียว มันจะอยู่ที่นั่นข้ามผู้ใช้และข้ามการออกจากระบบ โดยไม่มีใครสังเกต
 *
 * โทเค็นของระบบนี้เดินทางใน Authorization header ไม่ใช่คุกกี้ คำขอที่หน้าตาเหมือนกัน
 * ของผู้ใช้คนละคนจึงมีคีย์แคชเดียวกัน ปัญหาจึงร้ายแรงกว่าระบบที่ใช้คุกกี้เสียอีก
 */

describe('F24-B นโยบายแคชของ service worker', { concurrency: 1 }, () => {
  /** เปลือกแอปคือโค้ดกับสไตล์ ไม่มีข้อมูลของใครอยู่ข้างใน */
  test('อนุญาตเฉพาะไฟล์เปลือกแอป', () => {
    for (const url of [
      '/assets/index-abc123.js',
      '/assets/index-abc123.css',
      '/assets/kodchasan-thai-400-normal-xyz.woff2',
      '/favicon.svg',
      '/manifest.webmanifest',
      '/index.html',
      '/',
      '/pwa-192x192.png',
      '/s2-nas-logo.png',
    ]) {
      assert.equal(isCacheableShellAsset(url), true, `ควรเก็บได้: ${url}`);
    }
  });

  /**
   * รายการนี้คือสิ่งที่เกิดขึ้นจริงหลังผู้ใช้เปิดดูไฟล์ ดาวน์โหลด ค้นหา
   * ถามผู้ช่วยเอกสาร และขอคำแนะนำการจัดเก็บ
   */
  test('ปฏิเสธทุกอย่างที่มีข้อมูลของผู้ใช้', () => {
    const afterRealUsage = [
      '/api/resources/abc-123',
      '/api/resources/abc-123/download',
      '/api/resources/abc-123/content',
      '/api/resources/abc-123/thumbnail',
      '/api/search?q=ใบกำกับภาษี',
      '/api/assistant/threads/t1/messages',
      '/api/smart-filing/suggestions/abc-123',
      '/api/ocr/abc-123/text',
      '/api/audit/events',
      '/api/auth/me',
      '/s/public-share-token',
    ];
    for (const url of afterRealUsage) {
      assert.equal(isCacheableShellAsset(url), false, `ห้ามเก็บ: ${url}`);
      assert.equal(mustBypassCache(url), true, `ต้องข้ามแคช: ${url}`);
    }
  });

  /** สิ่งที่ควรเห็นหลังใช้งานครบทุกฟีเจอร์: มีแต่เปลือกแอป */
  test('การตรวจ Cache Storage ที่สะอาดต้องไม่พบความผิด', () => {
    const cacheStorageContents = [
      '/index.html',
      '/assets/index-a1.js',
      '/assets/vendor-react-b2.js',
      '/assets/index-c3.css',
      '/assets/kodchasan-thai-400-normal-d4.woff2',
      '/pwa-512x512.png',
    ];
    assert.deepEqual(findForbiddenCacheEntries(cacheStorageContents), []);
  });

  /** และถ้ามีอะไรหลุดเข้าไป ต้องบอกได้ว่าอันไหนและเพราะอะไร */
  test('การตรวจที่พบเอกสารต้องรายงานพร้อมเหตุผลที่อ่านเข้าใจได้', () => {
    const leaked = [
      '/assets/index-a1.js',
      'https://nas.example.invalid/api/resources/r1/download',
      'https://nas.example.invalid/api/search?q=เงินเดือน',
    ];
    const violations = findForbiddenCacheEntries(leaked);
    assert.equal(violations.length, 2, 'ต้องพบสองรายการ ไม่ใช่ไฟล์โค้ด');
    assert.ok(violations.every((v) => v.reason.length > 0), 'ทุกรายการต้องมีเหตุผล');
    assert.ok(violations.some((v) => v.url.includes('download')));
    assert.ok(violations.some((v) => v.url.includes('search')));
  });

  /** URL เต็มรูปแบบต้องถูกตัดสินเหมือนเส้นทางล้วน ๆ */
  test('ตัดสินจากเส้นทาง ไม่ใช่จากรูปแบบการเขียน URL', () => {
    assert.equal(isCacheableShellAsset('https://nas.example.invalid/assets/app-1.js'), true);
    assert.equal(isCacheableShellAsset('https://nas.example.invalid/api/resources/1'), false);
  });

  /**
   * ปลายทางที่ยังไม่มีในวันนี้ต้องถูกปฏิเสธไว้ก่อน
   *
   * นี่คือเหตุผลที่ใช้รายการอนุญาตแทนรายการห้าม ฟีเจอร์ใหม่ที่เพิ่มมาทีหลัง
   * จะไม่หลุดลงแคชเงียบ ๆ เพียงเพราะไม่มีใครนึกถึงตอนเขียนกฎ
   */
  test('ปลายทางที่ยังไม่รู้จักถูกปฏิเสธโดยปริยาย', () => {
    assert.equal(isCacheableShellAsset('/api/feature-that-does-not-exist-yet'), false);
    assert.equal(isCacheableShellAsset('/some-future-route/data.json'), false);
  });

  /** ชุดอักษรที่ไม่ได้ใช้ไม่ควรกินที่บนเครื่องผู้ใช้ */
  test('ฟอนต์ชุดเวียดนามไม่ถูกเก็บ', () => {
    assert.equal(isCacheableShellAsset('/assets/kodchasan-vietnamese-400-normal-x.woff2'), false);
    assert.equal(isCacheableShellAsset('/assets/kodchasan-thai-400-normal-x.woff2'), true);
  });
});
