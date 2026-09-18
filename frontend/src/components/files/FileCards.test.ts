import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { FileCards } from './FileCards.tsx';
import type { DriveEntry } from '@/lib/drive';

/**
 * รายการไฟล์บนจอโทรศัพท์ (F24-C)
 *
 * **ข้อบกพร่องที่ชุดนี้กันไม่ให้กลับมา:** ตารางเดิมกว้าง 1040px และปุ่มตัวเลือกของแต่ละแถว
 * ถูกซ่อนด้วย opacity-0 จนกว่าเมาส์จะชี้ บนจอสัมผัสจึงไม่มีทางเปิดเมนูของไฟล์ได้เลย
 * ชุดนี้ยืนยันว่าการ์ดของมือถือไม่พึ่งการชี้เมาส์ และมีเป้าหมายแตะที่ใหญ่พอ
 */
function entryOf(overrides: Partial<DriveEntry> = {}): DriveEntry {
  return {
    id: 'r1', kind: 'file', resourceType: 'FILE', name: 'ใบกำกับภาษี.pdf',
    sizeBytes: 4096, ownerId: 'u1', ownerName: 'ผู้ดูแล', ownerEmail: 'owner@example.invalid',
    modifiedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    mimeType: 'application/pdf', uploadedBy: null, currentVersion: 1,
    classification: 'INTERNAL', classifiedAt: null, classificationRestrictions: null,
    visibility: 'ORGANIZATION', driveRoot: 'MY_DRIVE', favorite: false, pinned: false,
    parentId: null, isLocked: false, tags: [], lockReason: null, lockedAt: null, lockedByName: null,
    capabilities: {} as DriveEntry['capabilities'],
    ...overrides,
  };
}

function render(entries: DriveEntry[], handlers: Partial<{
  onOpen: (entry: DriveEntry) => void;
  onContextMenu: (event: React.MouseEvent, entry: DriveEntry) => void;
  onToggleSelection: (entry: DriveEntry) => void;
  selectionMode: boolean;
  selectedIds: Set<string>;
}> = {}) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(createElement(FileCards, {
      entries,
      onSelect: () => undefined,
      onOpen: handlers.onOpen ?? (() => undefined),
      onContextMenu: handlers.onContextMenu ?? (() => undefined),
      onToggleSelection: handlers.onToggleSelection,
      selectionMode: handlers.selectionMode ?? false,
      selectedIds: handlers.selectedIds ?? new Set<string>(),
    }));
  });
  return tree;
}

/** รวมข้อความทั้งหมดที่เรนเดอร์ออกมา */
function textsOf(tree: TestRenderer.ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const item = node as { children?: unknown } | null;
    if (item && typeof item === 'object' && 'children' in item) walk(item.children);
  };
  walk(tree.toJSON());
  return out;
}

function buttonsWithLabel(tree: TestRenderer.ReactTestRenderer, fragment: string): ReactTestInstance[] {
  return tree.root.findAll((node) =>
    node.type === 'button' && typeof node.props['aria-label'] === 'string'
    && (node.props['aria-label'] as string).includes(fragment));
}

describe('F24-C การ์ดรายการไฟล์บนมือถือ', { concurrency: 1 }, () => {
  test('แสดงชื่อไฟล์และข้อมูลประกอบในรายการเดียว', () => {
    const tree = render([entryOf({ name: 'ใบกำกับภาษี.pdf' })]);
    const texts = textsOf(tree).join(' ');
    assert.ok(texts.includes('ใบกำกับภาษี.pdf'), 'ต้องเห็นชื่อไฟล์');
  });

  /**
   * ปุ่มตัวเลือกต้องอยู่ในผลลัพธ์เสมอ ไม่ขึ้นกับการชี้เมาส์
   *
   * นี่คือหัวใจของข้อบกพร่องเดิม การ์ดจึงต้องมีปุ่มนี้ตั้งแต่เรนเดอร์ครั้งแรก
   */
  test('ปุ่มตัวเลือกของแต่ละรายการมีอยู่จริงโดยไม่ต้องชี้เมาส์', () => {
    const tree = render([entryOf({ name: 'รายงาน.xlsx' })]);
    const overflow = buttonsWithLabel(tree, 'ตัวเลือกของ');
    assert.equal(overflow.length, 1);
    assert.ok((overflow[0]!.props['aria-label'] as string).includes('รายงาน.xlsx'),
      'ป้ายกำกับต้องบอกว่าเป็นตัวเลือกของไฟล์ไหน');
  });

  /** ปุ่มตัวเลือกต้องไม่ถูกซ่อนด้วยความโปร่งใสบนมือถือ */
  test('ปุ่มตัวเลือกไม่ถูกซ่อนด้วย opacity', () => {
    const tree = render([entryOf()]);
    const className = String(buttonsWithLabel(tree, 'ตัวเลือกของ')[0]!.props.className ?? '');
    assert.ok(!className.includes('opacity-0'), `ห้ามซ่อน: ${className}`);
    assert.ok(className.includes('h-11') && className.includes('w-11'),
      `ต้องมีขนาดที่นิ้วแตะได้: ${className}`);
  });

  test('กดปุ่มตัวเลือกแล้วเปิดเมนูของรายการนั้น', () => {
    const opened: string[] = [];
    const tree = render([entryOf({ id: 'r9', name: 'สัญญา.docx' })], {
      onContextMenu: (_event, entry) => opened.push(entry.id),
    });
    act(() => {
      buttonsWithLabel(tree, 'ตัวเลือกของ')[0]!.props.onClick({ stopPropagation: () => undefined });
    });
    assert.deepEqual(opened, ['r9']);
  });

  test('แตะที่รายการแล้วเปิดไฟล์', () => {
    const opened: string[] = [];
    const tree = render([entryOf({ id: 'r5' })], { onOpen: (entry) => opened.push(entry.id) });
    const rowButton = tree.root.findAll((node) =>
      node.type === 'button' && String(node.props.className ?? '').includes('min-h-[52px]'))[0]!;
    act(() => { rowButton.props.onClick(); });
    assert.deepEqual(opened, ['r5']);
  });

  /** โฟลเดอร์ต้องอ่านออกว่าเป็นโฟลเดอร์ ไม่ใช่ไฟล์ที่ไม่มีขนาด */
  test('โฟลเดอร์บอกจำนวนรายการแทนขนาด', () => {
    const tree = render([entryOf({ kind: 'folder', name: 'ลูกค้า ก', itemCount: 7, sizeBytes: undefined })]);
    const texts = textsOf(tree).join(' ');
    assert.ok(texts.includes('7 รายการ'), texts);
  });

  /**
   * โหมดเลือกหลายรายการต้องเปิดอย่างชัดแจ้ง
   *
   * ไม่มีช่องติ๊กจนกว่าจะเข้าโหมดเลือก เพื่อไม่ให้แถบช่องติ๊กกินพื้นที่ชื่อไฟล์
   * ตลอดเวลาบนจอที่แคบอยู่แล้ว
   */
  test('ช่องเลือกปรากฏเฉพาะในโหมดเลือกหลายรายการ', () => {
    const plain = render([entryOf()], { onToggleSelection: () => undefined, selectionMode: false });
    assert.equal(plain.root.findAllByType('input').length, 0);

    const selecting = render([entryOf()], { onToggleSelection: () => undefined, selectionMode: true });
    const boxes = selecting.root.findAllByType('input');
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0]!.props.type, 'checkbox');
  });

  test('ในโหมดเลือก การแตะรายการคือการเลือก ไม่ใช่การเปิด', () => {
    const opened: string[] = [];
    const toggled: string[] = [];
    const tree = render([entryOf({ id: 'r3' })], {
      onOpen: (entry) => opened.push(entry.id),
      onToggleSelection: (entry) => toggled.push(entry.id),
      selectionMode: true,
    });
    const rowButton = tree.root.findAll((node) =>
      node.type === 'button' && String(node.props.className ?? '').includes('min-h-[52px]'))[0]!;
    act(() => { rowButton.props.onClick(); });
    assert.deepEqual(toggled, ['r3']);
    assert.deepEqual(opened, [], 'ห้ามเปิดไฟล์ขณะกำลังเลือก');
  });

  /** ชื่อยาวต้องตัดได้ ไม่ดันปุ่มตัวเลือกหลุดออกนอกจอ */
  test('ชื่อไฟล์ยาวถูกจำกัดจำนวนบรรทัดและตัดคำได้', () => {
    const longThai = 'รายงานสรุปผลการดำเนินงานประจำไตรมาสที่สามของปีงบประมาณสองห้าหกแปดฉบับสมบูรณ์.pdf';
    const tree = render([entryOf({ name: longThai })]);
    const nameNode = tree.root.findAll((node) =>
      typeof node.props?.className === 'string' && node.props.className.includes('line-clamp-2'))[0];
    assert.ok(nameNode, 'ชื่อไฟล์ต้องถูกจำกัดจำนวนบรรทัด');
    assert.ok(String(nameNode!.props.className).includes('break-words'),
      'ชื่อไทยยาวที่ไม่มีช่องว่างต้องตัดกลางคำได้ มิฉะนั้นจะดันรายการจนล้นจอ');
  });
});
