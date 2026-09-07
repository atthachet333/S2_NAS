import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ACTOR_TYPE_LABELS,
  AUDIT_FILTER_KEYS,
  auditChips,
  auditFiltersFromParams,
  auditParamsFromFilters,
  resolveDatePreset,
  resourceLabel,
  type AuditFilters,
} from './audit.ts';

/**
 * F17 - ตัวกรองของเครื่องมือตรวจสอบต้องเดินทางไปกับ URL ได้
 *
 * ผู้ตรวจสอบทำงานด้วยการส่งลิงก์ให้กัน ("ดูช่วงนี้สิ")
 * ถ้าตัวกรองอยู่แค่ในหน่วยความจำของหน้าจอ ลิงก์ที่ส่งไปจะเปิดมาเป็นหน้าเปล่า
 * และคนสองคนจะคุยกันคนละเรื่องโดยที่ทั้งคู่คิดว่าดูข้อมูลชุดเดียวกัน
 */
describe('F17 ตัวกรองของเครื่องมือตรวจสอบ', () => {
  test('ตัวกรองทุกตัวเดินทางไป-กลับผ่าน URL ได้ครบ', () => {
    const filters: AuditFilters = {
      q: 'สมชาย',
      action: 'RESOURCE_DELETED',
      category: 'GOVERNANCE',
      preset: 'destructive',
      actorId: 'usr_1',
      actorType: 'INTERNAL',
      resourceId: 'res_1',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
      failuresOnly: true,
    };

    const restored = auditFiltersFromParams(auditParamsFromFilters(filters));
    assert.deepEqual(restored, filters);

    // ครบทุกคีย์ที่ประกาศไว้ - ถ้ามีคนเพิ่มตัวกรองใหม่แล้วลืมทดสอบ ตรงนี้จะฟ้อง
    for (const key of AUDIT_FILTER_KEYS) {
      assert.ok(key in restored, `ตัวกรอง ${key} หายไประหว่างเดินทางผ่าน URL`);
    }
  });

  test('ค่าที่ว่างไม่ถูกเขียนลง URL', () => {
    const params = auditParamsFromFilters({ q: '', failuresOnly: false, action: 'LOGIN' });
    assert.equal(params.get('q'), null);
    assert.equal(params.get('failuresOnly'), null);
    assert.equal(params.get('action'), 'LOGIN');
  });

  /**
   * ช่วงวันที่สำเร็จรูปต้องกลายเป็นวันที่จริงก่อนลง URL
   * ไม่เช่นนั้นลิงก์ที่ส่งต่อจะหมายถึง "7 วันล่าสุด" ของวันที่เปิด ซึ่งเป็นคนละหลักฐาน
   */
  test('ช่วงเวลาสำเร็จรูปถูกแปลงเป็นวันที่จริง', () => {
    const now = new Date(2026, 8, 7, 13, 45);

    assert.equal(resolveDatePreset('today', now).from, new Date(2026, 8, 7).toISOString());
    assert.equal(resolveDatePreset('last7', now).from, new Date(2026, 8, 1).toISOString());
    assert.equal(resolveDatePreset('last30', now).from, new Date(2026, 7, 9).toISOString());
    assert.equal(resolveDatePreset('thisMonth', now).from, new Date(2026, 8, 1).toISOString());
    assert.equal(resolveDatePreset('', now).from, undefined);
  });

  test('ป้ายตัวกรองแสดงชื่อที่อ่านออก ไม่ใช่รหัสดิบ', () => {
    const chips = auditChips(
      { action: 'RESOURCE_DELETED', category: 'GOVERNANCE', actorType: 'EXTERNAL', failuresOnly: true },
      {
        categories: new Map([['GOVERNANCE', 'การกำกับดูแล']]),
        events: new Map([['RESOURCE_DELETED', 'ลบทรัพยากร']]),
      },
    );
    const labels = chips.map((chip) => chip.label);

    assert.ok(labels.includes('ลบทรัพยากร'), 'รหัสเหตุการณ์ต้องถูกแปลเป็นภาษาไทย');
    assert.ok(labels.includes('การกำกับดูแล'));
    assert.ok(labels.includes(ACTOR_TYPE_LABELS.EXTERNAL));
    assert.ok(labels.includes('เฉพาะที่ล้มเหลว/ถูกปฏิเสธ'));
    assert.ok(!labels.some((label) => label.includes('RESOURCE_DELETED')), 'ต้องไม่มีรหัสดิบโผล่ในป้าย');

    // ป้ายทุกใบต้องรู้ว่าตัวเองล้างตัวกรองไหน ไม่งั้นกดปิดแล้วไม่มีอะไรเกิดขึ้น
    for (const chip of chips) {
      assert.ok(AUDIT_FILTER_KEYS.includes(chip.key as (typeof AUDIT_FILTER_KEYS)[number]));
    }
  });

  test('ชุดสำเร็จรูป "ทั้งหมด" ไม่ต้องมีป้าย', () => {
    assert.equal(auditChips({ preset: 'all' }).length, 0);
  });

  /** เหตุการณ์เก่ายังต้องอ่านรู้เรื่องแม้ทรัพยากรจะถูกลบไปแล้ว */
  test('ทรัพยากรที่ถูกลบยังมีข้อความบอกสถานะ', () => {
    assert.equal(resourceLabel({ name: null, deleted: true }), 'ทรัพยากรถูกลบแล้ว');
    assert.equal(resourceLabel({ name: 'สัญญา 2569.pdf', deleted: false }), 'สัญญา 2569.pdf');
    assert.equal(resourceLabel(null), null);
  });
});
