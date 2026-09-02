import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { activityDetail, activityLabel, activityTone } from './activity-text.ts';

describe('คำอธิบายบันทึกกิจกรรม', () => {
  test('แปลงรหัสเหตุการณ์เป็นภาษาไทย', () => {
    assert.equal(activityLabel('RESOURCE_UPLOADED'), 'อัปโหลดไฟล์');
    assert.equal(activityLabel('RESOURCE_ACCESS_GRANTED'), 'ให้สิทธิ์เข้าถึง');
    assert.equal(activityLabel('OWNERSHIP_BULK_TRANSFERRED'), 'ส่งมอบความรับผิดชอบทั้งชุด');
    assert.equal(activityLabel('USER_PROFILE_UPDATED'), 'แก้ไขโปรไฟล์ผู้ใช้');
    assert.equal(activityLabel('USER_ROLE_CHANGED'), 'เปลี่ยนบทบาทผู้ใช้');
    assert.equal(activityLabel('USER_ACTIVATED'), 'เปิดใช้งานผู้ใช้');
  });

  test('เหตุการณ์ที่ยังไม่รู้จักต้องอ่านออก ไม่ใช่ช่องว่าง', () => {
    assert.equal(activityLabel('SOMETHING_NEW'), 'SOMETHING_NEW');
    assert.equal(activityTone('SOMETHING_NEW'), 'neutral');
  });

  test('รายละเอียดแท็กอ่านจากชื่อที่บันทึกไว้', () => {
    assert.equal(activityDetail('RESOURCE_TAG_ADDED', { tagName: 'สัญญา' }), 'แท็ก “สัญญา”');
    assert.equal(activityDetail('RESOURCE_TAG_REMOVED', { tagId: 'x', tagName: null }), null);
  });

  test('หมายเหตุบอกได้แค่ว่าเพิ่มหรือลบ ไม่แสดงเนื้อความ', () => {
    assert.equal(activityDetail('RESOURCE_REMARK_UPDATED', { cleared: false, length: 42 }), 'บันทึกหมายเหตุใหม่');
    assert.equal(activityDetail('RESOURCE_REMARK_UPDATED', { cleared: true, length: 0 }), 'ลบหมายเหตุออก');
  });

  test('การให้สิทธิ์บอกระดับและข้อจำกัดการดาวน์โหลด', () => {
    assert.equal(activityDetail('RESOURCE_ACCESS_GRANTED', { accessLevel: 'EDITOR', allowDownload: true }), 'แก้ไขได้');
    assert.equal(
      activityDetail('RESOURCE_ACCESS_GRANTED', { accessLevel: 'VIEWER', allowDownload: false }),
      'เปิดดูได้ (ห้ามดาวน์โหลด)',
    );
  });

  test('ไม่มี metadata ต้องไม่พัง', () => {
    assert.equal(activityDetail('RESOURCE_UPLOADED', null), null);
    assert.equal(activityDetail('RESOURCE_TAG_ADDED', undefined), null);
  });
});
