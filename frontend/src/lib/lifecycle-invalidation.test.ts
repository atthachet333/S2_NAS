import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRIVE_SYNC_KEY,
  lifecycleInvalidationKeys,
  resourceMutationInvalidationKeys,
  trashInvalidationKeys,
  type QueryKey,
} from './lifecycle-invalidation';

/**
 * การล้างแคชหลังเปลี่ยนวงจรชีวิต (F19)
 *
 * พบระหว่าง live QA: หลังวาง Legal Hold หรือเก็บเข้าคลัง แผง Google Drive ยังแสดง
 * "ซิงก์แล้ว" ทั้งที่เซิร์ฟเวอร์ตอบ PAUSED_LEGAL_HOLD / PAUSED_LIFECYCLE ไปแล้ว
 * เพราะไม่มีใครล้างแคชคีย์ drive-sync ผู้ใช้จึงเข้าใจว่าเอกสารยังรับเนื้อหาใหม่อยู่
 *
 * ชุดทดสอบนี้ยึดสัญญาไว้ที่ระดับรายการคีย์ ไม่ใช่ที่ภายในของคอมโพเนนต์ - เพราะสิ่งที่
 * ต้องไม่พังคือ "มีคีย์ drive-sync อยู่ในรายการที่ถูกล้าง" ไม่ใช่วิธีที่หน้าจอเรียกใช้
 */

const has = (keys: QueryKey[], target: readonly string[]) =>
  keys.some((key) => key.length === target.length && key.every((part, index) => part === target[index]));

describe('การล้างแคชเมื่อวงจรชีวิตเปลี่ยน', () => {
  describe('Legal Hold และคลัง', () => {
    test('ล้างสถานะซิงก์ของทรัพยากรที่กำลังเปิดอยู่', () => {
      assert.ok(has(lifecycleInvalidationKeys('res-1'), [DRIVE_SYNC_KEY, 'res-1']));
    });

    test('ล้างแบบเจาะจง id ไม่กวาดทรัพยากรอื่นทิ้งโดยไม่จำเป็น', () => {
      const keys = lifecycleInvalidationKeys('res-1');
      const driveSync = keys.filter((key) => key[0] === DRIVE_SYNC_KEY);
      assert.equal(driveSync.length, 1);
      assert.deepEqual(driveSync[0], [DRIVE_SYNC_KEY, 'res-1']);
    });

    test('ยังล้างคีย์เดิมที่หน้าจออื่นพึ่งพาอยู่', () => {
      const keys = lifecycleInvalidationKeys('res-1');
      for (const expected of [['drive'], ['legal-holds'], ['search'], ['trash']]) {
        assert.ok(has(keys, expected), expected.join('/'));
      }
    });

    test('id ที่ต่างกันให้คีย์ที่ต่างกัน', () => {
      assert.ok(has(lifecycleInvalidationKeys('res-2'), [DRIVE_SYNC_KEY, 'res-2']));
      assert.ok(!has(lifecycleInvalidationKeys('res-2'), [DRIVE_SYNC_KEY, 'res-1']));
    });
  });

  describe('การย้ายไปถังขยะจากหน้าไฟล์', () => {
    test('ล้างสถานะซิงก์ทั้งคำนำหน้า เพราะโฟลเดอร์พาลูกหลานไปด้วย', () => {
      assert.ok(has(resourceMutationInvalidationKeys(), [DRIVE_SYNC_KEY]));
    });

    test('ยังล้างคีย์เดิมของหน้าไฟล์', () => {
      const keys = resourceMutationInvalidationKeys();
      for (const expected of [['drive'], ['resource'], ['folder-picker'], ['admin-ownership']]) {
        assert.ok(has(keys, expected), expected.join('/'));
      }
    });
  });

  describe('การกู้คืนจากถังขยะ', () => {
    test('ล้างสถานะซิงก์ทั้งคำนำหน้า เพื่อให้แผงเลิกแสดงว่าหยุดชั่วคราว', () => {
      assert.ok(has(trashInvalidationKeys(), [DRIVE_SYNC_KEY]));
    });

    test('ยังล้างคีย์เดิมของหน้าถังขยะ', () => {
      const keys = trashInvalidationKeys();
      for (const expected of [['trash'], ['drive'], ['dashboard-summary'], ['managed-storage']]) {
        assert.ok(has(keys, expected), expected.join('/'));
      }
    });
  });

  test('คำนำหน้าตรงกับคีย์ที่ GoogleDrivePanel ใช้ถามสถานะ', () => {
    // GoogleDrivePanel ใช้ useQuery({ queryKey: ['drive-sync', resourceId] })
    assert.equal(DRIVE_SYNC_KEY, 'drive-sync');
  });
});
