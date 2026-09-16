import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { MobileActionSheet } from './MobileActionSheet.tsx';
import { visibleResourceActions } from '@/lib/interaction-policy';
import { RESOURCE_ACTION_CATALOG, actionLabel, requiresConfirmation } from '@/lib/resource-action-catalog';
import type { DriveEntry } from '@/lib/drive';

/**
 * แผ่นกระทำบนมือถือ (F24-C)
 *
 * **กฎที่สำคัญที่สุด:** แผ่นนี้ต้องไม่เสนอสิ่งที่ผู้ใช้ทำไม่ได้ และต้องไม่ซ่อนสิ่งที่ทำได้
 * รายการมาจาก visibleResourceActions ตัวเดียวกับเมนูของเดสก์ท็อป ซึ่งตัดสินจาก
 * capabilities ที่เซิร์ฟเวอร์คำนวณมาให้ ไม่ใช่จากการเดาของหน้าจอ
 */
const NO_CAPABILITIES = {
  canEdit: false, canRename: false, canMove: false, canDelete: false, canDownload: false,
  canUploadVersion: false, canShare: false, canLock: false, canTransferOwner: false,
} as unknown as DriveEntry['capabilities'];

function entryOf(overrides: Partial<DriveEntry> = {}): DriveEntry {
  return {
    id: 'r1', kind: 'file', resourceType: 'FILE', name: 'สัญญาจ้าง.pdf',
    sizeBytes: 1024, ownerId: 'u1', ownerName: 'ผู้ดูแล', ownerEmail: 'owner@example.invalid',
    modifiedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    mimeType: 'application/pdf', uploadedBy: null, currentVersion: 1,
    visibility: 'ORGANIZATION', driveRoot: 'MY_DRIVE', favorite: false, pinned: false,
    parentId: null, isLocked: false, tags: [], lockReason: null, lockedAt: null, lockedByName: null,
    capabilities: NO_CAPABILITIES,
    ...overrides,
  };
}

function render(entry: DriveEntry, onAction: (action: string, entry: DriveEntry | null) => void = () => undefined) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(createElement(MobileActionSheet, {
      entry, onClose: () => undefined, onAction,
    }));
  });
  return tree;
}

function labelsOf(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => node.type === 'button' && String(node.props.className ?? '').includes('min-h-[48px]'))
    .map((node) => {
      const texts: string[] = [];
      const walk = (child: unknown): void => {
        if (typeof child === 'string') { texts.push(child); return; }
        if (Array.isArray(child)) { child.forEach(walk); return; }
        const item = child as { props?: { children?: unknown } } | null;
        if (item && typeof item === 'object' && item.props) walk(item.props.children);
      };
      walk(node.props.children);
      return texts.join(' ').trim();
    });
}

describe('F24-C แผ่นกระทำบนมือถือ', { concurrency: 1 }, () => {
  /** ผู้ใช้ที่ไม่มีสิทธิ์อะไรเลย ต้องไม่เห็นการกระทำที่เปลี่ยนแปลงข้อมูล */
  test('ไม่เสนอการกระทำที่ผู้ใช้ไม่มีสิทธิ์', () => {
    const labels = labelsOf(render(entryOf())).join(' ');
    assert.ok(!labels.includes('เปลี่ยนชื่อ'), 'ไม่มีสิทธิ์เปลี่ยนชื่อ');
    assert.ok(!labels.includes('ย้ายไปถังขยะ'), 'ไม่มีสิทธิ์ลบ');
    assert.ok(!labels.includes('ดาวน์โหลดไฟล์ต้นฉบับ'), 'ไม่มีสิทธิ์ดาวน์โหลด');
  });

  test('เสนอการกระทำที่ผู้ใช้มีสิทธิ์จริง', () => {
    const entry = entryOf({
      capabilities: { ...NO_CAPABILITIES, canRename: true, canDelete: true, canDownload: true } as DriveEntry['capabilities'],
    });
    const labels = labelsOf(render(entry)).join(' ');
    assert.ok(labels.includes('เปลี่ยนชื่อ'));
    assert.ok(labels.includes('ย้ายไปถังขยะ'));
    assert.ok(labels.includes('ดาวน์โหลดไฟล์ต้นฉบับ'));
  });

  /**
   * แผ่นของมือถือกับเมนูของเดสก์ท็อปต้องเสนอชุดเดียวกันเป๊ะ
   *
   * ถ้าต่างกัน จะมีการกระทำที่ทำได้บนเครื่องหนึ่งแต่หายไปอีกเครื่องหนึ่ง
   * ซึ่งผู้ใช้จะรายงานว่า "ทำบนคอมได้ แต่บนมือถือไม่ได้" โดยไม่มีใครตั้งใจให้เป็นแบบนั้น
   */
  test('เสนอชุดเดียวกับเมนูของเดสก์ท็อป', () => {
    const entry = entryOf({
      capabilities: {
        ...NO_CAPABILITIES, canEdit: true, canRename: true, canMove: true,
        canDelete: true, canDownload: true, canShare: true, canLock: true,
      } as DriveEntry['capabilities'],
    });
    const expected = visibleResourceActions(entry).filter((action) => action in RESOURCE_ACTION_CATALOG);
    const rendered = labelsOf(render(entry));
    assert.equal(rendered.length, expected.length,
      `จำนวนไม่ตรงกัน: หน้าจอ ${rendered.length} นโยบาย ${expected.length}`);
    for (const action of expected) {
      assert.ok(rendered.some((label) => label.includes(actionLabel(action))),
        `ขาดการกระทำ ${action} (${actionLabel(action)})`);
    }
  });

  test('กดแล้วส่งการกระทำที่ถูกต้องออกไปพร้อมรายการ', () => {
    const calls: Array<{ action: string; id: string | undefined }> = [];
    const entry = entryOf({
      id: 'r7',
      capabilities: { ...NO_CAPABILITIES, canRename: true } as DriveEntry['capabilities'],
    });
    const tree = render(entry, (action, target) => calls.push({ action, id: target?.id }));
    const buttons = tree.root.findAll((node) =>
      node.type === 'button' && String(node.props.className ?? '').includes('min-h-[48px]'));
    const renameIndex = labelsOf(tree).findIndex((label) => label.includes('เปลี่ยนชื่อ'));
    assert.ok(renameIndex >= 0, 'ต้องมีปุ่มเปลี่ยนชื่อให้กด');
    const renameButton = buttons[renameIndex]!;
    act(() => { renameButton.props.onClick(); });
    assert.deepEqual(calls, [{ action: 'rename', id: 'r7' }]);
  });

  /** การลบต้องดูต่างจากรายการอื่น และถูกทำเครื่องหมายว่าต้องยืนยัน */
  test('การกระทำที่ย้อนกลับยากถูกเน้นให้ต่างออกไป', () => {
    assert.equal(requiresConfirmation('trash'), true);
    assert.equal(requiresConfirmation('rename'), false);
    const entry = entryOf({ capabilities: { ...NO_CAPABILITIES, canDelete: true } as DriveEntry['capabilities'] });
    const tree = render(entry);
    const danger = tree.root.findAll((node) =>
      node.type === 'button' && String(node.props.className ?? '').includes('text-rose-700'));
    assert.equal(danger.length, 1, 'ย้ายไปถังขยะต้องถูกเน้นเป็นการกระทำอันตราย');
  });

  /** ทุกการกระทำที่ระบบเสนอได้ ต้องมีถ้อยคำของมัน ไม่ใช่ชื่อคีย์ดิบ */
  test('ไม่มีการกระทำใดหลุดออกมาเป็นชื่อคีย์', () => {
    const everything = entryOf({
      kind: 'folder',
      capabilities: {
        canEdit: true, canRename: true, canMove: true, canDelete: true, canDownload: true,
        canUploadVersion: true, canShare: true, canLock: true, canTransferOwner: true,
      } as unknown as DriveEntry['capabilities'],
    });
    for (const action of visibleResourceActions(everything)) {
      assert.ok(action in RESOURCE_ACTION_CATALOG || action === 'activity',
        `การกระทำ ${action} ยังไม่มีถ้อยคำในสารบบ`);
    }
  });
});
