/**
 * Link Lock - กติกาของหน้ากั้นฝั่งหน้าจอ (§25)
 *
 * ตรวจที่ข้อตกลงกับเซิร์ฟเวอร์และที่ "สิ่งที่ต้องไม่ปรากฏ" มากกว่าตำแหน่งของปุ่ม
 * ข้อที่สำคัญที่สุดคือหน้านี้ต้องไม่แสดงอะไรเกี่ยวกับเอกสารเลย เพราะตอนที่มันถูกแสดง
 * เซิร์ฟเวอร์ยังไม่ได้บอกอะไรมาด้วยซ้ำ
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const lockSource = readFileSync(new URL('./LinkLockedPage.tsx', import.meta.url), 'utf8');
const guestSource = readFileSync(new URL('../../pages/guest/GuestSharePage.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../../lib/api.ts', import.meta.url), 'utf8');
const shareDialog = readFileSync(new URL('../files/PublicShareDialog.tsx', import.meta.url), 'utf8');

describe('หน้า BLOCKED', () => {
  test('ข้อความตรงตามที่กำหนดทุกบรรทัด', () => {
    assert.ok(lockSource.includes("'BLOCKED'"), 'ต้องมีหัวข้อ BLOCKED');
    assert.ok(lockSource.includes('กรุณาเข้าสู่ระบบเพื่อเข้าถึงเอกสารนี้'));
    assert.ok(lockSource.includes('เอกสารนี้อนุญาตเฉพาะผู้ใช้งานที่ได้รับสิทธิ์เท่านั้น'));
    assert.ok(lockSource.includes('เข้าสู่ระบบ'), 'ต้องมีปุ่มเข้าสู่ระบบ');
    assert.ok(lockSource.includes('กลับหน้าหลัก'), 'ต้องมีปุ่มกลับหน้าหลัก');
  });

  test('ข้อความของ ACCESS DENIED แยกจากกันชัดเจน', () => {
    assert.ok(lockSource.includes("'ACCESS DENIED'"));
    assert.ok(lockSource.includes('บัญชีนี้ไม่มีสิทธิ์เข้าถึงเอกสาร'));
    assert.ok(lockSource.includes('กรุณาติดต่อผู้ดูแลระบบ'));
    // ปุ่มเข้าสู่ระบบต้องไม่ขึ้นตอนที่ล็อกอินอยู่แล้ว - มันไม่ใช่ทางออกของสถานะนี้
    assert.ok(lockSource.includes('blocked ? ('), 'ปุ่มเข้าสู่ระบบต้องขึ้นเฉพาะสถานะ BLOCKED');
  });

  test('ไม่มีข้อมูลของเอกสารปรากฏบนหน้ากั้นเลย', () => {
    for (const forbidden of [
      'resource.name', 'resource.size', 'resource.mimeType', 'share.resource',
      'filename', 'storageKey', 'classification', 'ownerName', 'data?.resource',
    ]) {
      assert.equal(lockSource.includes(forbidden), false, `หน้ากั้นอ้างถึง ${forbidden}`);
    }
    // และไม่มีตัวแสดงเอกสารซ่อนอยู่ข้างหลัง
    for (const forbidden of ['PreviewModal', 'iframe', 'blur', 'objectUrl', 'contentUrl']) {
      assert.equal(lockSource.includes(forbidden), false, `หน้ากั้นมี ${forbidden} อยู่`);
    }
  });

  test('ปลายทางหลังเข้าสู่ระบบผ่านตัวตรวจเสมอ', () => {
    assert.ok(lockSource.includes('loginPathFor'), 'ต้องใช้ตัวช่วยที่ตรวจปลายทาง');
    // ห้ามประกอบ URL ของหน้าเข้าสู่ระบบเอง ซึ่งจะข้ามตัวตรวจไป
    assert.equal(/navigate\(['"`]\/login\?/.test(lockSource), false, 'พบการประกอบ URL เอง');
  });
});

describe('การแปลรหัสจากเซิร์ฟเวอร์เป็นหน้าจอ', () => {
  test('LOGIN_REQUIRED และ ACCESS_DENIED ถูกแยกเป็นคนละหน้า', () => {
    assert.ok(guestSource.includes('LOGIN_REQUIRED'), 'ต้องรู้จักรหัสยังไม่ได้เข้าสู่ระบบ');
    assert.ok(guestSource.includes('ACCESS_DENIED'), 'ต้องรู้จักรหัสไม่มีสิทธิ์');
    assert.ok(guestSource.includes('state="BLOCKED"'));
    assert.ok(guestSource.includes('state="ACCESS_DENIED"'));
  });

  test('ปลายทางที่ส่งไปหน้าเข้าสู่ระบบคือลิงก์เดิม เพื่อกลับมาที่เดิมได้', () => {
    assert.ok(guestSource.includes('returnTo={`/s/${token}`}'), 'ต้องส่งเส้นทางของลิงก์นี้กลับไป');
  });
});

describe('คำขอฝั่งลิงก์แนบตัวตนไปด้วย', () => {
  test('guestFetch ส่ง Authorization เมื่อมีเซสชัน', () => {
    const block = apiSource.slice(apiSource.indexOf('async function guestFetch'));
    const scoped = block.slice(0, 900);
    assert.ok(scoped.includes('Authorization'), 'คำขอของลิงก์ต้องแนบ token ของผู้ใช้');
    assert.ok(scoped.includes('X-Guest-Pass'), 'รหัสผ่านของลิงก์ยังต้องส่งได้อยู่');
  });
});

describe('หน้าสร้างลิงก์บอกความจริงกับผู้สร้าง', () => {
  test('เตือนว่าผู้รับต้องเข้าสู่ระบบก่อน', () => {
    assert.ok(
      shareDialog.includes('ผู้รับลิงก์ต้องเข้าสู่ระบบก่อน'),
      'ต้องบอกตั้งแต่ตอนสร้าง ไม่ใช่ให้ไปรู้เอาตอนลูกค้าเปิดไม่ได้',
    );
  });
});

describe('มือถือและการเข้าถึง', () => {
  test('เป้ากดใหญ่พอ และเว้นระยะแถบบ้าน', () => {
    const buttons = lockSource.match(/className="s2-btn[^"]*"/g) ?? [];
    assert.ok(buttons.length >= 2, 'ต้องมีปุ่มอย่างน้อยสองปุ่ม');
    for (const button of buttons) {
      assert.ok(button.includes('min-h-11'), `ปุ่มเป้าเล็กเกินไป: ${button}`);
    }
    assert.ok(lockSource.includes('env(safe-area-inset-bottom)'), 'ต้องเว้นระยะแถบบ้าน');
    assert.ok(lockSource.includes('min-h-[100dvh]'), 'ต้องใช้ dvh ไม่ใช่ vh บนมือถือ');
  });

  test('ไม่มีการกระทำที่ซ่อนอยู่หลัง hover', () => {
    assert.equal(/opacity-0[^"]*group-hover/.test(lockSource), false);
  });

  test('หัวข้อปรับขนาดตามจอ ไม่ล้นบนเครื่อง 320px', () => {
    assert.ok(/text-\[34px\][\s\S]*sm:text-\[42px\]/.test(lockSource), 'ต้องมีขนาดสำหรับจอแคบด้วย');
  });
});
