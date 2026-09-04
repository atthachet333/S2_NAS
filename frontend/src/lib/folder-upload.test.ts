import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  describePlan,
  groupByDirectory,
  isSafeSegment,
  planFolderUpload,
  relativePathOf,
} from './folder-upload.ts';
import { EMPTY_WORKSPACE_ACTIONS } from './interaction-policy.ts';

/** ไฟล์จำลองพร้อม webkitRelativePath เหมือนที่เบราว์เซอร์ส่งมาจริง */
const fileAt = (relativePath: string): File => {
  const name = relativePath.split('/').at(-1) ?? relativePath;
  const file = new File(['content'], name);
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
};

describe('ความปลอดภัยของชื่อในเส้นทาง', () => {
  test('ชื่อปกติและชื่อภาษาไทยใช้ได้', () => {
    for (const name of ['Logos', 'logo.png', 'คู่มือบริษัท', 'เอกสาร ภาษี', 'invoice.docx', 'a']) {
      assert.equal(isSafeSegment(name), true, `${name} ต้องใช้ได้`);
    }
  });

  test('ชื่อที่อันตรายหรือกำกวมถูกปฏิเสธ', () => {
    for (const name of ['', '   ', '.', '..', 'a/b', 'a\b', 'CON', 'nul.txt', 'a\u0000b', 'x'.repeat(192)]) {
      assert.equal(isSafeSegment(name), false, `${name} ต้องถูกปฏิเสธ`);
    }
  });
});

describe('การวางแผนอัปโหลดโฟลเดอร์', () => {
  test('รักษาลำดับชั้นของโฟลเดอร์ต้นทางไว้ครบ', () => {
    const plan = planFolderUpload([
      fileAt('Company Assets/Logos/logo.png'),
      fileAt('Company Assets/Templates/invoice.docx'),
    ]);

    assert.equal(plan.rejected.length, 0);
    assert.equal(plan.rootName, 'Company Assets');
    assert.deepEqual(plan.directories, [
      ['Company Assets'],
      ['Company Assets', 'Logos'],
      ['Company Assets', 'Templates'],
    ]);
    assert.deepEqual(plan.files.map((item) => item.directory.join('/')), [
      'Company Assets/Logos',
      'Company Assets/Templates',
    ]);
  });

  test('โฟลเดอร์แม่ถูกสร้างก่อนลูกเสมอ', () => {
    const plan = planFolderUpload([fileAt('a/b/c/deep.txt')]);
    const depths = plan.directories.map((branch) => branch.length);
    assert.deepEqual(depths, [...depths].sort((x, y) => x - y), 'ต้องเรียงจากตื้นไปลึก');
    assert.deepEqual(plan.directories[0], ['a']);
  });

  test('ชื่อภาษาไทยทั้งโฟลเดอร์และไฟล์ผ่านได้', () => {
    const plan = planFolderUpload([fileAt('คู่มือบริษัท/ฝ่ายบัญชี/ใบกำกับภาษี.pdf')]);
    assert.equal(plan.rejected.length, 0);
    assert.deepEqual(plan.directories, [['คู่มือบริษัท'], ['คู่มือบริษัท', 'ฝ่ายบัญชี']]);
    assert.equal(plan.files[0]?.file.name, 'ใบกำกับภาษี.pdf');
  });

  test('การไต่ออกนอกปลายทางถูกปฏิเสธ ไม่ใช่ถูกแก้ให้', () => {
    const plan = planFolderUpload([
      fileAt('../escape.txt'),
      fileAt('assets/../../secrets.txt'),
      fileAt('good/file.txt'),
    ]);
    assert.equal(plan.files.length, 1, 'เหลือเฉพาะไฟล์ที่ปลอดภัย');
    assert.equal(plan.files[0]?.directory.join('/'), 'good');
    assert.equal(plan.rejected.length, 2);
  });

  test('เส้นทางแบบเต็มถูกปฏิเสธ', () => {
    const plan = planFolderUpload([
      fileAt('C:/Windows/System32/evil.dll'),
      fileAt('/etc/passwd'),
    ]);
    assert.equal(plan.files.length, 0);
    assert.equal(plan.rejected.length, 2);
    for (const item of plan.rejected) assert.match(item.reason, /เส้นทางแบบเต็ม/);
  });

  test('ไฟล์เดี่ยวที่ไม่มีเส้นทางถือว่าอยู่ที่ปลายทางโดยตรง', () => {
    const plan = planFolderUpload([new File(['x'], 'single.txt')]);
    assert.equal(plan.files.length, 1);
    assert.deepEqual(plan.files[0]?.directory, []);
    assert.deepEqual(plan.directories, []);
  });

  test('โฟลเดอร์ที่ไม่มีไฟล์ข้างในไม่ถูกนับ', () => {
    assert.deepEqual(planFolderUpload([]).directories, []);
  });

  test('เส้นทางเดียวกันไม่ถูกลงทะเบียนซ้ำ', () => {
    const plan = planFolderUpload([
      fileAt('shared/a.txt'),
      fileAt('shared/b.txt'),
      fileAt('shared/c.txt'),
    ]);
    assert.deepEqual(plan.directories, [['shared']]);
    assert.equal(plan.files.length, 3);
  });

  test('จัดกลุ่มไฟล์ตามโฟลเดอร์ปลายทาง', () => {
    const plan = planFolderUpload([
      fileAt('root/one.txt'),
      fileAt('root/sub/two.txt'),
      fileAt('root/sub/three.txt'),
    ]);
    const groups = groupByDirectory(plan.files);
    assert.equal(groups.get('root')?.length, 1);
    assert.equal(groups.get('root/sub')?.length, 2);
  });

  test('ข้อความสรุปบอกจำนวนจริงและไม่ซ่อนของที่ถูกข้าม', () => {
    const plan = planFolderUpload([fileAt('ok/a.txt'), fileAt('../bad.txt')]);
    const summary = describePlan(plan);
    assert.match(summary, /1 ไฟล์/);
    assert.match(summary, /ข้าม 1/);
  });

  test('relativePathOf ถอยไปใช้ชื่อไฟล์เมื่อเบราว์เซอร์ไม่ส่งเส้นทางมา', () => {
    assert.equal(relativePathOf(new File(['x'], 'plain.txt')), 'plain.txt');
    assert.equal(relativePathOf(fileAt('dir/nested.txt')), 'dir/nested.txt');
  });
});

describe('เมนูสร้างทรัพยากรในพื้นที่ว่าง', () => {
  test('ทุกการกระทำที่ใช้ได้จริงต้องไม่ถูกปิดไว้', () => {
    for (const action of EMPTY_WORKSPACE_ACTIONS) {
      assert.equal(action.disabled, false, `${action.id} ทำงานได้แล้ว ต้องไม่ถูกปิด`);
    }
  });

  test('ครบทั้งเจ็ดชนิดที่ต้องสร้างได้', () => {
    const ids = EMPTY_WORKSPACE_ACTIONS.map((action) => action.id);
    for (const id of ['create-folder', 'upload-here', 'upload-folder', 'google-sheet', 'google-doc', 'google-drive', 'web-link']) {
      assert.ok(ids.includes(id as (typeof ids)[number]), `ต้องมี ${id}`);
    }
  });
});
