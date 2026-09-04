import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  EXTERNAL_GRANTABLE_LEVELS,
  externalCapabilities,
  isExternalUser,
  isGrantActive,
  isPortalVisibleType,
  portalRoleFor,
} from './portal-policy.ts';

/**
 * นโยบายของผู้ใช้งานภายนอก
 *
 * ชุดทดสอบนี้คือคำอธิบายที่บังคับใช้ได้ของกติกาความปลอดภัยในเฟส F10
 * ทุกข้อที่ล้มเหลวที่นี่แปลว่าลูกค้าทำสิ่งที่ไม่ควรทำได้ หรือเห็นสิ่งที่ไม่ควรเห็น
 */

const NOW = new Date('2026-09-04T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('การจำแนกชนิดบัญชี', () => {
  test('รู้จักบัญชีลูกค้าจากชนิด ไม่ใช่จากบทบาท', () => {
    assert.equal(isExternalUser({ type: 'EXTERNAL' }), true);
    assert.equal(isExternalUser({ type: 'INTERNAL' }), false);
    assert.equal(isExternalUser({ type: 'SERVICE' }), false);
  });

  test('ค่าที่หายไปหรือไม่รู้จักไม่นับเป็นบัญชีภายนอก', () => {
    // สำคัญ: ต้องไม่ "เดา" ว่าเป็นภายนอก เพราะจะทำให้บัญชีภายในหลุดเข้าพื้นที่ลูกค้าแทน
    assert.equal(isExternalUser(null), false);
    assert.equal(isExternalUser(undefined), false);
    assert.equal(isExternalUser({}), false);
  });
});

describe('การแปลงระดับสิทธิ์เป็นบทบาทในพื้นที่ลูกค้า', () => {
  test('VIEWER ยังคงเป็นผู้ดูอย่างเดียว', () => {
    assert.equal(portalRoleFor('VIEWER'), 'VIEWER');
  });

  test('EDITOR ถูกลดรูปเหลือผู้อัปโหลด ไม่ใช่ผู้แก้ไข', () => {
    assert.equal(portalRoleFor('EDITOR'), 'CONTRIBUTOR');
  });

  test('OWNER ที่หลุดมาก็ไม่ได้อำนาจเกิน CONTRIBUTOR', () => {
    // ไม่ควรมอบ OWNER ให้ลูกค้าอยู่แล้ว แต่ถ้าเกิดขึ้นต้องไม่กลายเป็นเจ้าของเอกสาร
    assert.equal(portalRoleFor('OWNER'), 'CONTRIBUTOR');
  });

  test('ระดับที่มอบให้ลูกค้าได้มีเพียงสองระดับ และไม่มี OWNER', () => {
    assert.deepEqual([...EXTERNAL_GRANTABLE_LEVELS], ['VIEWER', 'EDITOR']);
    assert.ok(!EXTERNAL_GRANTABLE_LEVELS.includes('OWNER' as never));
  });
});

describe('วันหมดอายุของสิทธิ์', () => {
  test('ไม่กำหนดวันหมดอายุ = ใช้ได้ตลอด', () => {
    assert.equal(isGrantActive({ expiresAt: null }, NOW), true);
    assert.equal(isGrantActive({}, NOW), true);
  });

  test('ยังไม่ถึงกำหนด = ใช้ได้', () => {
    assert.equal(isGrantActive({ expiresAt: new Date(NOW.getTime() + 1000) }, NOW), true);
    assert.equal(isGrantActive({ expiresAt: new Date(NOW.getTime() + 30 * DAY_MS) }, NOW), true);
  });

  test('เลยกำหนดแล้ว = ใช้ไม่ได้ทันที โดยไม่ต้องมีใครมาเก็บกวาด', () => {
    assert.equal(isGrantActive({ expiresAt: new Date(NOW.getTime() - 1) }, NOW), false);
    assert.equal(isGrantActive({ expiresAt: new Date(NOW.getTime() - 90 * DAY_MS) }, NOW), false);
  });

  test('ถึงกำหนดพอดีถือว่าหมดอายุแล้ว', () => {
    assert.equal(isGrantActive({ expiresAt: new Date(NOW.getTime()) }, NOW), false);
  });

  test('ไม่มีสิทธิ์เลย = ไม่ผ่าน', () => {
    assert.equal(isGrantActive(null, NOW), false);
    assert.equal(isGrantActive(undefined, NOW), false);
  });
});

describe('ความสามารถของผู้ดูอย่างเดียว', () => {
  const viewerOn = (type: 'FILE' | 'FOLDER', allowDownload: boolean) =>
    externalCapabilities({ role: 'VIEWER', allowDownload, resourceType: type, isLocked: false });

  test('ดูได้ แต่อัปโหลดไม่ได้', () => {
    const caps = viewerOn('FOLDER', true);
    assert.equal(caps.canView, true);
    assert.equal(caps.canUpload, false, 'ผู้ดูอย่างเดียวต้องอัปโหลดไม่ได้');
  });

  test('ดาวน์โหลดได้ก็ต่อเมื่อผู้แชร์เปิดสิทธิ์นั้นไว้', () => {
    assert.equal(viewerOn('FILE', true).canDownload, true);
    assert.equal(viewerOn('FILE', false).canDownload, false);
  });

  test('โฟลเดอร์ดาวน์โหลดไม่ได้แม้เปิด allowDownload', () => {
    assert.equal(viewerOn('FOLDER', true).canDownload, false);
  });
});

describe('ความสามารถของผู้อัปโหลด', () => {
  const contributorOn = (type: 'FILE' | 'FOLDER', options: { allowDownload?: boolean; isLocked?: boolean } = {}) =>
    externalCapabilities({
      role: 'CONTRIBUTOR',
      allowDownload: options.allowDownload ?? false,
      resourceType: type,
      isLocked: options.isLocked ?? false,
    });

  test('อัปโหลดเข้าโฟลเดอร์ที่ได้รับสิทธิ์ได้', () => {
    assert.equal(contributorOn('FOLDER').canUpload, true);
  });

  test('อัปโหลดทับไฟล์ไม่ได้ - ไฟล์ไม่ใช่ปลายทางของการอัปโหลด', () => {
    assert.equal(contributorOn('FILE').canUpload, false);
  });

  test('โฟลเดอร์ที่ถูกล็อกอัปโหลดไม่ได้ แม้จะมีสิทธิ์', () => {
    // การล็อกเป็นการตัดสินใจของฝ่ายภายใน มีน้ำหนักเหนือสิทธิ์ที่เคยมอบให้ลูกค้า
    assert.equal(contributorOn('FOLDER', { isLocked: true }).canUpload, false);
  });

  test('อัปโหลดได้ แต่ดาวน์โหลดไม่ได้ ถ้าไม่ได้เปิดสิทธิ์ดาวน์โหลด', () => {
    const caps = contributorOn('FILE', { allowDownload: false });
    assert.equal(caps.canDownload, false);
    assert.equal(externalCapabilities({
      role: 'CONTRIBUTOR', allowDownload: false, resourceType: 'FOLDER', isLocked: false,
    }).canUpload, true);
  });
});

describe('สิ่งที่ผู้ใช้ภายนอกทำไม่ได้เลย', () => {
  const everyCombination = () => {
    const rows = [];
    for (const role of ['VIEWER', 'CONTRIBUTOR'] as const) {
      for (const allowDownload of [true, false]) {
        for (const resourceType of ['FILE', 'FOLDER', 'WEB_LINK', 'GOOGLE_DOC'] as const) {
          for (const isLocked of [true, false]) {
            rows.push(externalCapabilities({ role, allowDownload, resourceType, isLocked }));
          }
        }
      }
    }
    return rows;
  };

  test('เปลี่ยนชื่อ ย้าย และลบ เป็นไปไม่ได้ในทุกกรณี', () => {
    for (const caps of everyCombination()) {
      assert.equal(caps.canRename, false);
      assert.equal(caps.canMove, false);
      assert.equal(caps.canDelete, false);
    }
  });

  test('แชร์ต่อ ล็อก และโอนผู้ดูแล เป็นไปไม่ได้ในทุกกรณี', () => {
    for (const caps of everyCombination()) {
      assert.equal(caps.canShare, false, 'ลูกค้าต้องแชร์ต่อไม่ได้');
      assert.equal(caps.canLock, false);
      assert.equal(caps.canTransferOwner, false);
    }
  });

  test('สร้างโฟลเดอร์ ดูประวัติเวอร์ชัน และเห็นถังขยะ เป็นไปไม่ได้ในทุกกรณี', () => {
    for (const caps of everyCombination()) {
      assert.equal(caps.canCreateFolder, false);
      assert.equal(caps.canSeeVersionHistory, false);
      assert.equal(caps.canSeeTrash, false);
    }
  });

  test('ข้อห้ามถูกปิดไว้ที่ระดับชนิดข้อมูล ไม่ใช่แค่ค่าที่คำนวณได้', () => {
    // สัญญาของฟังก์ชันประกาศเป็น false ตายตัว การเปิดในอนาคตจึงต้องแก้สัญญาก่อน
    const source = readFileSync(new URL('./portal-policy.ts', import.meta.url), 'utf8');
    for (const field of ['canRename', 'canMove', 'canDelete', 'canShare', 'canTransferOwner', 'canCreateFolder']) {
      assert.ok(
        new RegExp(`${field}: false;`).test(source),
        `${field} ต้องถูกประกาศเป็น false ตายตัวในชนิดข้อมูล`,
      );
    }
  });
});

describe('ชนิดทรัพยากรที่ปรากฏต่อลูกค้า', () => {
  test('เอกสารและลิงก์ที่แชร์ให้ได้ปรากฏได้', () => {
    for (const type of ['FILE', 'FOLDER', 'GOOGLE_SHEET', 'GOOGLE_DOC', 'GOOGLE_DRIVE', 'WEB_LINK'] as const) {
      assert.equal(isPortalVisibleType(type), true, `${type} ควรแสดงได้`);
    }
  });

  test('กลไกภายในไม่ปรากฏต่อลูกค้า', () => {
    assert.equal(isPortalVisibleType('SYSTEM_FILE'), false);
    assert.equal(isPortalVisibleType('SHORTCUT'), false);
  });
});
