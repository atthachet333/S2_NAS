import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BACKUP_STATUS_LABEL,
  OFFSITE_STATE_LABEL,
  OFFSITE_STATE_TONE,
  TRIGGER_LABEL,
  backupBlockedReason,
  formatBackupBytes,
  formatDuration,
  staleWarning,
  validateRetention,
  validateScheduleTime,
  type ScheduleStatus,
} from './backup.ts';

const status = (overrides: Partial<ScheduleStatus> = {}): ScheduleStatus => ({
  enabled: true, time: '02:00', timezone: 'Asia/Bangkok',
  nextRunAt: '2026-09-04T19:00:00.000Z',
  lastScheduledRunAt: null, lastScheduledBackupStatus: null,
  lastSuccessfulBackupAt: '2026-09-03T00:00:00.000Z',
  retentionDays: 30, minimumKeepCount: 7,
  offsiteEnabled: false, offsiteConfigured: false, offsiteReachable: false,
  lastOffsiteVerifiedAt: null, verifiedBackupCount: 1,
  stale: false, staleHours: 48,
  ...overrides,
});

describe('การตรวจค่าตารางเวลาก่อนส่ง', () => {
  test('เวลาที่ถูกต้องผ่าน', () => {
    for (const value of ['00:00', '02:00', '23:59', '13:45']) {
      assert.equal(validateScheduleTime(value), null, `${value} ต้องผ่าน`);
    }
  });

  test('เวลาที่ผิดถูกปฏิเสธพร้อมเหตุผล', () => {
    for (const value of ['25:00', '12:99', 'abc', '2:00', '', '  ', '24:00']) {
      assert.ok(validateScheduleTime(value), `${value} ต้องถูกปฏิเสธ`);
    }
  });

  test('จำนวนวันและขั้นต่ำต้องเป็นจำนวนเต็มบวก', () => {
    assert.equal(validateRetention(30, 7), null);
    assert.ok(validateRetention(0, 7));
    assert.ok(validateRetention(-1, 7));
    assert.ok(validateRetention(1.5, 7));
    assert.ok(validateRetention(30, 0));
    assert.ok(validateRetention(30, -2));
  });
});

describe('คำเตือนชุดสำรองเก่าเกินไป', () => {
  test('ปกติแล้วไม่เตือน', () => {
    assert.equal(staleWarning(status()), null);
    assert.equal(staleWarning(undefined), null);
  });

  test('เก่าเกินกำหนดต้องบอกจำนวนชั่วโมงจริงจากเซิร์ฟเวอร์', () => {
    const warning = staleWarning(status({ stale: true, staleHours: 48 }));
    assert.ok(warning);
    assert.ok(warning!.includes('48'), 'ต้องใช้ค่าที่เซิร์ฟเวอร์ส่งมา ไม่ใช่ค่าที่เขียนตายไว้');
  });

  test('ไม่เคยสำรองสำเร็จเลย ต้องบอกตรง ๆ ไม่ใช่บอกจำนวนชั่วโมง', () => {
    assert.equal(staleWarning(status({ stale: true, lastSuccessfulBackupAt: null })), 'ยังไม่เคยสำรองข้อมูลสำเร็จ');
  });
});

describe('ป้ายชื่อสถานะ', () => {
  test('สถานะสำเนานอกเครื่องครบทุกแบบและอ่านออก', () => {
    for (const state of ['NOT_CONFIGURED', 'PENDING', 'COPYING', 'VERIFIED', 'FAILED'] as const) {
      assert.ok(OFFSITE_STATE_LABEL[state], `${state} ต้องมีป้ายชื่อ`);
      assert.ok(OFFSITE_STATE_TONE[state], `${state} ต้องมีโทนสี`);
    }
    assert.equal(OFFSITE_STATE_TONE.VERIFIED, 'success');
    assert.equal(OFFSITE_STATE_TONE.FAILED, 'danger');
  });

  test('ผู้สั่งงานแยกได้ระหว่างสั่งเองกับตามตาราง', () => {
    assert.equal(TRIGGER_LABEL.MANUAL, 'สั่งเอง');
    assert.equal(TRIGGER_LABEL.SCHEDULED, 'ตามตาราง');
  });

  test('สถานะชุดสำรองมีข้อความภาษาไทยครบ', () => {
    for (const state of ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'] as const) {
      assert.ok(BACKUP_STATUS_LABEL[state]);
    }
  });
});

describe('เหตุผลที่สำรองข้อมูลไม่ได้', () => {
  test('ไม่มีเครื่องมือฐานข้อมูลต้องบอกเหตุผลของเซิร์ฟเวอร์', () => {
    const reason = backupBlockedReason({ toolingAvailable: false, toolingReason: 'ไม่พบ mariadb-dump', busy: false, busyOperation: null });
    assert.equal(reason, 'ไม่พบ mariadb-dump');
  });

  test('ระบบกำลังทำงานอยู่ต้องแยกได้ว่าเป็นงานอะไร', () => {
    assert.ok(backupBlockedReason({ toolingAvailable: true, toolingReason: null, busy: true, busyOperation: 'RESTORE' })?.includes('กู้คืน'));
    assert.ok(backupBlockedReason({ toolingAvailable: true, toolingReason: null, busy: true, busyOperation: 'BACKUP' })?.includes('สำรอง'));
  });

  test('พร้อมใช้งานต้องไม่มีเหตุผลขวาง', () => {
    assert.equal(backupBlockedReason({ toolingAvailable: true, toolingReason: null, busy: false, busyOperation: null }), null);
  });
});

describe('การจัดรูปแบบตัวเลข', () => {
  test('ขนาดไฟล์อ่านออกและไม่มั่วเมื่อไม่มีค่า', () => {
    assert.equal(formatBackupBytes(null), '—');
    assert.equal(formatBackupBytes(0), '0 B');
    assert.equal(formatBackupBytes(1024), '1.0 KB');
  });

  test('ระยะเวลาอ่านออกตามหน่วยที่เหมาะสม', () => {
    assert.equal(formatDuration(null), '—');
    assert.ok(formatDuration(500).includes('มิลลิวินาที'));
    assert.ok(formatDuration(5000).includes('วินาที'));
    assert.ok(formatDuration(125_000).includes('นาที'));
  });
});
