/**
 * ไอคอนของแบรนด์ต้องมาจากต้นฉบับเดียว และต้องมีอยู่จริงทุกไฟล์ที่ประกาศไว้
 *
 * ปัญหาที่ชุดนี้กัน: ไฟล์ไอคอนถูกสร้างนอกสายพาน แล้ววันหนึ่งมีคนเปลี่ยนโลโก้
 * ที่ต้นฉบับ รันสคริปต์ใหม่ แต่ไฟล์ที่ทำมือยังค้างเป็นของเก่า - แท็บเบราว์เซอร์
 * ขึ้นไอคอนหนึ่ง หน้าจอติดตั้งขึ้นอีกไอคอนหนึ่ง โดยไม่มีอะไรฟ้อง
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { S2_NAS_MANIFEST } from './pwa-manifest.ts';

const frontend = new URL('../../', import.meta.url);
const generatorFile = readFileSync(new URL('scripts/generate-pwa-icons.mjs', frontend), 'utf8');

/**
 * เอาคอมเมนต์ออกก่อนตรวจ
 *
 * คำอธิบายในสคริปต์พูดถึงไฟล์ที่ "ต้องไม่" ถูกใช้อยู่ด้วย ถ้าค้นทั้งไฟล์ตรง ๆ
 * คอมเมนต์ที่เตือนเรื่องนั้นจะกลายเป็นตัวทำให้ชุดทดสอบแดงเสียเอง
 * สิ่งที่อยากตรวจคือโค้ดที่ทำงานจริง ไม่ใช่ข้อความที่มนุษย์เขียนอธิบาย
 */
const generator = generatorFile
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*/g, '');
const indexHtml = readFileSync(new URL('index.html', frontend), 'utf8');
const publicFile = (name: string) => new URL(`public/${name}`, frontend);

describe('ต้นฉบับของไอคอนมีแหล่งเดียว', () => {
  test('สคริปต์ชี้ไปที่ s2-nas-icon.png และไม่มีต้นฉบับที่สอง', () => {
    assert.ok(generator.includes("'s2-nas-icon.png'"), 'สายพานต้องอ่านจากต้นฉบับใหม่');
    assert.equal(
      generator.includes('s2-nas-logo-source.png'),
      false,
      'ยังมีต้นฉบับเก่าค้างอยู่ในสายพาน - ไอคอนจะมาจากสองที่',
    );
  });

  test('ต้นฉบับความละเอียดสูงยังอยู่ในที่เก็บ', () => {
    assert.ok(existsSync(new URL('assets-src/s2-nas-icon.png', frontend)));
  });

  /**
   * โลโก้บนหัวจอเป็นงานออกแบบคนละชิ้น ไม่ใช่ไอคอนแอปย่อส่วน
   *
   * เคยพลาดมาแล้วตอนรวมสองอย่างนี้เข้าด้วยกัน: หัวจอเปลี่ยนไปเป็นไอคอนแอป
   * ทั้งที่งานที่ทำคือเรื่อง favicon ล้วน ๆ ข้อนี้กันไม่ให้สายพานไอคอนเขียนทับ
   * ไฟล์ของหัวจออีก และกันไม่ให้ต้นฉบับของหัวจอไหลกลับเข้ามาเป็นต้นทางของ favicon
   */
  test('สายพานไอคอนไม่เขียนทับโลโก้บนหัวจอ', () => {
    assert.equal(
      generator.includes("'s2-nas-logo.png'"),
      false,
      'สคริปต์ไอคอนต้องไม่สร้าง s2-nas-logo.png - หัวจอมีสินทรัพย์ของตัวเอง',
    );
    assert.ok(existsSync(publicFile('s2-nas-logo.png')), 'โลโก้หัวจอต้องยังมีอยู่');
  });
});

describe('ไฟล์ไอคอนที่ประกาศไว้มีครบ', () => {
  test('ทุกไอคอนใน manifest มีไฟล์จริง', () => {
    for (const icon of S2_NAS_MANIFEST.icons) {
      assert.ok(existsSync(publicFile(icon.src.slice(1))), `ขาดไฟล์ ${icon.src}`);
    }
  });

  test('ทุก <link rel=icon> ใน index.html มีไฟล์จริง', () => {
    const hrefs = [...indexHtml.matchAll(/rel="(?:icon|apple-touch-icon)"[^>]*href="\/([^"]+)"/g)]
      .map((match) => match[1]);
    assert.ok(hrefs.length >= 4, 'ต้องประกาศไอคอนไว้หลายขนาด');
    for (const href of hrefs) {
      assert.ok(existsSync(publicFile(href)), `ขาดไฟล์ /${href}`);
    }
  });

  /**
   * เบราว์เซอร์ยิงขอ /favicon.ico เองโดยไม่สนใจ <link> และทางลัดบนเดสก์ท็อป
   * ของ Windows ก็อ่านจากไฟล์นี้ จึงต้องมีแม้จะไม่ได้ประกาศไว้ใน HTML
   */
  test('favicon.ico มีอยู่ และเป็นไฟล์ไอคอนที่มีหลายขนาดซ้อนกัน', () => {
    const ico = readFileSync(publicFile('favicon.ico'));
    assert.equal(ico.readUInt16LE(0), 0, 'ไบต์สงวนต้องเป็นศูนย์');
    assert.equal(ico.readUInt16LE(2), 1, 'ต้องเป็นชนิดไอคอน');
    assert.ok(ico.readUInt16LE(4) >= 3, 'ต้องมีอย่างน้อยสามขนาดในไฟล์เดียว');
  });

  test('favicon.svg เป็นไอคอนเดียวกับ PNG ไม่ใช่รูปที่วาดแยก', () => {
    const svg = readFileSync(publicFile('favicon.svg'), 'utf8');
    assert.ok(svg.includes('data:image/png;base64,'), 'ต้องห่อภาพจากต้นฉบับเดียวกัน');
    assert.equal(/<text/.test(svg), false, 'ห้ามมีตัวอักษรที่วาดเองในไฟล์นี้');
  });
});
