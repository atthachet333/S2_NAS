import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { UploadState } from '@/hooks/uploadQueueContext';
import {
  UPLOAD_SUCCESS_AUTO_DISMISS_MS,
  UPLOAD_SWEEP_INTERVAL_MS,
  autoDismissable,
  expiredUploadIds,
  sweepUploadQueue,
  withoutFocusedRow,
} from './upload-queue-policy.ts';

const T0 = 1_000_000;
const row = (id: string, state: UploadState, succeededAt?: number) => ({ id, state, succeededAt });
const later = (ms: number) => T0 + ms;

describe('อายุของแถวในคิวอัปโหลด', () => {
  test('ค่าหน่วงมาจากค่าคงที่ชุดเดียว ไม่กระจายอยู่ตามที่ต่าง ๆ', () => {
    assert.equal(UPLOAD_SUCCESS_AUTO_DISMISS_MS, 15_000);
    assert.ok(UPLOAD_SUCCESS_AUTO_DISMISS_MS >= 10_000 && UPLOAD_SUCCESS_AUTO_DISMISS_MS <= 20_000);
    assert.ok(UPLOAD_SWEEP_INTERVAL_MS < UPLOAD_SUCCESS_AUTO_DISMISS_MS, 'ต้องกวาดถี่กว่าอายุของแถว');
  });

  test('มีเพียงแถวที่สำเร็จเท่านั้นที่หายเองได้', () => {
    assert.equal(autoDismissable('SUCCESS'), true);
    for (const state of ['QUEUED', 'UPLOADING', 'FAILED', 'CANCELLED', 'NEEDS_DECISION'] as UploadState[]) {
      assert.equal(autoDismissable(state), false, `${state} ต้องไม่หายเอง`);
    }
  });

  test('แถวที่สำเร็จยังอยู่ก่อนครบกำหนด และหายเมื่อครบกำหนด', () => {
    const items = [row('a', 'SUCCESS', T0)];
    assert.deepEqual(expiredUploadIds(items, later(14_999)), []);
    assert.deepEqual(expiredUploadIds(items, later(15_000)), ['a']);
    assert.deepEqual(expiredUploadIds(items, later(60_000)), ['a']);
  });

  test('แถวที่สำเร็จแต่ยังไม่มีเวลากำกับ ต้องไม่ถูกลบด้วยการเดา', () => {
    assert.deepEqual(expiredUploadIds([row('a', 'SUCCESS')], later(999_999)), []);
  });
});

describe('สถานะที่ต้องคงอยู่จนกว่าผู้ใช้จะจัดการ', () => {
  test('ล้มเหลวและรอการตัดสินใจไม่หายไปเอง แม้เวลาผ่านไปนาน', () => {
    const items = [
      row('ok', 'SUCCESS', T0),
      row('failed', 'FAILED', T0),
      row('decide', 'NEEDS_DECISION', T0),
      row('cancelled', 'CANCELLED', T0),
    ];
    const { remaining, dismissed, shouldClosePanel } = sweepUploadQueue(items, later(600_000));

    assert.deepEqual(dismissed, ['ok']);
    assert.deepEqual(remaining.map((item) => item.id), ['failed', 'decide', 'cancelled']);
    assert.equal(shouldClosePanel, false, 'แผงต้องเปิดค้างไว้เมื่อยังมีเรื่องให้ผู้ใช้จัดการ');
  });

  test('งานที่ยังทำอยู่ไม่ถูกกวาดทิ้ง', () => {
    const items = [row('q', 'QUEUED'), row('u', 'UPLOADING')];
    assert.deepEqual(sweepUploadQueue(items, later(600_000)).dismissed, []);
  });
});

describe('หลายแถวสำเร็จคนละเวลา', () => {
  test('แต่ละแถวนับอายุจากเวลาสำเร็จของตัวเอง ไม่ยึดแถวใดแถวหนึ่ง', () => {
    const items = [
      row('first', 'SUCCESS', T0),
      row('second', 'SUCCESS', later(5_000)),
      row('third', 'SUCCESS', later(10_000)),
    ];

    // ครบอายุของแถวแรกเท่านั้น
    let result = sweepUploadQueue(items, later(15_000));
    assert.deepEqual(result.dismissed, ['first']);
    assert.deepEqual(result.remaining.map((item) => item.id), ['second', 'third']);
    assert.equal(result.shouldClosePanel, false);

    // ครบอายุของแถวที่สอง
    result = sweepUploadQueue(result.remaining, later(20_000));
    assert.deepEqual(result.dismissed, ['second']);
    assert.equal(result.shouldClosePanel, false);

    // แถวสุดท้ายหมดอายุ - ไม่เหลืออะไรแล้ว
    result = sweepUploadQueue(result.remaining, later(25_000));
    assert.deepEqual(result.dismissed, ['third']);
    assert.equal(result.shouldClosePanel, true, 'แถวสุดท้ายหายแล้วต้องปิดแผง');
  });

  test('แถวที่เสร็จพร้อมกันหายพร้อมกันได้ โดยไม่รบกวนแถวที่ยังไม่ถึงกำหนด', () => {
    const items = [
      row('a', 'SUCCESS', T0),
      row('b', 'SUCCESS', T0),
      row('c', 'SUCCESS', later(9_000)),
    ];
    const result = sweepUploadQueue(items, later(15_000));
    assert.deepEqual(result.dismissed, ['a', 'b']);
    assert.deepEqual(result.remaining.map((item) => item.id), ['c']);
  });
});

describe('การกวาดต้องไม่ทำให้โฟกัสหลุด', () => {
  test('แถวที่กำลังถูกโฟกัสถูกเลื่อนออกไปก่อน ส่วนแถวอื่นยังหายตามกำหนด', () => {
    const items = [row('a', 'SUCCESS', T0), row('b', 'SUCCESS', T0)];
    const result = sweepUploadQueue(items, later(15_000), 'a');

    assert.deepEqual(result.dismissed, ['b']);
    assert.deepEqual(result.remaining.map((item) => item.id), ['a']);
    assert.equal(result.shouldClosePanel, false, 'ยังมีแถวที่โฟกัสอยู่ จึงยังไม่ปิดแผง');
  });

  test('เมื่อโฟกัสย้ายออกแล้ว แถวนั้นจึงหายและแผงจึงปิด', () => {
    const items = [row('a', 'SUCCESS', T0)];
    assert.equal(sweepUploadQueue(items, later(15_000), 'a').dismissed.length, 0);

    const after = sweepUploadQueue(items, later(16_000), null);
    assert.deepEqual(after.dismissed, ['a']);
    assert.equal(after.shouldClosePanel, true);
  });

  test('withoutFocusedRow ปล่อยผ่านเมื่อไม่มีแถวใดถูกโฟกัส', () => {
    assert.deepEqual(withoutFocusedRow(['a', 'b'], null), ['a', 'b']);
    assert.deepEqual(withoutFocusedRow(['a', 'b'], undefined), ['a', 'b']);
    assert.deepEqual(withoutFocusedRow(['a', 'b'], 'b'), ['a']);
  });
});

describe('การกวาดเป็น pure และไม่ทำงานซ้ำกับแถวเดิม', () => {
  test('ไม่แก้ไข array เดิม และคืนค่าเดิมเมื่อไม่มีอะไรหมดอายุ', () => {
    const items = [row('a', 'SUCCESS', T0)];
    const result = sweepUploadQueue(items, later(1_000));
    assert.equal(result.remaining, items, 'ไม่มีอะไรเปลี่ยน ต้องคืน reference เดิมเพื่อไม่ให้ re-render เปล่า ๆ');
    assert.equal(items.length, 1);
  });

  test('กวาดรอบถัดไปบนผลลัพธ์เดิมต้องไม่ลบซ้ำ - แถวหนึ่งถูกจัดการครั้งเดียว', () => {
    const items = [row('a', 'SUCCESS', T0), row('b', 'FAILED', T0)];
    const first = sweepUploadQueue(items, later(15_000));
    assert.deepEqual(first.dismissed, ['a']);

    const second = sweepUploadQueue(first.remaining, later(16_000));
    assert.deepEqual(second.dismissed, [], 'แถวที่ถูกลบไปแล้วต้องไม่ถูกนับซ้ำ');
    assert.equal(second.remaining, first.remaining);
  });
});

describe('ลำดับชั้นการซ้อน', () => {
  const css = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8');
  const token = (name: string): number => {
    const match = css.match(new RegExp(`--z-${name}:\\s*(\\d+)`));
    assert.ok(match, `ต้องมี token --z-${name}`);
    return Number(match![1]);
  };

  test('เมนูคลิกขวาต้องอยู่เหนือคิวอัปโหลดเสมอ', () => {
    assert.ok(token('context') > token('upload'), 'เมนูคลิกขวาต้องชนะแผงคิวอัปโหลด');
  });

  test('ลำดับที่ตกลงไว้: เนื้อหา < drawer < คิวอัปโหลด < คลิกขวา < ไดอะล็อก < toast', () => {
    assert.ok(token('drawer') < token('upload'));
    assert.ok(token('upload') < token('context'));
    assert.ok(token('context') < token('dialog'));
    assert.ok(token('dialog') < token('toast'));
  });

  test('คอมโพเนนต์ใช้ token กลาง ไม่ตั้งเลข z-index เอง', () => {
    const panel = readFileSync(new URL('../components/files/UploadPanel.tsx', import.meta.url), 'utf8');
    const menu = readFileSync(new URL('../components/files/ContextMenu.tsx', import.meta.url), 'utf8');

    assert.ok(panel.includes('z-[var(--z-upload)]'), 'แผงอัปโหลดต้องใช้ token ของตัวเอง');
    assert.ok(!panel.includes('z-[var(--z-dialog)]'), 'แผงอัปโหลดต้องไม่ยืม z ของไดอะล็อกอีก');
    assert.ok(menu.includes('z-[var(--z-context)]'));
    // ห้ามมีตัวเลขดิบ เช่น z-[999]
    assert.ok(!/z-\[\d+\]/.test(panel));
    assert.ok(!/z-\[\d+\]/.test(menu));
  });
});
