import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { downloadResource, offlineDownloadMessage } from './download.ts';
import { RESOURCE_ACTION_CATALOG } from './resource-action-catalog.ts';
import { visibleResourceActions } from './interaction-policy.ts';
import type { DriveEntry } from './drive.ts';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * สิทธิ์ต้องถูกตัดสินที่เดียว (F24-E)
 *
 * **ความเสี่ยงที่กันไว้:** ถ้าหน้าจอไหนตัดสินเองว่าจะโชว์ปุ่มอะไร มันจะค่อย ๆ เพี้ยน
 * ออกจากกฎจริง แล้ววันหนึ่งจะมีหน้าที่เสนอปุ่มที่กดแล้วเซิร์ฟเวอร์ปฏิเสธ
 * หรือซ่อนปุ่มที่ผู้ใช้มีสิทธิ์ใช้จริง ทั้งสองแบบทำให้ผู้ใช้ไม่เชื่อถือหน้าจอ
 */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [full] : [];
  });
}

const CAPS = {
  canEdit: true, canRename: true, canMove: true, canDelete: true, canDownload: true,
  canUploadVersion: true, canShare: true, canLock: true, canTransferOwner: true,
} as unknown as DriveEntry['capabilities'];

function entryOf(overrides: Partial<DriveEntry> = {}): DriveEntry {
  return {
    id: 'r1', kind: 'file', resourceType: 'FILE', name: 'ไฟล์.pdf',
    sizeBytes: 1, ownerId: 'u1', ownerName: 'o', ownerEmail: 'o@example.invalid',
    modifiedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    mimeType: 'application/pdf', uploadedBy: null, currentVersion: 1,
    visibility: 'ORGANIZATION', driveRoot: 'MY_DRIVE', favorite: false, pinned: false,
    parentId: null, isLocked: false, tags: [], lockReason: null, lockedAt: null, lockedByName: null,
    capabilities: CAPS,
    ...overrides,
  };
}

describe('F24-E การตัดสินสิทธิ์ที่เดียว', { concurrency: 1 }, () => {
  /** ทั้งเมนูเดสก์ท็อปและแผ่นมือถือต้องอ่านจากฟังก์ชันเดียวกัน */
  test('ทั้งสองหน้าจอใช้ visibleResourceActions ตัวเดียวกัน', () => {
    const desktop = fs.readFileSync(path.join(srcDir, 'components', 'files', 'ContextMenu.tsx'), 'utf8');
    const mobile = fs.readFileSync(path.join(srcDir, 'components', 'files', 'MobileActionSheet.tsx'), 'utf8');
    assert.ok(desktop.includes('visibleResourceActions'), 'เมนูเดสก์ท็อปต้องใช้ตัวตัดสินกลาง');
    assert.ok(mobile.includes('visibleResourceActions'), 'แผ่นมือถือต้องใช้ตัวตัดสินกลาง');
  });

  /**
   * ไม่มีหน้าจอไหนสร้างรายการการกระทำของตัวเอง
   *
   * ตรวจว่าไม่มีไฟล์อื่นนอกจากตัวนโยบายเองที่ประกาศชุดการกระทำขึ้นมาใหม่
   */
  test('ไม่มีหน้าจอใดสร้างตัวตัดสินสิทธิ์ชุดที่สอง', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      const relative = path.relative(srcDir, file);
      if (relative.includes('interaction-policy')) continue;
      const content = fs.readFileSync(file, 'utf8');
      // รูปแบบที่บ่งชี้การตัดสินเอง: อ่าน capabilities แล้วประกอบรายการการกระทำขึ้นมาเอง
      if (/capabilities\.can\w+\s*\?\s*\[\s*['"]/.test(content)) offenders.push(relative);
    }
    assert.deepEqual(offenders, [], 'ไฟล์เหล่านี้ประกอบรายการการกระทำเอง แทนที่จะถามนโยบายกลาง');
  });

  /** ทุกการกระทำที่นโยบายเสนอได้ ต้องมีถ้อยคำของมันในสารบบ */
  test('ทุกการกระทำที่เป็นไปได้มีถ้อยคำกำกับ', () => {
    const shapes = [
      entryOf(),
      entryOf({ kind: 'folder' }),
      entryOf({ favorite: true, pinned: true, isLocked: true }),
    ];
    const missing = new Set<string>();
    for (const shape of shapes) {
      for (const action of visibleResourceActions(shape)) {
        if (!(action in RESOURCE_ACTION_CATALOG) && action !== 'activity') missing.add(action);
      }
    }
    assert.deepEqual([...missing], [], 'การกระทำเหล่านี้จะแสดงเป็นชื่อคีย์ดิบบนหน้าจอ');
  });
});

describe('F24-F การดาวน์โหลดขณะออฟไลน์', { concurrency: 1 }, () => {
  /**
   * ปฏิเสธก่อนยิงคำขอ เพื่อให้ข้อความชี้ไปที่สาเหตุจริง
   *
   * ถ้าปล่อยให้ยิงออกไป ผู้ใช้จะได้ข้อความว่าเชื่อมต่อเซิร์ฟเวอร์ไม่ได้
   * ซึ่งชวนให้คิดว่าระบบล่ม ทั้งที่เครื่องของเขาเองไม่ได้ต่อเน็ตอยู่
   */
  test('ออฟไลน์แล้วโยนข้อความที่บอกสาเหตุจริง', async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: false }, configurable: true, writable: true, enumerable: false,
    });
    try {
      await assert.rejects(
        () => downloadResource('r1', 'ไฟล์.pdf'),
        (error: Error) => error.message === offlineDownloadMessage(),
      );
    } finally {
      if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    }
  });

  test('ข้อความตรงกับที่หน้าตัวอย่างไฟล์ใช้', () => {
    assert.equal(offlineDownloadMessage(), 'ต้องเชื่อมต่ออินเทอร์เน็ตเพื่อเปิดไฟล์');
  });
});
