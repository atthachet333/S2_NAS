import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  NAVIGATION_DENYLIST, PRECACHE_GLOBS, PRECACHE_IGNORES, S2_NAS_MANIFEST,
} from './pwa-manifest.ts';

/**
 * เงื่อนไขการติดตั้งของ S2 NAS (F24-B)
 *
 * ชุดนี้ตรวจสิ่งที่ทำให้เบราว์เซอร์ยอมให้ติดตั้งแอป ถ้าขาดอย่างใดอย่างหนึ่ง
 * ปุ่มติดตั้งจะไม่ปรากฏโดยไม่มีข้อความบอกเหตุผล ซึ่งเป็นอาการที่ไล่หาสาเหตุยากมาก
 */
describe('F24-B เงื่อนไขการติดตั้งแอป', { concurrency: 1 }, () => {
  test('มีค่าครบตามที่เบราว์เซอร์ต้องการ', () => {
    assert.equal(S2_NAS_MANIFEST.name, 'S2 NAS');
    assert.equal(S2_NAS_MANIFEST.short_name, 'S2 NAS');
    assert.equal(S2_NAS_MANIFEST.display, 'standalone');
    assert.equal(S2_NAS_MANIFEST.start_url, '/');
    assert.equal(S2_NAS_MANIFEST.scope, '/');
  });

  /** Chromium ต้องการไอคอน 192 และ 512 เป็นอย่างน้อย */
  test('มีไอคอนขนาดที่จำเป็นครบ', () => {
    const sizes = S2_NAS_MANIFEST.icons.map((icon) => icon.sizes);
    assert.ok(sizes.includes('192x192'), 'ขาดไอคอน 192x192');
    assert.ok(sizes.includes('512x512'), 'ขาดไอคอน 512x512');
    assert.ok(S2_NAS_MANIFEST.icons.every((icon) => icon.src.startsWith('/')),
      'เส้นทางไอคอนต้องเป็นแบบอิงราก มิฉะนั้นจะผิดเมื่อเปิดจากเส้นทางย่อย');
  });

  /**
   * ไอคอน maskable ต้องมีแยกต่างหาก
   *
   * ถ้าประกาศไอคอนเดียวเป็นทั้ง any และ maskable ระบบปฏิบัติการจะครอบขอบของภาพทิ้ง
   * ทำให้โลโก้ถูกตัด ไอคอนสองแบบนี้จึงต้องเป็นคนละไฟล์ที่เผื่อขอบมาต่างกัน
   */
  test('ไอคอน maskable แยกไฟล์จากไอคอนปกติ', () => {
    const maskable = S2_NAS_MANIFEST.icons.filter((icon) => icon.purpose === 'maskable');
    const plain = S2_NAS_MANIFEST.icons.filter((icon) => icon.purpose === 'any');
    assert.equal(maskable.length, 1);
    assert.ok(plain.length >= 2);
    assert.ok(!plain.some((icon) => icon.src === maskable[0].src),
      'ไอคอน maskable ต้องไม่ใช้ไฟล์เดียวกับไอคอนปกติ');
  });

  /** ใช้ชุดสีเดิมของระบบ ไม่สร้างแบรนด์ชุดที่สอง */
  test('สีมาจากโทเค็นธีมที่ใช้อยู่แล้ว', () => {
    assert.equal(S2_NAS_MANIFEST.theme_color, '#ffffff', 'ต้องตรงกับ --s2-header ของธีมสว่าง');
    assert.equal(S2_NAS_MANIFEST.background_color, '#edf1f7', 'ต้องตรงกับ --s2-bg ของธีมสว่าง');
  });

  test('ประกาศภาษาไทยเป็นภาษาหลัก', () => {
    assert.equal(S2_NAS_MANIFEST.lang, 'th');
  });
});

describe('F24-B ขอบเขตของการเก็บล่วงหน้า', { concurrency: 1 }, () => {
  /** เก็บเฉพาะเปลือกแอป - ไม่มีรูปแบบใดที่กวาดเอาข้อมูลผู้ใช้เข้ามาได้ */
  test('รูปแบบที่เก็บล่วงหน้ามีแต่ไฟล์ของแอป', () => {
    const globs = [...PRECACHE_GLOBS];
    assert.ok(globs.every((glob) => !glob.includes('api')), 'ต้องไม่มีรูปแบบใดแตะ api');
    assert.ok(globs.some((glob) => glob.includes('woff2')), 'ต้องเก็บฟอนต์ woff2');
    assert.ok(!globs.some((glob) => /\bwoff\b(?!2)/.test(glob)),
      'ต้องไม่เก็บฟอนต์ woff รุ่นเก่า เพราะทุกเบราว์เซอร์ที่รองรับได้ใช้ woff2 อยู่แล้ว');
  });

  test('ข้ามชุดอักษรที่ไม่ได้ใช้', () => {
    assert.ok([...PRECACHE_IGNORES].some((pattern) => pattern.includes('vietnamese')));
  });

  /**
   * คำขอไปยัง API ต้องไม่ถูกตอบด้วยหน้า HTML
   *
   * ถ้าตกไปใช้เปลือกแอปตอนออฟไลน์ ผู้เรียกจะได้ HTML แล้วพยายามอ่านเป็น JSON
   * กลายเป็นข้อผิดพลาดที่ชี้ไปผิดทางทั้งหมด แทนที่จะรู้ว่าเครือข่ายหลุด
   */
  test('เส้นทางข้อมูลไม่ตกไปใช้เปลือกแอป', () => {
    const denied = [...NAVIGATION_DENYLIST];
    assert.ok(denied.some((pattern) => pattern.test('/api/resources/1')));
    assert.ok(denied.some((pattern) => pattern.test('/s/some-token')));
    assert.ok(!denied.some((pattern) => pattern.test('/files/folder-1')),
      'เส้นทางของหน้าจอปกติต้องยังใช้เปลือกแอปได้ตอนออฟไลน์');
  });
});
