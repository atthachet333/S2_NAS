import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SmartFilingTargetDialog } from './SmartFilingTargetDialog.tsx';

/**
 * กล่องเลือกปลายทางต้องบอกชื่อปลายทางที่แท้จริง (F22-F10)
 *
 * **เหตุผลที่ชุดนี้มีอยู่:** เดิมปุ่ม "ใช้โฟลเดอร์นี้" ส่งป้ายกลาง ๆ ว่า "โฟลเดอร์ที่เลือก"
 * ขั้นยืนยันจึงถามว่า "ย้ายเอกสารนี้ไปที่: โฟลเดอร์ที่เลือก" ซึ่งไม่ได้บอกอะไรเลย
 * ผู้ใช้ยืนยันการย้ายโดยไม่เห็นปลายทาง เป็นความผิดพลาดที่แก้กลับยากเมื่อเกิดแล้ว
 *
 * ไม่ต่อเน็ตจริง - ใส่เส้นทางลง query cache โดยตรงแล้วตรวจค่าที่ส่งออกจากปุ่ม
 */

function render(seedCrumbs: boolean): { tree: ReactTestRenderer; selected: Array<{ folderId: string; label: string }> } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  if (seedCrumbs) {
    client.setQueryData(['smart-filing-target-crumbs', 'f1'], {
      data: [{ id: 'root1', name: 'ลูกค้า' }, { id: 'f1', name: '1. อัลฟ่า' }],
    });
  }
  const selected: Array<{ folderId: string; label: string }> = [];
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(createElement(QueryClientProvider, { client },
      createElement(SmartFilingTargetDialog, {
        resourceId: 'r1', currentParentId: 'f1',
        onSelect: (target) => { selected.push(target); },
        onClose: () => {},
      })));
  });
  return { tree, selected };
}

/** ข้อความทั้งหมดที่อยู่ใต้โหนดหนึ่ง - JSX แยกข้อความเป็นหลายโหนด จึงต้องเดินเก็บเอง */
function textOf(children: unknown): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(textOf).join('');
  return '';
}

function useThisFolderButton(tree: ReactTestRenderer) {
  return tree.root.findAll((node) => node.type === 'button'
    && textOf(node.props.children).includes('ใช้โฟลเดอร์นี้'))[0]!;
}

describe('F22 smart filing target dialog', { concurrency: 1 }, () => {
  /** ปลายทางที่ส่งต่อไปขั้นยืนยันต้องเป็นเส้นทางจริง ไม่ใช่ป้ายกลาง ๆ */
  test('the chosen destination is handed on by its real path', () => {
    const { tree, selected } = render(true);
    act(() => { useThisFolderButton(tree).props.onClick(); });
    assert.equal(selected.length, 1);
    assert.equal(selected[0]!.folderId, 'f1');
    assert.match(selected[0]!.label, /1\. อัลฟ่า/u);
    assert.doesNotMatch(selected[0]!.label, /^โฟลเดอร์ที่เลือก$/u);
  });

  /**
   * ยังไม่รู้เส้นทางก็ยังยืนยันไม่ได้
   *
   * ปล่อยให้กดได้ระหว่างที่เส้นทางยังโหลดไม่เสร็จ จะได้ขั้นยืนยันที่ไม่มีชื่อปลายทางอีกแบบหนึ่ง
   */
  test('the confirm button stays disabled until the path is known', () => {
    const { tree, selected } = render(false);
    assert.equal(useThisFolderButton(tree).props.disabled, true);
    assert.equal(selected.length, 0);
  });
});
