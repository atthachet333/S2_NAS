import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FolderPicker } from './FolderPicker.tsx';
import type { DriveRoot } from '@/lib/drive-labels';

/**
 * ตัวเลือกโฟลเดอร์ปลายทางต้องพูดภาษาเดียวกับที่อื่นในระบบ
 *
 * เดิมที่นี่ใช้คำว่า "รากองค์กร" ซึ่งเป็นชื่อที่สามของรากไดร์ฟ ทำให้ผู้ใช้เข้าใจไม่ตรงกัน
 * ชุดทดสอบนี้กันไม่ให้ชื่อนั้นกลับมา และยืนยันว่าสองไดร์ฟถูกแยกจากกันชัดเจน
 */
function renderPicker(
  overrides: Partial<Parameters<typeof FolderPicker>[0]> = {},
): { tree: ReactTestRenderer; texts: string[] } {
  // ไม่ต่อเน็ตจริง: query ค้างที่สถานะกำลังโหลด ส่วนที่ทดสอบเป็นโครงที่เรนเดอร์เสมออยู่แล้ว
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, queryFn: () => new Promise(() => {}) } },
  });

  const props = {
    value: null,
    onChange: () => undefined,
    driveRoot: 'MY_DRIVE' as DriveRoot,
    onDriveRootChange: () => undefined,
    selectableDriveRoots: ['MY_DRIVE', 'SYSTEM_DRIVE'] as DriveRoot[],
    ...overrides,
  };

  let tree!: ReactTestRenderer;
  TestRenderer.act(() => {
    tree = TestRenderer.create(
      createElement(QueryClientProvider, { client }, createElement(FolderPicker, props)),
    );
  });

  const texts: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === 'string') { texts.push(node); return; }
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (node && typeof node === 'object' && 'children' in node) {
      collect((node as { children: unknown }).children);
    }
  };
  collect(tree.toJSON());
  return { tree, texts };
}

describe('FolderPicker สองไดร์ฟ', () => {
  test('ไม่มีคำว่า "รากองค์กร" หลงเหลืออยู่', () => {
    const { texts } = renderPicker();
    assert.ok(!texts.some((text) => text.includes('รากองค์กร')), 'ต้องไม่ใช้ชื่อที่สามสำหรับรากไดร์ฟ');
  });

  test('แสดงชื่อรากของทั้งสองไดร์ฟ ไม่รวมเป็นรายการเดียวที่กำกวม', () => {
    const { texts } = renderPicker();
    assert.ok(texts.includes('ไดร์ฟของฉัน'));
    assert.ok(texts.includes('ไดร์ฟของระบบ'));
  });

  test('ผู้ที่มีสิทธิ์เลือกไดร์ฟของระบบเป็นปลายทางได้', () => {
    const { tree } = renderPicker();
    const systemTab = tree.root
      .findAllByType('button')
      .find((node) => node.props.children?.some?.((child: unknown) => child === 'ไดร์ฟของระบบ'));
    assert.ok(systemTab, 'ต้องมีปุ่มเลือกไดร์ฟของระบบ');
    assert.equal(systemTab!.props.disabled, false);
  });

  test('ผู้ที่ไม่มีสิทธิ์ข้ามไดร์ฟ เลือกไดร์ฟของระบบไม่ได้ และมีเหตุผลกำกับ', () => {
    const { tree } = renderPicker({ selectableDriveRoots: ['MY_DRIVE'] });
    const systemTab = tree.root
      .findAllByType('button')
      .find((node) => node.props.children?.some?.((child: unknown) => child === 'ไดร์ฟของระบบ'));
    assert.equal(systemTab!.props.disabled, true);
    assert.equal(systemTab!.props.title, 'การย้ายข้ามไดร์ฟสงวนไว้สำหรับผู้ดูแลระบบ');
  });

  test('ปลายทางที่รากแสดงเป็นชื่อไดร์ฟ และตำแหน่งปัจจุบันเป็นเส้นทางเชิงตรรกะ', () => {
    const { texts } = renderPicker({
      driveRoot: 'SYSTEM_DRIVE',
      currentDriveRoot: 'MY_DRIVE',
      currentLocationSegments: ['TEST'],
    });
    assert.ok(texts.includes('ตำแหน่งปัจจุบัน'));
    assert.ok(texts.includes('ไดร์ฟของฉัน / TEST'), 'ตำแหน่งปัจจุบันต้องเป็นเส้นทางเชิงตรรกะ');
    assert.ok(texts.includes('ปลายทาง'));
  });

  test('ปลายทางเดียวกับตำแหน่งเดิมถูกกำกับว่าเป็นตำแหน่งเดิม', () => {
    const { texts } = renderPicker({
      value: null,
      driveRoot: 'MY_DRIVE',
      currentDriveRoot: 'MY_DRIVE',
      currentParentId: null,
    });
    assert.ok(texts.includes(' (ตำแหน่งเดิม)'), 'ต้องบอกผู้ใช้ว่าเลือกตำแหน่งเดิมอยู่');
  });

  test('รากของคนละไดร์ฟไม่ถือว่าเป็นตำแหน่งเดิม แม้ parentId จะเป็น null เหมือนกัน', () => {
    const { texts } = renderPicker({
      value: null,
      driveRoot: 'SYSTEM_DRIVE',
      currentDriveRoot: 'MY_DRIVE',
      currentParentId: null,
    });
    assert.ok(!texts.includes(' (ตำแหน่งเดิม)'));
  });

  test('ไม่เปิดเผยเส้นทางจริงบนดิสก์', () => {
    const { texts } = renderPicker({ currentLocationSegments: ['TEST'] });
    const all = texts.join(' ');
    assert.ok(!all.includes('storage'));
    assert.ok(!all.includes('S2_NAS_STORAGE_ROOT'));
    assert.ok(!all.includes(String.fromCharCode(92)));
  });
});
