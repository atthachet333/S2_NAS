/**
 * S2 NAS - Phase C QA (API level)
 *
 * รันการทดสอบ Phase C ทั้งชุดกับเซิร์ฟเวอร์จริง โดยผู้ใช้เป็นผู้กรอกรหัสผ่านเองในเทอร์มินัล
 * รหัสผ่านไม่ถูกแสดงบนหน้าจอ ไม่ถูกบันทึกลงไฟล์ และถูกส่งไปที่ /api/auth/login ของเครื่องนี้เท่านั้น
 *
 * วิธีใช้:
 *   node scripts/phase-c-qa.mjs
 *
 * ตัวเลือก (environment):
 *   S2_QA_BASE_URL   ค่าเริ่มต้น http://localhost:8889/api
 *   S2_QA_EMAIL      ค่าเริ่มต้น admin@s2nas.local
 */
import readline from 'node:readline';

const BASE = process.env.S2_QA_BASE_URL ?? 'http://localhost:8889/api';
const EMAIL = process.env.S2_QA_EMAIL ?? 'admin@s2nas.local';

const ROOT_A = 'S2 Accounting';
const ROOT_B = 'S2 Archive';
const CHILD_YEAR = '2569';
const CHILD_TAX = 'ภาษี';
const RENAMED_TAX = 'ภาษีซื้อ';

let accessToken = null;
let refreshCookie = null;

const results = [];
const created = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok === 'skip' ? 'SKIP' : ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? `  - ${detail}` : ''}`);
}

function check(name, condition, detail = '') {
  record(name, Boolean(condition), detail);
  return Boolean(condition);
}

function hiddenQuestion(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (chunk) => {
      if (!muted) rl.output.write(chunk);
    };
    rl.question(query, (value) => {
      rl.output.write('\n');
      rl.close();
      resolve(value);
    });
    muted = true;
  });
}

async function api(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (refreshCookie) headers.Cookie = refreshCookie;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const setCookie = response.headers.getSetCookie?.() ?? [];
  const refreshed = setCookie.find((c) => c.startsWith('s2-refresh='));
  if (refreshed) refreshCookie = refreshed.split(';')[0];

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json };
}

const errCode = (res) => res.body?.error?.code ?? `HTTP_${res.status}`;
const listItems = (res) => res.body?.data?.items ?? [];

async function main() {
  console.log('='.repeat(62));
  console.log(' S2 NAS - Phase C QA (API level)');
  console.log(` Server : ${BASE}`);
  console.log(` User   : ${EMAIL}`);
  console.log('='.repeat(62));
  console.log();

  const password = await hiddenQuestion(`รหัสผ่านของ ${EMAIL} (จะไม่แสดงบนหน้าจอ): `);
  if (!password) {
    console.error('ยกเลิก: ไม่ได้กรอกรหัสผ่าน');
    process.exit(1);
  }

  // ---------- 1. Login ----------
  const login = await api('POST', '/auth/login', { email: EMAIL, password });
  if (login.status !== 200) {
    console.error(`\nเข้าสู่ระบบไม่สำเร็จ (${login.status} ${errCode(login)}) - หยุดการทดสอบ`);
    process.exit(1);
  }
  accessToken = login.body.data.accessToken;
  const me = login.body.data.user;
  check('Login สำเร็จและได้ access token', Boolean(accessToken), me.email);
  check('ได้รับ refresh cookie (s2-refresh)', Boolean(refreshCookie));

  const meRes = await api('GET', '/auth/me');
  check('GET /auth/me คืนผู้ใช้ที่ล็อกอิน', meRes.status === 200 && meRes.body.data.email === EMAIL);

  try {
    // ---------- 2. Create root folder ----------
    const rootA = await api('POST', '/folders', { name: ROOT_A, parentId: null });
    if (rootA.status !== 201) {
      record(`สร้างโฟลเดอร์ราก "${ROOT_A}"`, false, `${rootA.status} ${errCode(rootA)}`);
      throw new Error('ไม่สามารถสร้างโฟลเดอร์รากได้');
    }
    const a = rootA.body.data;
    created.push(a.id);
    check(`สร้างโฟลเดอร์ราก "${ROOT_A}"`, a.name === ROOT_A && a.type === 'FOLDER');
    check('owner ถูกตั้งเป็นผู้ใช้ปัจจุบันโดยอัตโนมัติ', a.owner?.id === me.id, `owner=${a.owner?.email}`);
    check('parentId ของโฟลเดอร์รากเป็น null', a.parentId === null);

    // ---------- 3. Nested folders ----------
    const year = await api('POST', '/folders', { name: CHILD_YEAR, parentId: a.id });
    const y = year.body?.data;
    if (year.status === 201) created.push(y.id);
    check(`สร้างโฟลเดอร์ย่อย "${CHILD_YEAR}"`, year.status === 201 && y?.parentId === a.id);

    const tax = await api('POST', '/folders', { name: CHILD_TAX, parentId: y?.id });
    const t = tax.body?.data;
    if (tax.status === 201) created.push(t.id);
    check(`สร้างโฟลเดอร์ย่อยชื่อภาษาไทย "${CHILD_TAX}"`, tax.status === 201 && t?.parentId === y?.id);
    check('owner ของโฟลเดอร์ย่อยถูกตั้งอัตโนมัติ', t?.owner?.id === me.id);

    // ---------- 4. Duplicate name guard ----------
    const dup = await api('POST', '/folders', { name: CHILD_YEAR.toUpperCase(), parentId: a.id });
    check('ชื่อซ้ำระดับเดียวกันถูกบล็อก (case-insensitive)', dup.status >= 400, errCode(dup));

    // ---------- 5. Breadcrumb ----------
    const crumb = await api('GET', `/resources/${t.id}/breadcrumb`);
    const path = (crumb.body?.data ?? []).map((n) => n.name);
    check(
      'Breadcrumb ถูกต้องตามลำดับชั้น',
      crumb.status === 200 && path.join(' / ') === `${ROOT_A} / ${CHILD_YEAR} / ${CHILD_TAX}`,
      path.join(' / '),
    );

    // ---------- 6. Rename ----------
    const renamed = await api('PATCH', `/resources/${t.id}`, { name: RENAMED_TAX });
    check('เปลี่ยนชื่อโฟลเดอร์สำเร็จ', renamed.status === 200 && renamed.body?.data?.name === RENAMED_TAX);

    // ---------- 7. Second root + move ----------
    const rootB = await api('POST', '/folders', { name: ROOT_B, parentId: null });
    const b = rootB.body?.data;
    if (rootB.status === 201) created.push(b.id);
    check(`สร้างโฟลเดอร์รากที่สอง "${ROOT_B}"`, rootB.status === 201 && b?.parentId === null);

    const moved = await api('PATCH', `/resources/${y.id}/move`, { parentId: b.id });
    check(`ย้าย "${CHILD_YEAR}" ไปอยู่ใต้ "${ROOT_B}"`, moved.status === 200 && moved.body?.data?.parentId === b.id);

    const crumbAfter = await api('GET', `/resources/${t.id}/breadcrumb`);
    const pathAfter = (crumbAfter.body?.data ?? []).map((n) => n.name);
    check(
      'Breadcrumb สะท้อนตำแหน่งใหม่หลังย้าย',
      pathAfter.join(' / ') === `${ROOT_B} / ${CHILD_YEAR} / ${RENAMED_TAX}`,
      pathAfter.join(' / '),
    );

    // ---------- 8. Illegal moves ----------
    const selfMove = await api('PATCH', `/resources/${b.id}/move`, { parentId: b.id });
    check('ย้ายโฟลเดอร์เข้าไปในตัวเองถูกบล็อก', selfMove.status >= 400, errCode(selfMove));

    const cycleMove = await api('PATCH', `/resources/${b.id}/move`, { parentId: t.id });
    check('ย้าย parent เข้าไปใน descendant ถูกบล็อก (cycle)', cycleMove.status >= 400, errCode(cycleMove));

    // ---------- 9. Ownership + capabilities ----------
    const detail = await api('GET', `/resources/${b.id}`);
    const d = detail.body?.data;
    check('รายละเอียดทรัพยากรแสดงเจ้าของ', Boolean(d?.owner?.displayName && d?.owner?.email), d?.owner?.email);

    const caps = d?.capabilities ?? {};
    const capKeys = ['canView', 'canEdit', 'canRename', 'canMove', 'canDelete', 'canShare', 'canTransferOwner'];
    check(
      'capabilities ถูกส่งมากับทรัพยากร',
      capKeys.every((k) => k in caps),
      Object.entries(caps).filter(([, v]) => v === true).map(([k]) => k).join(', '),
    );

    const listRoot = await api('GET', '/resources?sort=name&direction=asc');
    const rootItems = listItems(listRoot);
    check('รายการ root แสดงเจ้าของทุกแถว', rootItems.length > 0 && rootItems.every((i) => i.owner?.email));
    check('รายการ root แสดง capabilities ทุกแถว', rootItems.length > 0 && rootItems.every((i) => i.capabilities));

    const payload = JSON.stringify(listRoot.body);
    check('ไม่มี storageKey หรือ physical path รั่วออกมาใน API', !payload.includes('storageKey') && !/[A-Za-z]:\\\\/.test(payload));

    // ---------- 10. Admin ownership aggregate ----------
    const ownership = await api('GET', '/admin/ownership');
    const rows = ownership.body?.data ?? [];
    const mine = rows.find((r) => r.user?.id === me.id);
    check('GET /admin/ownership ทำงาน', ownership.status === 200 && Array.isArray(rows));
    check(
      'ยอดรวมความเป็นเจ้าของนับโฟลเดอร์ของผู้ใช้ปัจจุบัน',
      (mine?.ownedFolderCount ?? 0) >= 3,
      `ownedFolderCount=${mine?.ownedFolderCount}`,
    );

    // ---------- 11. Ownership transfer ----------
    const users = await api('GET', '/users');
    const allUsers = users.body?.data?.items ?? users.body?.data ?? [];
    const candidates = allUsers.filter((u) => u.id !== me.id && (u.status === 'ACTIVE' || u.isActive === true));
    if (candidates.length === 0) {
      record(
        'โอนความเป็นเจ้าของโฟลเดอร์',
        'skip',
        'ไม่มีผู้ใช้ ACTIVE รายอื่น - ไม่สร้างผู้ใช้ปลอมเพื่อทดสอบ (ครอบคลุมด้วย automated test แล้ว)',
      );
    } else {
      const target = candidates[0];
      const transfer = await api('PATCH', `/resources/${b.id}/owner`, { newOwnerId: target.id });
      check(
        'โอนความเป็นเจ้าของสำเร็จ',
        transfer.status === 200 && transfer.body?.data?.owner?.id === target.id,
        target.email,
      );
      const revert = await api('PATCH', `/resources/${b.id}/owner`, { newOwnerId: me.id });
      check('โอนความเป็นเจ้าของกลับคืนได้', revert.status === 200);
    }

    // ---------- 12. Soft delete ----------
    const deleteNonEmpty = await api('DELETE', `/resources/${b.id}`);
    check('ลบโฟลเดอร์ที่ไม่ว่างถูกบล็อก', deleteNonEmpty.status >= 400, errCode(deleteNonEmpty));

    const beforeDelete = await api('GET', `/resources?parentId=${y.id}`);
    const countBefore = listItems(beforeDelete).length;

    const softDelete = await api('DELETE', `/resources/${t.id}`);
    check('ลบโฟลเดอร์ว่างสำเร็จ (soft delete)', softDelete.status === 200 && Boolean(softDelete.body?.data?.deletedAt));

    const afterDelete = await api('GET', `/resources?parentId=${y.id}`);
    const itemsAfter = listItems(afterDelete);
    check(
      'โฟลเดอร์ที่ถูกลบหายไปจากรายการปกติ',
      itemsAfter.length === countBefore - 1 && !itemsAfter.some((i) => i.id === t.id),
      `${countBefore} -> ${itemsAfter.length}`,
    );

    const deletedIndex = created.indexOf(t.id);
    if (deletedIndex >= 0) created.splice(deletedIndex, 1);
  } catch (error) {
    record('การทดสอบหยุดกลางคัน', false, error.message);
  } finally {
    // ---------- 13. Cleanup (ลึกสุดก่อน) ----------
    const total = created.length;
    let removed = 0;
    for (const id of [...created].reverse()) {
      const res = await api('DELETE', `/resources/${id}`);
      if (res.status === 200) removed += 1;
    }
    check('ล้างข้อมูลทดสอบครบถ้วน', removed === total, `ลบ ${removed}/${total} โฟลเดอร์`);

    const rootAfter = await api('GET', '/resources');
    const leftovers = listItems(rootAfter).filter((i) => [ROOT_A, ROOT_B].includes(i.name));
    check('ไม่มีโฟลเดอร์ทดสอบหลงเหลือใน root', leftovers.length === 0);

    // ---------- 14. Auth regression ----------
    const refresh = await api('POST', '/auth/refresh');
    check('Refresh session สำเร็จ', refresh.status === 200 && Boolean(refresh.body?.data?.accessToken));
    if (refresh.status === 200) accessToken = refresh.body.data.accessToken;

    const afterRefresh = await api('GET', '/resources');
    check('เรียก API ต่อได้หลัง refresh', afterRefresh.status === 200);

    const logout = await api('POST', '/auth/logout');
    check('Logout สำเร็จ', logout.status === 200);

    const staleRefresh = await api('POST', '/auth/refresh');
    check('refresh token ถูกเพิกถอนหลัง logout', staleRefresh.status === 401, errCode(staleRefresh));

    // ---------- สรุป ----------
    const pass = results.filter((r) => r.ok === true).length;
    const fail = results.filter((r) => r.ok === false).length;
    const skip = results.filter((r) => r.ok === 'skip').length;
    console.log();
    console.log('='.repeat(62));
    console.log(` ผลรวม: PASS ${pass} | FAIL ${fail} | SKIP ${skip}`);
    console.log('='.repeat(62));
    if (fail > 0) {
      console.log();
      console.log('รายการที่ไม่ผ่าน:');
      for (const r of results.filter((x) => x.ok === false)) {
        console.log(`  - ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
      }
    }
    process.exit(fail > 0 ? 1 : 0);
  }
}

main().catch((error) => {
  console.error('QA script error:', error.message);
  process.exit(1);
});
