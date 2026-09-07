import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LIFECYCLE_LABELS, blockedDeleteReason, retentionBadge } from './lifecycle.js';
import { trashCountdown } from './trash-countdown.js';
import { activeChips, filtersFromParams, paramsFromFilters } from './search-filters.js';

/**
 * F16 - วงจรชีวิตเอกสารฝั่งหน้าจอ
 *
 * สิ่งที่ต้องรับประกันที่สุด: **ไม่แสดงเวลานับถอยหลังที่ไม่มีวันเกิดขึ้นจริง**
 * ผู้ใช้ที่เห็น "เหลือ 3 วัน" กับเอกสารที่ระบบไม่มีวันลบ จะไปกู้คืนเอกสารโดยไม่จำเป็น
 * หรือแย่กว่านั้นคือเชื่อว่าเอกสารสำคัญกำลังจะหายและตัดสินใจผิด
 */

const NOW = new Date('2026-09-05T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const future = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();
const past = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

describe('F16 วงจรชีวิตเอกสาร', () => {
  describe('ป้ายสถานะการเก็บรักษา', () => {
    test('การระงับการลบมาก่อนเสมอ', () => {
      const badge = retentionBadge(
        { onLegalHold: true, retentionForever: true, retentionUntil: future(100) },
        NOW,
      );
      assert.equal(badge?.tone, 'hold');
      assert.equal(badge?.label, 'ระงับการลบ');
    });

    test('เก็บถาวรมาก่อนวันหมดอายุ', () => {
      const badge = retentionBadge({ retentionForever: true, retentionUntil: future(10) }, NOW);
      assert.equal(badge?.tone, 'forever');
    });

    test('บอกวันที่เก็บถึงเมื่อยังไม่หมดอายุ', () => {
      const badge = retentionBadge({ retentionUntil: future(30) }, NOW);
      assert.equal(badge?.tone, 'active');
      assert.match(badge!.label, /เก็บถึง/);
    });

    test('หมดอายุแล้วบอกตามจริง - ไม่ได้แปลว่าถูกลบแล้ว', () => {
      const badge = retentionBadge({ retentionUntil: past(1) }, NOW);
      assert.equal(badge?.tone, 'expired');
      assert.equal(badge?.label, 'หมดอายุการเก็บรักษา');
    });

    test('เอกสารที่ไม่มีนโยบายไม่มีป้าย - ไม่เติมให้รก', () => {
      assert.equal(retentionBadge({}, NOW), null);
      assert.equal(retentionBadge({ retentionForever: false, retentionUntil: null }, NOW), null);
    });
  });

  describe('เวลานับถอยหลังในถังขยะ', () => {
    test('เอกสารที่ถูกระงับการลบไม่แสดงเวลานับถอยหลัง', () => {
      const countdown = trashCountdown(future(3), NOW, { onLegalHold: true });
      assert.equal(countdown?.protectedFromPurge, true);
      assert.equal(countdown?.label, 'ระงับการลบ');
      assert.equal(countdown?.remainingDays, null);
      assert.notEqual(countdown?.urgency, 'RED', 'เอกสารที่ไม่มีวันถูกลบต้องไม่ขึ้นป้ายเร่งด่วน');
    });

    test('เก็บถาวรไม่แสดงเวลานับถอยหลัง', () => {
      const countdown = trashCountdown(future(1), NOW, { retentionForever: true });
      assert.equal(countdown?.protectedFromPurge, true);
      assert.match(countdown!.label, /เก็บถาวร/);
    });

    test('นโยบายที่ยังไม่หมด บอกวันของนโยบาย ไม่ใช่วันของถังขยะ', () => {
      // ถังขยะหมดพรุ่งนี้ แต่ต้องเก็บตามนโยบายอีกร้อยวัน
      const countdown = trashCountdown(future(1), NOW, { retentionUntil: future(100) });
      assert.equal(countdown?.protectedFromPurge, true);
      assert.match(countdown!.label, /เก็บตามนโยบายถึง/);
      assert.equal(
        countdown!.label.includes('เหลือ 1 วัน'),
        false,
        'ต้องไม่บอกเวลาถังขยะที่ไม่มีผลจริง',
      );
    });

    test('นโยบายหมดอายุแล้ว กลับไปนับถอยหลังตามถังขยะตามปกติ', () => {
      const countdown = trashCountdown(future(5), NOW, { retentionUntil: past(1) });
      assert.equal(countdown?.protectedFromPurge, undefined);
      assert.equal(countdown?.remainingDays, 5);
    });

    test('เอกสารธรรมดายังนับถอยหลังเหมือนเดิม - ไม่ทำให้พฤติกรรมเดิมเพี้ยน', () => {
      const countdown = trashCountdown(future(5), NOW);
      assert.equal(countdown?.remainingDays, 5);
      assert.equal(countdown?.label, 'เหลือ 5 วัน');
      assert.equal(countdown?.protectedFromPurge, undefined);
    });
  });

  describe('เหตุผลที่ลบถาวรไม่ได้', () => {
    test('แต่ละเหตุมีข้อความของตัวเอง และไม่บอกรายละเอียดของการระงับ', () => {
      assert.match(blockedDeleteReason({ kind: 'LEGAL_HOLD' })!, /Legal Hold/);
      assert.match(blockedDeleteReason({ kind: 'RETAIN_FOREVER' })!, /ไม่มีกำหนด/);
      assert.match(
        blockedDeleteReason({ kind: 'RETENTION_ACTIVE', until: future(30) })!,
        /ลบถาวรไม่ได้จนถึง/,
      );
      assert.equal(blockedDeleteReason(null), null);
    });
  });

  describe('ตัวกรองวงจรชีวิตบน URL', () => {
    test('เขียนลงและอ่านกลับได้ครบ', () => {
      const filters = {
        lifecycleState: 'ARCHIVED',
        retentionStatus: 'EXPIRING',
        retentionPolicyId: 'pol-1',
        legalHoldOnly: true,
      };
      const restored = filtersFromParams(paramsFromFilters('', filters));
      assert.deepEqual(restored, filters);
    });

    test('ป้ายตัวกรองเป็นภาษาไทย ไม่ใช่ชื่อค่าในฐานข้อมูล', () => {
      const labels = activeChips({
        lifecycleState: 'ARCHIVED',
        retentionStatus: 'EXPIRED',
        legalHoldOnly: true,
      })
        .map((chip) => chip.label)
        .join(' | ');

      assert.ok(labels.includes('เก็บเข้าคลัง'));
      assert.ok(labels.includes('หมดอายุการเก็บรักษา'));
      assert.ok(labels.includes('ระงับการลบ'));
      assert.equal(labels.includes('ARCHIVED'), false);
      assert.equal(labels.includes('EXPIRED'), false);
    });
  });

  test('ป้ายสถานะวงจรชีวิตไม่ใช้คำว่า "ลบ" - คลังไม่ใช่ถังขยะ', () => {
    assert.equal(LIFECYCLE_LABELS.ARCHIVED, 'เก็บเข้าคลัง');
    assert.equal(LIFECYCLE_LABELS.ARCHIVED.includes('ลบ'), false);
  });
});
