import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  accountTypeLabel,
  expiryLabel,
  expiryToIso,
  homePathFor,
  INTERNAL_HOME,
  isExpired,
  isExternalAccount,
  isPortalPath,
  PORTAL_HOME,
  PORTAL_LEVELS,
} from './portal.ts';

const NOW = new Date('2026-09-04T09:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('การแยกฝั่งของผู้ใช้', () => {
  test('รู้จักบัญชีลูกค้าจากชนิดบัญชีเท่านั้น', () => {
    assert.equal(isExternalAccount({ type: 'EXTERNAL' }), true);
    assert.equal(isExternalAccount({ type: 'INTERNAL' }), false);
    assert.equal(isExternalAccount({ type: 'SERVICE' }), false);
  });

  test('ไม่รู้ชนิดบัญชี = ถือว่าเป็นภายใน ไม่ใช่ภายนอก', () => {
    // เดาผิดทางนี้ทำให้พนักงานเห็นหน้าลูกค้าชั่วครู่ ซึ่งดีกว่าเดาผิดอีกทาง
    assert.equal(isExternalAccount(null), false);
    assert.equal(isExternalAccount(undefined), false);
    assert.equal(isExternalAccount({}), false);
  });

  test('รู้จักเส้นทางของพื้นที่ลูกค้า', () => {
    assert.equal(isPortalPath('/portal'), true);
    assert.equal(isPortalPath('/portal/folders/abc'), true);
    assert.equal(isPortalPath('/dashboard'), false);
    // ต้องไม่จับ prefix ผิด เช่นเส้นทางที่ขึ้นต้นคล้ายกันแต่คนละหน้า
    assert.equal(isPortalPath('/portal-admin'), false);
  });
});

describe('ปลายทางหลังเข้าสู่ระบบ', () => {
  test('ลูกค้าไปที่พื้นที่เอกสารเสมอ', () => {
    assert.equal(homePathFor({ type: 'EXTERNAL' }), PORTAL_HOME);
  });

  test('บุคลากรภายในไปที่หน้าทำงานภายในเสมอ', () => {
    assert.equal(homePathFor({ type: 'INTERNAL' }), INTERNAL_HOME);
  });

  test('ลูกค้าที่ถือลิงก์ของหน้าภายในถูกพากลับมาที่พื้นที่ลูกค้า', () => {
    assert.equal(homePathFor({ type: 'EXTERNAL' }, '/admin/users'), PORTAL_HOME);
    assert.equal(homePathFor({ type: 'EXTERNAL' }, '/system-drive'), PORTAL_HOME);
  });

  test('ลูกค้าที่ถือลิงก์ของพื้นที่ลูกค้าได้ไปยังหน้านั้นจริง', () => {
    assert.equal(homePathFor({ type: 'EXTERNAL' }, '/portal/folders/abc'), '/portal/folders/abc');
  });

  test('บุคลากรภายในไม่ถูกพาเข้าไปในพื้นที่ลูกค้า แม้ลิงก์จะชี้ไปที่นั่น', () => {
    assert.equal(homePathFor({ type: 'INTERNAL' }, '/portal/folders/abc'), INTERNAL_HOME);
  });

  test('บุคลากรภายในกลับไปยังหน้าที่ตั้งใจจะไปได้ตามปกติ', () => {
    assert.equal(homePathFor({ type: 'INTERNAL' }, '/files/xyz'), '/files/xyz');
  });
});

describe('วันหมดอายุของการแชร์', () => {
  test('ไม่หมดอายุคืนค่า null ซึ่งเป็นคำตอบที่สมบูรณ์', () => {
    assert.equal(expiryToIso('NEVER', undefined, NOW), null);
  });

  test('ตัวเลือกสำเร็จรูปถูกแปลงเป็นเวลาสัมบูรณ์', () => {
    assert.equal(expiryToIso('DAYS_7', undefined, NOW), new Date(NOW.getTime() + 7 * DAY_MS).toISOString());
    assert.equal(expiryToIso('DAYS_30', undefined, NOW), new Date(NOW.getTime() + 30 * DAY_MS).toISOString());
    assert.equal(expiryToIso('DAYS_90', undefined, NOW), new Date(NOW.getTime() + 90 * DAY_MS).toISOString());
  });

  test('ทุกตัวเลือกสำเร็จรูปให้เวลาในอนาคตเสมอ', () => {
    for (const preset of ['DAYS_7', 'DAYS_30', 'DAYS_90'] as const) {
      const iso = expiryToIso(preset, undefined, NOW) as string;
      assert.ok(new Date(iso).getTime() > NOW.getTime(), `${preset} ต้องอยู่ในอนาคต`);
    }
  });

  test('เลือกกำหนดเองแต่ยังไม่ระบุวันที่ = ยังตอบไม่ได้', () => {
    // ต่างจาก null ที่แปลว่า "ไม่หมดอายุ" - หน้าจอต้องไม่ส่งคำขอตอนที่ยังกรอกไม่ครบ
    assert.equal(expiryToIso('CUSTOM', undefined, NOW), undefined);
    assert.equal(expiryToIso('CUSTOM', '', NOW), undefined);
    assert.equal(expiryToIso('CUSTOM', 'ไม่ใช่วันที่', NOW), undefined);
  });

  test('วันที่ที่กำหนดเองหมดอายุตอนสิ้นวัน ไม่ใช่ตอนเที่ยงคืนต้นวัน', () => {
    const iso = expiryToIso('CUSTOM', '2026-12-31', NOW) as string;
    const parsed = new Date(iso);
    assert.equal(parsed.getFullYear(), 2026);
    assert.equal(parsed.getMonth(), 11);
    assert.equal(parsed.getDate(), 31);
    assert.equal(parsed.getHours(), 23, 'ต้องหมดอายุสิ้นวัน มิฉะนั้นผู้ใช้เสียสิทธิ์ไปหนึ่งวันเต็ม');
  });
});

describe('ข้อความสถานะอายุของสิทธิ์', () => {
  test('ไม่มีวันหมดอายุบอกตรง ๆ ว่าไม่หมดอายุ', () => {
    assert.equal(expiryLabel(null, NOW), 'ไม่หมดอายุ');
    assert.equal(expiryLabel(undefined, NOW), 'ไม่หมดอายุ');
  });

  test('เหลือหลายวันแสดงจำนวนวันจริง', () => {
    assert.equal(expiryLabel(new Date(NOW.getTime() + 30 * DAY_MS).toISOString(), NOW), 'หมดอายุใน 30 วัน');
    assert.equal(expiryLabel(new Date(NOW.getTime() + 2 * DAY_MS).toISOString(), NOW), 'หมดอายุใน 2 วัน');
  });

  test('เหลือไม่ถึงหนึ่งวันต้องไม่แสดง "0 วัน"', () => {
    const label = expiryLabel(new Date(NOW.getTime() + 3 * 60 * 60 * 1000).toISOString(), NOW);
    assert.equal(label, 'หมดอายุวันนี้');
    assert.ok(!label.includes('0 วัน'));
  });

  test('หมดอายุแล้วบอกตามจริง ไม่แสดงจำนวนวันติดลบ', () => {
    assert.equal(expiryLabel(new Date(NOW.getTime() - DAY_MS).toISOString(), NOW), 'หมดอายุแล้ว');
  });

  test('รู้ได้ว่าหมดอายุหรือยัง', () => {
    assert.equal(isExpired(null, NOW), false);
    assert.equal(isExpired(new Date(NOW.getTime() + 1000).toISOString(), NOW), false);
    assert.equal(isExpired(new Date(NOW.getTime() - 1000).toISOString(), NOW), true);
  });
});

describe('ป้ายกำกับ', () => {
  test('บัญชีลูกค้ามีป้าย "ภายนอก" กำกับเสมอ', () => {
    assert.equal(accountTypeLabel('EXTERNAL'), 'ภายนอก');
  });

  test('บัญชีภายในไม่ต้องมีป้าย - ค่าเริ่มต้นไม่ควรมีเสียงรบกวน', () => {
    assert.equal(accountTypeLabel('INTERNAL'), null);
    assert.equal(accountTypeLabel(null), null);
  });

  test('ระดับสิทธิ์ของลูกค้ามีสองระดับ และอธิบายด้วยผลลัพธ์จริง', () => {
    assert.deepEqual(PORTAL_LEVELS.map((level) => level.value), ['VIEWER', 'EDITOR']);
    assert.equal(PORTAL_LEVELS[0].label, 'ดูอย่างเดียว');
    assert.equal(PORTAL_LEVELS[1].label, 'อัปโหลดได้');
    for (const level of PORTAL_LEVELS) {
      assert.ok(level.hint.length > 0, 'ทุกระดับต้องมีคำอธิบายว่าผู้รับทำอะไรได้จริง');
    }
  });
});

describe('ไม่มีเมนูภายในหลุดเข้าไปในพื้นที่ลูกค้า', () => {
  /**
   * อ่านเฉพาะโค้ด ไม่รวมคอมเมนต์
   * คอมเมนต์อธิบายได้ว่า "จงใจไม่ใช้สิ่งนี้" ซึ่งจะทำให้การตรวจหาชื่อสิ่งนั้นเจอผิดตัว
   */
  const read = (relative: string) =>
    readFileSync(new URL(relative, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

  test('โครงหน้าของลูกค้าไม่ได้ใช้โครงหน้าภายในร่วมกัน', () => {
    const shell = read('../components/portal/PortalShell.tsx');
    // ใช้ AppShell ร่วมกันแล้วค่อยซ่อนเมนูตามสิทธิ์ คือรูปแบบที่พลาดครั้งเดียวแล้วรั่วถาวร
    assert.ok(!shell.includes('AppShell'), 'ต้องไม่ประกอบจากโครงหน้าของฝั่งภายใน');
    assert.ok(!shell.includes('TopNav'), 'ต้องไม่มีแถบเมนูภายใน');
    assert.ok(!shell.includes('CommandPalette'));
    assert.ok(!shell.includes('GlobalSearch'), 'การค้นหาทั้งระบบเป็นของฝั่งภายในเท่านั้น');
  });

  test('พื้นที่ลูกค้าไม่มีลิงก์ไปยังหน้าภายในใด ๆ', () => {
    const files = [
      '../components/portal/PortalShell.tsx',
      '../components/portal/PortalItemList.tsx',
      '../pages/portal/PortalHomePage.tsx',
      '../pages/portal/PortalFolderPage.tsx',
    ];
    const internalPaths = ['/dashboard', '/files', '/system-drive', '/trash', '/admin', '/shared', '/favorites'];
    for (const file of files) {
      const source = read(file);
      for (const path of internalPaths) {
        assert.ok(
          !source.includes(`"${path}`) && !source.includes(`'${path}`),
          `${file} ต้องไม่ลิงก์ไปที่ ${path}`,
        );
      }
    }
  });

  test('พื้นที่ลูกค้าเรียกเฉพาะ API ของตัวเอง', () => {
    const files = [
      '../components/portal/PortalItemList.tsx',
      '../pages/portal/PortalHomePage.tsx',
      '../pages/portal/PortalFolderPage.tsx',
    ];
    for (const file of files) {
      const source = read(file);
      // ทุกเส้นทางที่แตะต้องขึ้นต้นด้วย /api/portal หรือผ่าน portalApi เท่านั้น
      const apiPaths = source.match(/['`]\/api\/[^'`]*/g) ?? [];
      for (const path of apiPaths) {
        assert.ok(path.includes('/api/portal/'), `${file} เรียก ${path} ซึ่งไม่ใช่ API ของพื้นที่ลูกค้า`);
      }
      assert.ok(!source.includes('workspaceApi'), `${file} ต้องไม่ใช้ API ภายใน`);
      assert.ok(!source.includes('resourceApi'), `${file} ต้องไม่ใช้ API ภายใน`);
    }
  });

  test('พื้นที่ลูกค้าไม่มีการกระทำที่เปลี่ยนแปลงหรือลบของเดิม', () => {
    const list = read('../components/portal/PortalItemList.tsx');
    for (const forbidden of ['เปลี่ยนชื่อ', 'ย้ายไป', 'ลบ', 'แชร์', 'ถังขยะ']) {
      assert.ok(!list.includes(forbidden), `ไม่ควรมีปุ่ม "${forbidden}" ในพื้นที่ลูกค้า`);
    }
  });
});

describe('หน้าแชร์แยกลูกค้าออกจากบุคลากรภายใน', () => {
  const dialog = () => readFileSync(new URL('../components/files/ShareDialog.tsx', import.meta.url), 'utf8');

  test('ค้นหาผู้รับแยกตามกลุ่ม ไม่ปะปนในรายการเดียว', () => {
    const source = dialog();
    assert.ok(source.includes('SHARE_GROUP_LABEL'), 'ต้องมีหัวข้อแยกกลุ่มผู้รับ');
    assert.ok(source.includes('shareTargets(trimmed, scope)'), 'การค้นหาต้องระบุกลุ่มเสมอ');
  });

  test('ลูกค้ามีป้ายกำกับติดตัวทุกที่ที่ปรากฏ', () => {
    const source = dialog();
    assert.ok(source.includes('ExternalBadge'), 'ต้องมีป้ายกำกับผู้ใช้งานภายนอก');
    // ทั้งในผลการค้นหาและในรายชื่อผู้ที่ได้รับสิทธิ์แล้ว
    assert.ok((source.match(/<ExternalBadge/g) ?? []).length >= 2);
  });

  test('เลือกลูกค้าแล้วค่าเริ่มต้นคือระดับที่จำกัดที่สุด', () => {
    assert.ok(dialog().includes("setLevel('VIEWER')"), 'ค่าเริ่มต้นของลูกค้าต้องเป็นดูอย่างเดียว');
  });

  test('ส่งวันหมดอายุเป็นเวลาสัมบูรณ์ ไม่ใช่จำนวนวัน', () => {
    const source = dialog();
    assert.ok(source.includes('expiresAt: expiresAt ?? null'));
    assert.ok(!source.includes('expiryDays'), 'ห้ามส่งจำนวนวัน จุดอ้างอิงจะกำกวมเมื่อแก้ไขสิทธิ์ภายหลัง');
  });
});
