/**
 * F26-C/D - กติกาของหน้าจองานฝั่งผู้รับงาน
 *
 * ตรวจที่ "ข้อตกลงระหว่างหน้าจอกับเซิร์ฟเวอร์" ไม่ใช่ตรวจว่าปุ่มอยู่ตรงไหน
 * ข้อที่สำคัญที่สุดคือหน้าจอต้องไม่คำนวณสถานะเองเลย - ถ้ามันคำนวณเอง นาฬิกาของเครื่อง
 * ผู้ใช้ที่เดินผิดจะทำให้เห็นสถานะคนละอย่างกับที่ระบบบังคับใช้จริง
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { WORKFLOW_STATUS_LABEL, type WorkflowStatus } from '../../lib/api.ts';

const listSource = readFileSync(new URL('./PortalWorkflowsPage.tsx', import.meta.url), 'utf8');
const detailSource = readFileSync(new URL('./PortalWorkflowDetailPage.tsx', import.meta.url), 'utf8');
const shellSource = readFileSync(new URL('../../components/portal/PortalShell.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../../lib/api.ts', import.meta.url), 'utf8');

const ALL_STATUSES: WorkflowStatus[] = [
  'OPEN', 'SUBMITTED', 'UNDER_REVIEW', 'REVISION_REQUESTED',
  'APPROVED', 'REJECTED', 'REVOKED', 'EXPIRED',
];

describe('สถานะของงานบนหน้าจอ', () => {
  test('ทุกสถานะที่เซิร์ฟเวอร์ส่งมาได้ ต้องมีคำไทยรองรับครบ', () => {
    for (const status of ALL_STATUSES) {
      const label = WORKFLOW_STATUS_LABEL[status];
      assert.ok(label && label.length > 0, `${status} ไม่มีป้ายภาษาไทย`);
    }
    // ไม่มีสถานะส่วนเกินที่หน้าจอคิดขึ้นเอง
    assert.deepEqual(Object.keys(WORKFLOW_STATUS_LABEL).sort(), [...ALL_STATUSES].sort());
  });

  test('ทุกสถานะมีโทนสีของตัวเอง และไม่พึ่งสีอย่างเดียว', () => {
    for (const status of ALL_STATUSES) {
      assert.ok(listSource.includes(`${status}:`), `${status} ไม่มีโทนสีกำหนดไว้`);
    }
    // ป้ายแสดงข้อความเสมอ ไม่ใช่แค่จุดสี
    assert.ok(listSource.includes('WORKFLOW_STATUS_LABEL[status]'));
  });

  test('หน้าจอไม่คำนวณการหมดอายุเอง - สถานะมาจากเซิร์ฟเวอร์เท่านั้น', () => {
    for (const source of [listSource, detailSource]) {
      assert.equal(/expiresAt\s*[<>]/.test(source), false, 'พบการเทียบเวลาหมดอายุบนหน้าจอ');
      assert.equal(source.includes('Date.now()'), false, 'พบการอ่านเวลาปัจจุบันเพื่อตัดสินสถานะ');
      assert.equal(/status\s*===\s*'EXPIRED'\s*\?/.test(source), false, 'พบการตีความสถานะแทนเซิร์ฟเวอร์');
    }
  });

  test('ปุ่มส่งไฟล์ตาม canSubmit ของเซิร์ฟเวอร์ ไม่ใช่ตีความสถานะเอง', () => {
    assert.ok(detailSource.includes('data.canSubmit'), 'ต้องใช้ canSubmit จากเซิร์ฟเวอร์');
    assert.equal(
      /canSubmit\s*=\s*.*status/.test(detailSource), false,
      'หน้าจอต้องไม่คำนวณ canSubmit เอง',
    );
  });
});

describe('ขอบเขตและความปลอดภัยของหน้าจอ', () => {
  test('ไม่มีการนำทางไปส่วนอื่นของ NAS จากหน้างาน', () => {
    for (const path of ['/dashboard', '/search', '/admin', '/files']) {
      assert.equal(listSource.includes(path), false, `พบลิงก์ออกนอกขอบเขต: ${path}`);
      assert.equal(detailSource.includes(path), false, `พบลิงก์ออกนอกขอบเขต: ${path}`);
    }
  });

  test('ตัวเรียก API ไม่เคยส่งรหัสผู้ใช้หรือปลายทางไปเอง', () => {
    const block = apiSource.slice(apiSource.indexOf('export const portalWorkflowApi'));
    const scoped = block.slice(0, block.indexOf('/** ชุดค้นหาที่บันทึกไว้'));
    const forbidden = ['userId', 'parentId', 'folderId', 'destinationResourceId', 'targetResourceId'];
    for (const field of forbidden) {
      assert.equal(scoped.includes(field), false, `ตัวเรียก API ส่ง ${field} ไปด้วย`);
    }
    // แนบเฉพาะไฟล์เท่านั้น
    assert.ok(scoped.includes("form.append('file'"));
  });
});

describe('พฤติกรรมบนมือถือและตอนออฟไลน์', () => {
  test('การส่งไฟล์ถูกปิดตอนออฟไลน์ และไม่สัญญาว่าจะส่งให้ทีหลัง', () => {
    assert.ok(detailSource.includes('useConnectivity'), 'ต้องรู้สถานะการเชื่อมต่อ');
    assert.ok(detailSource.includes('!online'), 'ต้องมีเส้นทางสำหรับตอนออฟไลน์');
    assert.ok(
      detailSource.includes('ระบบจะไม่ส่งให้อัตโนมัติภายหลัง'),
      'ต้องบอกชัดว่าไม่มีคิวส่งอัตโนมัติ',
    );
    // ไม่มีคิวส่งซ้ำอัตโนมัติ
    for (const banned of ['retryQueue', 'backgroundSync', 'navigator.serviceWorker.sync']) {
      assert.equal(detailSource.includes(banned), false, `พบกลไกส่งซ้ำอัตโนมัติ: ${banned}`);
    }
  });

  test('ไม่มีการอ้างว่าสำเร็จก่อนเซิร์ฟเวอร์ยืนยัน', () => {
    // ต้องไม่มี optimistic update - รีเฟรชจากเซิร์ฟเวอร์เมื่อสำเร็จจริงเท่านั้น
    assert.equal(detailSource.includes('onMutate'), false, 'พบการอัปเดตแบบ optimistic');
    assert.ok(detailSource.includes('onSuccess'), 'ต้องรอผลจากเซิร์ฟเวอร์');
    assert.ok(detailSource.includes('invalidateQueries'), 'ต้องดึงสถานะจริงกลับมาหลังส่งสำเร็จ');
  });

  test('เป้ากดมีขนาดพอสำหรับนิ้ว และไม่มีการกระทำที่ซ่อนหลัง hover', () => {
    assert.ok(listSource.includes('min-h-11'), 'การ์ดต้องมีเป้ากดสูงพอ');
    const buttons = detailSource.match(/className="s2-btn[^"]*"/g) ?? [];
    assert.ok(buttons.length >= 2);
    for (const button of buttons) {
      assert.ok(button.includes('min-h-11'), `ปุ่มเป้าเล็กเกินไป: ${button}`);
    }
    // ไม่มีปุ่มที่ปรากฏเฉพาะตอน hover
    assert.equal(/opacity-0[^"]*group-hover/.test(detailSource), false);
    assert.equal(/opacity-0[^"]*group-hover/.test(listSource), false);
  });

  test('แถบล่างของจอแคบเคารพ safe area และซ่อนบนจอกว้าง', () => {
    assert.ok(shellSource.includes('env(safe-area-inset-bottom)'), 'ต้องเว้นระยะแถบบ้าน');
    assert.ok(shellSource.includes('sm:hidden'), 'แถบล่างต้องมีเฉพาะจอแคบ');
    assert.ok(shellSource.includes('/portal/workflows'), 'ต้องเข้าถึงหน้างานได้จากมือถือ');
    assert.ok(shellSource.includes('aria-label="เมนูพื้นที่เอกสาร"'));
  });

  test('หน้ารายละเอียดเว้นระยะล่างให้พ้นแถบล่าง', () => {
    assert.ok(detailSource.includes('env(safe-area-inset-bottom)'));
  });
});

/**
 * F26-E/F/G - หน้าจอการตรวจงานฝั่งภายใน และสถานะการส่งฉบับแก้ฝั่งผู้รับงาน
 */
const reviewSource = readFileSync(
  new URL('../../components/files/WorkflowReviewSheet.tsx', import.meta.url), 'utf8',
);

describe('หน้าจอการตรวจงานฝั่งภายใน', () => {
  test('ทุกปุ่มส่ง submissionId ที่กำลังดูอยู่ ไปให้เซิร์ฟเวอร์ตรวจว่ายังใช่ฉบับล่าสุด', () => {
    assert.ok(reviewSource.includes('submissionId'), 'ต้องส่งรหัสฉบับที่กำลังตัดสิน');
    assert.ok(
      reviewSource.includes('WORKFLOW_REVIEW_STALE'),
      'ต้องมีข้อความอธิบายเมื่อฉบับล้าสมัย ไม่ใช่ปล่อยให้ผู้ตรวจงง',
    );
  });

  test('หน้าจอไม่คำนวณสถานะหรือการหมดอายุเอง', () => {
    assert.equal(reviewSource.includes('Date.now()'), false, 'พบการอ่านเวลาปัจจุบันบนหน้าจอ');
    assert.equal(/expiresAt\s*[<>]/.test(reviewSource), false, 'พบการเทียบเวลาหมดอายุบนหน้าจอ');
  });

  test('ปุ่มที่บังคับเหตุผทั้งหมดถูกปิดจนกว่าจะพิมพ์ครบ', () => {
    // ไม่อนุมัติ ขอให้แก้ไข และยกเลิก ต้องถูกปิดเมื่อเหตุผลสั้นเกินไป
    const guarded = reviewSource.match(/disabled=\{busy \|\| reasonTooShort\}/g) ?? [];
    assert.ok(guarded.length >= 3, `ต้องมีปุ่มที่บังคับเหตุผลอย่างน้อยสามปุ่ม แต่พบ ${guarded.length}`);
    assert.ok(reviewSource.includes('reason.trim().length < MIN_REASON'), 'ต้องตัดช่องว่างก่อนวัดความยาว');
  });

  test('เป้ากดใหญ่พอ และไม่มีการกระทำที่ซ่อนหลัง hover', () => {
    const buttons = reviewSource.match(/className="s2-btn[^"]*"/g) ?? [];
    assert.ok(buttons.length >= 4);
    for (const button of buttons) {
      assert.ok(button.includes('min-h-11'), `ปุ่มเป้าเล็กเกินไป: ${button}`);
    }
    assert.equal(/opacity-0[^"]*group-hover/.test(reviewSource), false);
    assert.ok(reviewSource.includes('env(safe-area-inset-bottom)'), 'ต้องเว้นระยะแถบบ้านบนมือถือ');
  });

  test('ใช้ Sheet ตัวเดียวกับส่วนอื่นของระบบ ไม่สร้างกล่องของตัวเอง', () => {
    assert.ok(reviewSource.includes("from '@/components/ui/Sheet'"));
  });
});

describe('สถานะการส่งฉบับแก้ฝั่งผู้รับงาน', () => {
  test('แสดงเหตุผลที่เจ้าหน้าที่ขอให้แก้ไข และไม่กลบคำชี้แจงเดิม', () => {
    assert.ok(detailSource.includes('latestDecision'), 'ต้องแสดงผลการตัดสินล่าสุด');
    assert.ok(detailSource.includes('เจ้าหน้าที่ขอให้แก้ไข'));
    assert.ok(detailSource.includes('คำชี้แจง'), 'คำชี้แจงเดิมต้องยังอยู่');
  });

  test('บอกชัดว่าฉบับก่อนยังถูกเก็บไว้ ไม่ใช่ถูกเขียนทับ', () => {
    assert.ok(detailSource.includes('ไฟล์ที่ส่งไปแล้วยังถูกเก็บไว้'));
    assert.ok(detailSource.includes('ฉบับที่ {submission.sequence}'), 'ต้องแสดงลำดับของแต่ละฉบับ');
  });
});
