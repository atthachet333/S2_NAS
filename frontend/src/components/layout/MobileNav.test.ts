import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { isUploadCapableRoute } from './MobileNav.tsx';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * การนำทางและการแตะบนมือถือ (F24-C)
 *
 * ชุดนี้ผสมสองวิธีตรวจโดยตั้งใจ: ตรรกะที่เรียกได้ตรง ๆ ตรวจด้วยการเรียกจริง
 * ส่วนกฎที่เป็นเรื่องของชั้นการแสดงผลล้วน ๆ ตรวจด้วยการอ่านซอร์ส เพราะชุดทดสอบนี้
 * ไม่มี DOM จริงให้วัดขนาดหรือสถานะการชี้เมาส์ได้ การอ่านซอร์สจึงเป็นหลักฐานที่ตรงที่สุด
 * ที่ได้โดยไม่ต้องลาก jsdom เข้ามาทั้งชุดเพื่อกฎไม่กี่ข้อ
 */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx$/.test(entry.name) ? [full] : [];
  });
}

describe('F24-C ปลายทางของการอัปโหลดบนมือถือ', { concurrency: 1 }, () => {
  /** การอัปโหลดต้องรู้โฟลเดอร์ปลายทาง ซึ่งมีเฉพาะในหน้าไดร์ฟ */
  test('รู้ว่าหน้าไหนอัปโหลดเข้าโฟลเดอร์ปัจจุบันได้', () => {
    assert.equal(isUploadCapableRoute('/files'), true);
    assert.equal(isUploadCapableRoute('/files/abc-123'), true);
    assert.equal(isUploadCapableRoute('/system-drive'), true);
    assert.equal(isUploadCapableRoute('/system-drive/xyz'), true);
  });

  test('หน้าที่ไม่มีโฟลเดอร์ปลายทางต้องถูกพาไปที่ไดร์ฟก่อน', () => {
    for (const route of ['/search', '/dashboard', '/recent', '/favorites', '/trash', '/shared']) {
      assert.equal(isUploadCapableRoute(route), false, `${route} ไม่มีโฟลเดอร์ปลายทาง`);
    }
  });
});

describe('F24-C ปุ่มค้นหาบนมือถือ', { concurrency: 1 }, () => {
  /**
   * ปุ่มนี้เคยไม่มีตัวจัดการเหตุการณ์เลย
   *
   * ผู้ใช้บนมือถือกดแล้วไม่มีอะไรเกิดขึ้น ซึ่งเป็นข้อบกพร่องที่เงียบที่สุดแบบหนึ่ง
   * เพราะไม่มีข้อความผิดพลาดให้ใครสังเกตเห็น
   */
  test('ปุ่มค้นหาของ TopHeader มีปลายทางจริง', () => {
    const source = fs.readFileSync(path.join(srcDir, 'components', 'layout', 'TopHeader.tsx'), 'utf8');
    const searchButton = source.slice(source.indexOf('aria-label="ค้นหา"') - 700, source.indexOf('aria-label="ค้นหา"'));
    assert.ok(searchButton.includes('onClick'), 'ปุ่มค้นหาต้องมี onClick');
    assert.ok(searchButton.includes("navigate('/search')"), 'ต้องพาไปหน้าค้นหา');
  });
});

describe('F24-C การกระทำต้องไม่ขึ้นกับการชี้เมาส์', { concurrency: 1 }, () => {
  /**
   * นิ้วไม่มีสถานะ "ชี้"
   *
   * รูปแบบ opacity-0 + group-hover:opacity-100 ทำให้ปุ่มไม่มีอยู่จริงบนจอสัมผัส
   * ถ้าจะซ่อนตอนไม่ได้ชี้ ต้องซ่อนเฉพาะจอกว้างที่มีเมาส์เท่านั้น
   */
  test('ไม่มีคอมโพเนนต์ใดซ่อนปุ่มด้วย opacity-0 โดยไม่จำกัดเฉพาะจอกว้าง', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const [index, line] of content.split('\n').entries()) {
        // opacity-0 ที่ไม่มีคำนำหน้า breakpoint คือการซ่อนบนทุกขนาดจอ รวมถึงมือถือ
        if (/(?<![a-z:])opacity-0(?![0-9])/.test(line) && !/md:opacity-0|lg:opacity-0|sm:opacity-0/.test(line)) {
          offenders.push(`${path.relative(srcDir, file)}:${index + 1}`);
        }
      }
    }
    assert.deepEqual(offenders, [], 'ปุ่มเหล่านี้จะมองไม่เห็นบนจอสัมผัส');
  });

  /** และการเผยปุ่มตอนชี้เมาส์ ต้องผูกกับจอกว้างเช่นกัน */
  test('การเผยปุ่มตอนชี้เมาส์จำกัดอยู่ที่จอกว้าง', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const [index, line] of content.split('\n').entries()) {
        if (/(?<![a-z:])group-hover:opacity-100/.test(line)) {
          offenders.push(`${path.relative(srcDir, file)}:${index + 1}`);
        }
      }
    }
    assert.deepEqual(offenders, [], 'ต้องเขียนเป็น md:group-hover:opacity-100');
  });
});
