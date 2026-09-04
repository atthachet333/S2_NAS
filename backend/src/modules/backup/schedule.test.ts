import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decideScheduledRun,
  isBackupStale,
  nextRunAt,
  parseTimeOfDay,
  scheduledInstantFor,
  zonedDateKey,
  type ScheduleConfig,
} from './schedule-policy.ts';
import { planRetention, type RetentionCandidate } from './retention-policy.ts';
import { timeOfDaySchema } from '../system/settings.service.js';

/**
 * กติกาเวลาและนโยบายเก็บ
 *
 * ทั้งหมดเป็นฟังก์ชันบริสุทธิ์และรับเวลาเข้ามา จึงไม่มีเทสใดพึ่งนาฬิกาจริง
 * เวลาทดสอบข้ามวันหรือข้ามโซนเวลาได้ทันทีโดยไม่ต้องรอ
 */
const BKK: ScheduleConfig = { enabled: true, time: '02:00', timezone: 'Asia/Bangkok' };
const GRACE = 6;

/** Asia/Bangkok = UTC+7 ตลอดปี ดังนั้น 02:00 ที่กรุงเทพ = 19:00 UTC ของวันก่อนหน้า */
const bangkok0200 = (isoDate: string) => new Date(`${isoDate}T02:00:00+07:00`);

describe('เวลาสำรองข้อมูล', () => {
  test('รูปแบบเวลาที่ยอมรับและปฏิเสธ', () => {
    assert.deepEqual(parseTimeOfDay('02:00'), { hour: 2, minute: 0 });
    assert.deepEqual(parseTimeOfDay('23:59'), { hour: 23, minute: 59 });
    for (const bad of ['25:00', '12:99', 'abc', '2:00', '02:0', '', '24:00', '-1:00']) {
      assert.equal(timeOfDaySchema.safeParse(bad).success, false, `${bad} ต้องถูกปฏิเสธ`);
      assert.throws(() => parseTimeOfDay(bad));
    }
  });

  test('ตีความเวลาตามโซนเวลาที่ตั้งไว้ ไม่ใช่ UTC', () => {
    const instant = scheduledInstantFor('2026-09-03', BKK);
    assert.equal(instant.toISOString(), '2026-09-02T19:00:00.000Z', '02:00 ที่กรุงเทพคือ 19:00 UTC ของวันก่อน');

    // โซนเวลาอื่นต้องให้ผลต่างกันจริง ไม่ใช่คำนวณเป็น UTC เหมือนกันหมด
    const utc = scheduledInstantFor('2026-09-03', { ...BKK, timezone: 'UTC' });
    assert.equal(utc.toISOString(), '2026-09-03T02:00:00.000Z');
    assert.notEqual(instant.getTime(), utc.getTime());
  });

  test('วันตามโซนเวลาไม่ใช่วันตาม UTC', () => {
    // 20:00 UTC = ตีสามของวันถัดไปที่กรุงเทพ
    const instant = new Date('2026-09-03T20:00:00.000Z');
    assert.equal(zonedDateKey(instant, 'UTC'), '2026-09-03');
    assert.equal(zonedDateKey(instant, 'Asia/Bangkok'), '2026-09-04');
  });

  test('รอบถัดไปคือวันนี้ถ้ายังไม่ถึงเวลา และพรุ่งนี้ถ้าเลยแล้ว', () => {
    const before = new Date('2026-09-03T00:00:00+07:00');
    assert.equal(nextRunAt(before, BKK).toISOString(), bangkok0200('2026-09-03').toISOString());

    const after = new Date('2026-09-03T03:00:00+07:00');
    assert.equal(nextRunAt(after, BKK).toISOString(), bangkok0200('2026-09-04').toISOString());
  });

  test('ข้ามเดือนและข้ามปีคำนวณถูกต้อง', () => {
    const endOfYear = new Date('2026-12-31T23:00:00+07:00');
    assert.equal(nextRunAt(endOfYear, BKK).toISOString(), bangkok0200('2027-01-01').toISOString());
  });
});

describe('ตัดสินใจว่าจะสำรองตอนนี้หรือไม่', () => {
  const noRunYet = { lastScheduledRunDate: null };

  test('ปิดตารางเวลาแล้วต้องไม่ทำงาน', () => {
    const decision = decideScheduledRun(bangkok0200('2026-09-03'), { ...BKK, enabled: false }, noRunYet, GRACE);
    assert.deepEqual(decision, { action: 'SKIP', reason: 'DISABLED' });
  });

  test('ยังไม่ถึงเวลา ต้องไม่ทำงาน', () => {
    const decision = decideScheduledRun(new Date('2026-09-03T01:30:00+07:00'), BKK, noRunYet, GRACE);
    assert.equal(decision.action, 'SKIP');
    assert.equal(decision.reason, 'NOT_DUE');
  });

  test('ถึงเวลาพอดี ต้องทำงาน', () => {
    const decision = decideScheduledRun(bangkok0200('2026-09-03'), BKK, noRunYet, GRACE);
    assert.equal(decision.action, 'RUN');
    assert.equal(decision.reason, 'DUE');
  });

  test('วันนี้ทำไปแล้ว ต้องไม่ทำซ้ำ - นี่คือด่านกันงานซ้ำหลังรีสตาร์ท', () => {
    const decision = decideScheduledRun(
      new Date('2026-09-03T05:00:00+07:00'),
      BKK,
      { lastScheduledRunDate: '2026-09-03' },
      GRACE,
    );
    assert.equal(decision.action, 'SKIP');
    assert.equal(decision.reason, 'ALREADY_RAN_TODAY');
  });

  test('เซิร์ฟเวอร์กลับมาไม่นานหลังพลาดเวลา ต้องตามเก็บหนึ่งครั้ง', () => {
    const decision = decideScheduledRun(new Date('2026-09-03T05:00:00+07:00'), BKK, noRunYet, GRACE);
    assert.equal(decision.action, 'RUN');
    assert.equal(decision.reason, 'CATCH_UP');
  });

  test('พลาดมานานเกินช่วงผ่อนผัน ต้องรอรอบถัดไป ไม่สำรองย้อนหลัง', () => {
    const decision = decideScheduledRun(new Date('2026-09-03T20:00:00+07:00'), BKK, noRunYet, GRACE);
    assert.equal(decision.action, 'SKIP');
    assert.equal(decision.reason, 'MISSED_TOO_LONG');
  });

  test('สองรอบติดกันในนาทีเดียวกัน ทำงานได้เพียงครั้งเดียว', () => {
    const now = bangkok0200('2026-09-03');
    const first = decideScheduledRun(now, BKK, noRunYet, GRACE);
    assert.equal(first.action, 'RUN');

    // หลังรอบแรกสำเร็จ วันนั้นถูกบันทึกแล้ว รอบที่สองต้องถูกปฏิเสธ
    const second = decideScheduledRun(now, BKK, { lastScheduledRunDate: '2026-09-03' }, GRACE);
    assert.equal(second.action, 'SKIP');
    assert.equal(second.reason, 'ALREADY_RAN_TODAY');
  });

  test('วันถัดไปทำงานอีกครั้งตามปกติ', () => {
    const decision = decideScheduledRun(
      bangkok0200('2026-09-04'),
      BKK,
      { lastScheduledRunDate: '2026-09-03' },
      GRACE,
    );
    assert.equal(decision.action, 'RUN');
  });
});

describe('คำเตือนชุดสำรองเก่าเกินไป', () => {
  const now = new Date('2026-09-03T12:00:00Z');

  test('ไม่เคยสำรองเลยถือว่าเก่าเกินไป', () => {
    assert.equal(isBackupStale(null, now, 48), true);
  });

  test('สำรองล่าสุดภายในกำหนดถือว่าปกติ', () => {
    assert.equal(isBackupStale(new Date('2026-09-03T00:00:00Z'), now, 48), false);
  });

  test('เกินกำหนดต้องเตือน', () => {
    assert.equal(isBackupStale(new Date('2026-08-30T00:00:00Z'), now, 48), true);
  });
});

describe('นโยบายเก็บชุดสำรอง', () => {
  const now = new Date('2026-09-30T00:00:00Z');
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const backup = (id: string, days: number, status: RetentionCandidate['status'] = 'COMPLETED'): RetentionCandidate => ({
    id, status, startedAt: daysAgo(days),
  });
  const policy = { retentionDays: 30, minimumKeepCount: 7 };

  test('ชุดที่ยังไม่เกินกำหนดต้องไม่ถูกลบ', () => {
    const backups = Array.from({ length: 10 }, (_, index) => backup(`b${index}`, index));
    assert.deepEqual(planRetention(backups, policy, now).deletable, []);
  });

  test('ชุดที่เกินกำหนดถูกลบ โดยลบตัวเก่าที่สุดก่อน', () => {
    const backups = [
      backup('oldest', 100), backup('older', 90), backup('old', 80),
      ...Array.from({ length: 7 }, (_, index) => backup(`fresh${index}`, index)),
    ];
    const plan = planRetention(backups, policy, now);
    assert.deepEqual(plan.deletable, ['oldest', 'older', 'old'], 'ต้องเรียงจากเก่าที่สุด');
  });

  test('จำนวนขั้นต่ำต้องถูกเคารพ แม้ทุกชุดจะเก่ากว่ากำหนด', () => {
    const backups = Array.from({ length: 10 }, (_, index) => backup(`b${index}`, 100 + index));
    const plan = planRetention(backups, policy, now);
    assert.equal(plan.deletable.length, 3, 'เหลือไว้ 7 ชุดตามขั้นต่ำ');
    assert.equal(plan.keptForMinimum, 7);
  });

  test('มีน้อยกว่าขั้นต่ำ ต้องไม่ลบอะไรเลย', () => {
    const backups = Array.from({ length: 5 }, (_, index) => backup(`b${index}`, 100 + index));
    assert.deepEqual(planRetention(backups, policy, now).deletable, []);
  });

  test('ชุดที่ใช้ได้ชุดสุดท้ายต้องไม่ถูกลบ แม้ตั้งขั้นต่ำเป็นศูนย์', () => {
    const backups = [backup('only', 999)];
    const plan = planRetention(backups, { retentionDays: 1, minimumKeepCount: 0 }, now);
    assert.deepEqual(plan.deletable, [], 'ต้องเหลือชุดที่ใช้ได้อย่างน้อยหนึ่งชุดเสมอ');
  });

  test('งานที่กำลังทำอยู่และชุดที่ล้มเหลวไม่ใช่เป้าหมายของนโยบายนี้', () => {
    const backups = [
      backup('running', 100, 'RUNNING'),
      backup('pending', 100, 'PENDING'),
      backup('failed', 100, 'FAILED'),
      ...Array.from({ length: 8 }, (_, index) => backup(`done${index}`, 100 + index)),
    ];
    const plan = planRetention(backups, policy, now);
    for (const id of ['running', 'pending', 'failed']) {
      assert.ok(!plan.deletable.includes(id), `${id} ต้องไม่ถูกลบอัตโนมัติ`);
    }
    assert.equal(plan.deletable.length, 1, 'ลบได้เฉพาะส่วนที่เกินขั้นต่ำของชุดที่สำเร็จ');
  });

  test('ไม่มีชุดสำรองเลย ต้องไม่พัง', () => {
    assert.deepEqual(planRetention([], policy, now).deletable, []);
  });
});
