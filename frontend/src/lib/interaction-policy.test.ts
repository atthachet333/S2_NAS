import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DriveEntry } from './drive.ts';
import {
  EMPTY_WORKSPACE_ACTIONS,
  ORIGINAL_DOWNLOAD_LABEL,
  VERSION_DOWNLOAD_LABEL,
  clampContextMenuPosition,
  contextMenuMaxHeight,
  focusMenuItem,
  nextMenuIndex,
  selectionDownloadMode,
  visibleResourceActions,
} from './interaction-policy.ts';

const capabilities = {
  canView: true, canEdit: true, canRename: true, canMove: true, canDelete: true,
  canShare: true, canLock: true, canDownload: true, canUploadVersion: true, canTransferOwner: true,
};
const entry = (kind: 'file' | 'folder', overrides: Partial<DriveEntry> = {}): DriveEntry => ({
  id: kind, kind, resourceType: kind === 'file' ? 'FILE' : 'FOLDER', name: kind === 'file' ? 'test.pdf' : 'TEST',
  ownerId: 'owner', ownerName: 'Owner', ownerEmail: 'owner@example.invalid', modifiedAt: '', createdAt: '',
  mimeType: kind === 'file' ? 'application/pdf' : null, uploadedBy: null, currentVersion: kind === 'file' ? 2 : null,
  visibility: 'ORGANIZATION', driveRoot: 'MY_DRIVE', favorite: false, pinned: false, parentId: null, isLocked: false,
  tags: [], lockReason: null, lockedAt: null, lockedByName: null, capabilities, ...overrides,
});

describe('file manager interaction policy', () => {
  test('empty-space menu offers every creation action, none of them disabled', () => {
    assert.deepEqual(EMPTY_WORKSPACE_ACTIONS.slice(0, 3).map((item) => item.label), ['สร้างโฟลเดอร์', 'อัปโหลดไฟล์', 'อัปโหลดโฟลเดอร์']);
    // อัปโหลดโฟลเดอร์ทำงานได้จริงตั้งแต่ F8 จึงต้องไม่ถูกปิดไว้อีกต่อไป
    assert.equal(EMPTY_WORKSPACE_ACTIONS.find((item) => item.id === 'upload-folder')?.disabled, false);
    assert.ok(EMPTY_WORKSPACE_ACTIONS.every((item) => !item.disabled), 'ทุกการกระทำในเมนูต้องใช้งานได้จริง');
  });

  test('folder context menu has folder-only actions and capability filtering', () => {
    const actions = visibleResourceActions(entry('folder'));
    assert.ok(actions.includes('create-folder-inside') && actions.includes('upload-here') && actions.includes('download-zip'));
    assert.ok(!actions.includes('download') && !actions.includes('new-version'));
    const readonly = visibleResourceActions(entry('folder', { capabilities: { ...capabilities, canEdit: false, canRename: false, canMove: false, canDelete: false, canTransferOwner: false } }));
    assert.ok(!readonly.includes('create-folder-inside') && !readonly.includes('trash'));
  });

  test('file context menu has direct original download and no folder actions', () => {
    const actions = visibleResourceActions(entry('file'));
    assert.ok(actions.includes('preview') && actions.includes('download') && actions.includes('new-version'));
    assert.ok(!actions.includes('download-zip') && !actions.includes('create-folder-inside'));
  });

  test('external context menu opens, copies, and edits links without physical-file actions', () => {
    const external = entry('file', { resourceType: 'GOOGLE_SHEET', externalUrl: 'https://docs.google.com/spreadsheets/d/id/edit' });
    const actions = visibleResourceActions(external);
    assert.ok(actions.includes('open-external') && actions.includes('copy-external-link') && actions.includes('edit-external'));
    assert.ok(!actions.includes('preview') && !actions.includes('download') && !actions.includes('new-version'));
    assert.equal(selectionDownloadMode([external]), null);
  });

  test('selection download semantics distinguish file, folder, and multiple resources', () => {
    assert.equal(selectionDownloadMode([entry('file')]), 'ORIGINAL');
    assert.equal(selectionDownloadMode([entry('folder')]), 'ZIP');
    assert.equal(selectionDownloadMode([entry('file'), entry('folder')]), 'ZIP');
  });

  test('current and historical download labels are explicit', () => {
    assert.equal(ORIGINAL_DOWNLOAD_LABEL, 'ดาวน์โหลดไฟล์ต้นฉบับ');
    assert.equal(VERSION_DOWNLOAD_LABEL, 'ดาวน์โหลดเวอร์ชันนี้');
  });

  test('context menu positioning flips inside every viewport edge', () => {
    assert.deepEqual(clampContextMenuPosition({ x: 790, y: 590 }, { width: 240, height: 300 }, { width: 800, height: 600 }), { x: 550, y: 290 });
    assert.deepEqual(clampContextMenuPosition({ x: -20, y: -10 }, { width: 240, height: 300 }, { width: 800, height: 600 }), { x: 10, y: 10 });
  });

  test('context menu max height keeps safe margins and enables overflow for long content', () => {
    assert.equal(contextMenuMaxHeight(768), 748);
    assert.equal(contextMenuMaxHeight(900, 12), 876);
    assert.ok(900 > contextMenuMaxHeight(768), 'long menu content must exceed the capped height and scroll internally');
  });

  test('bottom-edge placement uses the full untransformed menu height', () => {
    assert.deepEqual(
      clampContextMenuPosition({ x: 360, y: 740 }, { width: 256, height: 648 }, { width: 375, height: 768 }),
      { x: 109, y: 110 },
    );
  });

  test('keyboard navigation wraps and supports Home/End', () => {
    assert.equal(nextMenuIndex(0, 'ArrowUp', 4), 3);
    assert.equal(nextMenuIndex(3, 'ArrowDown', 4), 0);
    assert.equal(nextMenuIndex(2, 'Home', 4), 0);
    assert.equal(nextMenuIndex(1, 'End', 4), 3);
  });

  test('active keyboard item receives focus and scrolls into view', () => {
    const calls: string[] = [];
    const items = [0, 1].map((index) => ({
      focus: () => calls.push(`focus:${index}`),
      scrollIntoView: (options?: ScrollIntoViewOptions) => calls.push(`scroll:${index}:${options?.block}`),
    }));
    focusMenuItem(items, 1);
    assert.deepEqual(calls, ['focus:1', 'scroll:1:nearest']);
  });
  test('เมนูรายการโปรดและปักหมุดสลับตามสถานะปัจจุบัน', () => {
    const plain = visibleResourceActions(entry('file'));
    assert.ok(plain.includes('favorite') && plain.includes('pin'));
    assert.ok(!plain.includes('unfavorite') && !plain.includes('unpin'));

    const marked = visibleResourceActions(entry('file', { favorite: true, pinned: true }));
    assert.ok(marked.includes('unfavorite') && marked.includes('unpin'));
    assert.ok(!marked.includes('favorite') && !marked.includes('pin'));
  });

  test('รายการโปรดและปักหมุดใช้ได้แม้ไม่มีสิทธิ์แก้ไข เพราะเป็นข้อมูลส่วนตัว', () => {
    const readonly = visibleResourceActions(
      entry('file', {
        capabilities: {
          ...capabilities,
          canEdit: false, canRename: false, canMove: false, canDelete: false,
          canShare: false, canLock: false, canUploadVersion: false,
        },
      }),
    );
    assert.ok(readonly.includes('favorite') && readonly.includes('pin'));
    assert.ok(!readonly.includes('share') && !readonly.includes('lock') && !readonly.includes('tags'));
  });

  test('ล็อกและปลดล็อกแสดงเฉพาะผู้ที่มีสิทธิ์ล็อก และสลับตามสถานะไฟล์', () => {
    assert.ok(visibleResourceActions(entry('file')).includes('lock'));
    const locked = visibleResourceActions(entry('file', { isLocked: true }));
    assert.ok(locked.includes('unlock') && !locked.includes('lock'));

    const noLockRight = visibleResourceActions(entry('file', { capabilities: { ...capabilities, canLock: false } }));
    assert.ok(!noLockRight.includes('lock') && !noLockRight.includes('unlock'));
  });

  test('ประวัติการใช้งานเปิดดูได้ทุกรายการที่มองเห็น', () => {
    assert.ok(visibleResourceActions(entry('file')).includes('activity'));
    assert.ok(visibleResourceActions(entry('folder')).includes('activity'));
  });
});
