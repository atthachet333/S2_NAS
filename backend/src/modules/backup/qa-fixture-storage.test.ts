import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * ของทดสอบต้องไม่สร้างแถวที่ชี้ไปยังไฟล์ที่ไม่มีอยู่ (F20/F21)
 *
 * **ที่มา:** สคริปต์ QA เคยสร้างแถว ResourceVersion พร้อม storageKey ที่แต่งขึ้นเอง
 * โดยไม่เขียนไฟล์จริง ถ้าสคริปต์ถูกขัดจังหวะก่อนเก็บกวาด แถวกำพร้าจะค้างอยู่
 * แล้วการตรวจความครบถ้วนของชุดสำรองจะรายงาน BACKUP_STORAGE_INCOMPLETE ในภายหลัง
 * ครั้งหนึ่งเคยทำให้ชุดทดสอบล้ม 43 รายการ ทั้งที่โค้ดจริงไม่มีอะไรผิดเลย
 *
 * ชุดนี้เป็นด่านกันไม่ให้รูปแบบเดิมกลับมาอีก ตรวจที่ตัวซอร์สโดยตรงเพราะการรอให้
 * ชุดสำรองจับได้นั้นสายเกินไป กว่าจะเห็นอาการก็เป็นความล้มเหลวที่สืบสาเหตุยากแล้ว
 *
 * ตรวจเฉพาะเครื่องมือ QA ไม่แตะโค้ดจริง เพราะการอัปโหลดจริงเขียนไฟล์ผ่าน
 * storageProvider อยู่แล้วโดยธรรมชาติ
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, '../../..');

/** ไฟล์เครื่องมือ QA ทั้งหมดที่อาจสร้างทรัพยากรปลอมขึ้นมา */
async function qaToolingFiles(): Promise<string[]> {
  const files: string[] = [];
  const scriptsDir = path.join(backendRoot, 'scripts');
  for (const entry of await readdir(scriptsDir)) {
    if (entry.endsWith('.ts')) files.push(path.join(scriptsDir, entry));
  }
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.test.ts')) files.push(full);
    }
  };
  await walk(path.join(backendRoot, 'src'));
  return files;
}

/** คืนเนื้อในของทุกการเรียกสร้างเวอร์ชัน เพื่อตรวจว่า storageKey มาจากไหน */
function versionCreationBodies(source: string): string[] {
  return [...source.matchAll(/resourceVersion\.create(?:Many)?\(([\s\S]{0,800}?)\}\s*\)/gu)]
    .map((match) => match[1]!);
}

describe('QA tooling cannot create orphan storage references', { concurrency: 1 }, () => {
  /**
   * storageKey ต้องมาจากตัวแปรที่ได้จากการเขียนไฟล์จริงเสมอ
   *
   * ค่าที่เขียนตรง ๆ เป็นสตริงหรือ template แปลว่าไม่มีใครเขียนไฟล์ให้ ซึ่งคือรูปแบบ
   * ที่เคยพังมาแล้ว การเทียบที่ตัวรูปแบบจึงจับได้ก่อนที่จะมีใครรันมัน
   */
  test('no QA fixture assigns a hand-written storageKey', async () => {
    const offenders: string[] = [];
    for (const file of await qaToolingFiles()) {
      const source = await readFile(file, 'utf8');
      for (const body of versionCreationBodies(source)) {
        if (/storageKey:\s*[`'"]/u.test(body)) {
          offenders.push(path.relative(backendRoot, file));
        }
      }
    }
    assert.deepEqual(offenders, [],
      `ของทดสอบเหล่านี้ตั้ง storageKey เองโดยไม่เขียนไฟล์จริง: ${offenders.join(', ')}`);
  });

  /**
   * ไฟล์ที่สร้างทรัพยากรต้องทั้งเขียนไฟล์จริงและเก็บกวาดไฟล์นั้น
   *
   * ไม่ผูกกับตัวช่วยตัวใดตัวหนึ่ง เพราะของทดสอบที่มีอยู่ก่อนเขียนและลบไฟล์เองด้วย fs
   * ซึ่งถูกต้องเท่ากัน สิ่งที่ต้องบังคับคือคุณสมบัติ ไม่ใช่ชื่อฟังก์ชันที่ใช้
   *
   * ขาดการเขียนไฟล์ = แถวกำพร้า ซึ่งทำให้ชุดสำรองล้ม
   * ขาดการลบไฟล์ = ไฟล์กำพร้า ซึ่งสะสมขยะและทำให้ตัวเลขพื้นที่ผิดไปจากจริง
   */
  test('every QA fixture that creates resources writes and removes real files', async () => {
    const writesFile = /writeQaVersionFile|QaFixtureScope|uploadFile|writeFile\(|createWriteStream/u;
    const removesFile = /removeResourceDirectory|QaFixtureScope|rm\(|unlink\(|deleteStoredFile/u;
    const offenders: string[] = [];
    for (const file of await qaToolingFiles()) {
      const source = await readFile(file, 'utf8');
      if (!/resourceVersion\.create(?:Many)?\(/u.test(source)) continue;
      const problems: string[] = [];
      if (!writesFile.test(source)) problems.push('ไม่เขียนไฟล์จริง');
      if (!removesFile.test(source)) problems.push('ไม่ลบไฟล์ตอนเก็บกวาด');
      if (problems.length) offenders.push(`${path.relative(backendRoot, file)} (${problems.join(', ')})`);
    }
    assert.deepEqual(offenders, [], `ของทดสอบเหล่านี้จัดการไฟล์ไม่ครบ: ${offenders.join(' | ')}`);
  });

  /** ยืนยันเจาะจงว่าสคริปต์วัดประสิทธิภาพ F20 ถูกแก้แล้วจริง */
  test('the F20 performance fixture writes a real file and cleans it up', async () => {
    const source = await readFile(path.join(backendRoot, 'scripts', 'f20-performance.ts'), 'utf8');
    assert.match(source, /writeQaVersionFile\(/u, 'ต้องเขียนไฟล์จริงผ่านตัวช่วยร่วม');
    assert.match(source, /removeResourceDirectory\(/u, 'ต้องลบไฟล์ตอนเก็บกวาด');
    assert.doesNotMatch(source, /storageKey:\s*`qa\//u, 'storageKey แบบเดิมต้องไม่เหลืออยู่');
    // การเก็บกวาดต้องอยู่ใน finally เพื่อให้ทำงานแม้การวัดจะล้มเหลวกลางคัน
    const finallyBlock = /\}\s*finally\s*\{([\s\S]*?)\n\s{2}\}/u.exec(source)?.[1] ?? '';
    assert.match(finallyBlock, /removeResourceDirectory\(/u, 'การลบไฟล์ต้องอยู่ใน finally');
  });
});
