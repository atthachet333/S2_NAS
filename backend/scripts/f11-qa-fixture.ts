import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { prisma } from '../src/core/prisma.js';
import { createFolder } from '../src/modules/resources/resource.service.js';
import { uploadFile, uploadVersion } from '../src/modules/files/file.service.js';
import { grantAccess } from '../src/modules/workspace/sharing.service.js';
import { activateUser } from '../src/modules/users/user.service.js';
import type { AuthUser } from '../src/modules/auth/auth.service.js';

/**
 * ข้อมูลใช้แล้วทิ้งสำหรับการตรวจด้วยเบราว์เซอร์จริงในเฟส F11
 *
 * สร้างบัญชีลูกค้าใหม่สองราย พร้อมเอกสารของตัวเอง แล้วพิมพ์รหัสผ่านชั่วคราวออกมาครั้งเดียว
 * ไม่แตะบัญชีที่มีอยู่เดิม ไม่เปลี่ยนรหัสผ่านของใคร และไม่แตะข้อมูลจริงแม้แต่แถวเดียว
 *
 *   npx tsx scripts/f11-qa-fixture.ts create
 *   npx tsx scripts/f11-qa-fixture.ts destroy
 */

const TAG = 'f11qa';
const VIEWER_EMAIL = `${TAG}-viewer@example.invalid`;
const CONTRIBUTOR_EMAIL = `${TAG}-contributor@example.invalid`;
const STAFF_EMAIL = `${TAG}-staff@example.invalid`;

const stream = (text: string) => Readable.from([Buffer.from(text)]);

/** รหัสผ่านชั่วคราวถูกสุ่มใหม่ทุกครั้ง และไม่ถูกเก็บไว้ที่ใดนอกจากผลลัพธ์บนหน้าจอ */
function temporaryPassword(): string {
  return `Qa!${crypto.randomBytes(9).toString('base64url')}9x`;
}

async function create() {
  const existing = await prisma.user.findFirst({ where: { email: VIEWER_EMAIL } });
  if (existing) {
    console.log('[F11-QA] มีข้อมูลชุดเดิมอยู่แล้ว - สั่ง destroy ก่อน');
    return;
  }

  const staffUser = await prisma.user.create({
    data: { email: STAFF_EMAIL, displayName: 'F11 QA Staff', type: 'INTERNAL', status: 'ACTIVE' },
  });
  const staff: AuthUser = {
    id: staffUser.id,
    email: staffUser.email,
    displayName: staffUser.displayName,
    type: 'INTERNAL',
    status: 'ACTIVE',
    mustChangePassword: false,
    roles: ['MEMBER'],
    permissions: ['resources:read', 'resources:write', 'resources:delete', 'resources:share', 'resources:lock'],
  };
  const admin: AuthUser = { ...staff, roles: ['SUPER_ADMIN'], permissions: [...staff.permissions, 'users:manage'] };
  const audit = {};

  const viewer = await prisma.user.create({
    data: {
      email: VIEWER_EMAIL,
      displayName: 'ลูกค้าทดสอบ ดูอย่างเดียว',
      type: 'EXTERNAL',
      organizationName: 'บริษัท ทดสอบ เอ จำกัด',
      status: 'INVITED',
    },
  });
  const contributor = await prisma.user.create({
    data: {
      email: CONTRIBUTOR_EMAIL,
      displayName: 'ลูกค้าทดสอบ อัปโหลดได้',
      type: 'EXTERNAL',
      organizationName: 'บริษัท ทดสอบ บี จำกัด',
      status: 'INVITED',
    },
  });

  /**
   * บัญชีเจ้าหน้าที่ใช้แล้วทิ้ง ใช้ตรวจการค้นหาจากเนื้อในเอกสารฝั่งภายใน
   * เป็นบัญชีที่สคริปต์นี้สร้างเอง ไม่ใช่บัญชีของใครที่มีอยู่แล้ว
   */
  const staffPassword = temporaryPassword();
  await prisma.user.update({ where: { id: staffUser.id }, data: { status: 'INVITED' } });
  await activateUser(staffUser.id, staffPassword, admin, audit);
  const memberRole = await prisma.role.findFirst({ where: { code: 'MEMBER' }, select: { id: true } });
  if (memberRole) {
    await prisma.userRole.createMany({ data: [{ userId: staffUser.id, roleId: memberRole.id }], skipDuplicates: true });
  }

  const viewerPassword = temporaryPassword();
  const contributorPassword = temporaryPassword();
  await activateUser(viewer.id, viewerPassword, admin, audit);
  await activateUser(contributor.id, contributorPassword, admin, audit);

  /**
   * โครงสร้างลึกห้าชั้นสำหรับการตรวจการค้นหา
   * เอกสารบริษัท เอ / ภาษี / 2569 / กันยายน / ภงด53
   */
  const rootA = await createFolder(staff, { name: `${TAG} เอกสารบริษัท เอ`, parentId: null }, audit);
  const tax = await createFolder(staff, { name: 'ภาษี', parentId: rootA.id }, audit);
  const year = await createFolder(staff, { name: '2569', parentId: tax.id }, audit);
  const month = await createFolder(staff, { name: 'กันยายน', parentId: year.id }, audit);

  await uploadFile(
    staff,
    stream('แบบแสดงรายการภาษีหัก ณ ที่จ่าย ภ.ง.ด.53\nรอบเดือนกันยายน 2569\n'),
    { parentId: month.id, fileName: 'ภงด53-กันยายน.txt', allowDuplicateContent: true },
    audit,
  );

  const versioned = await uploadFile(
    staff,
    stream('งบทดลอง ฉบับที่ 1'),
    { parentId: tax.id, fileName: 'งบทดลอง.txt', allowDuplicateContent: true },
    audit,
  );
  await uploadVersion(staff, versioned.resource.id, stream('งบทดลอง ฉบับที่ 2 แก้ไขยอดยกมา'), {}, audit);
  await uploadVersion(staff, versioned.resource.id, stream('งบทดลอง ฉบับที่ 3 ฉบับสมบูรณ์'), {}, audit);

  // โฟลเดอร์รับเอกสารของผู้อัปโหลด
  const inbox = await createFolder(staff, { name: `${TAG} รับเอกสารจากลูกค้า`, parentId: null }, audit);

  // เอกสารของลูกค้าอีกราย - ต้องไม่ปรากฏให้ผู้ดูอย่างเดียวเห็นเลย
  const rootB = await createFolder(staff, { name: `${TAG} เอกสารบริษัท บี`, parentId: null }, audit);
  await uploadFile(
    staff,
    stream('เอกสารของอีกบริษัทหนึ่ง'),
    { parentId: rootB.id, fileName: 'ภงด53-ของบริษัทอื่น.txt', allowDuplicateContent: true },
    audit,
  );

  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await grantAccess(rootA.id, { userId: viewer.id, accessLevel: 'VIEWER', allowDownload: true, expiresAt: expires }, staff, audit);
  await grantAccess(rootA.id, { userId: contributor.id, accessLevel: 'VIEWER', allowDownload: false }, staff, audit);
  await grantAccess(inbox.id, { userId: contributor.id, accessLevel: 'EDITOR', allowDownload: false }, staff, audit);
  await grantAccess(rootB.id, { userId: viewer.id, accessLevel: 'VIEWER', allowDownload: true }, staff, audit);
  // เพิกถอนทันที เพื่อให้ผู้ดูอย่างเดียวไม่เห็นของบริษัท บี - เหลือไว้เป็นรหัสสำหรับทดสอบการเดา
  await prisma.resourceAccess.deleteMany({ where: { resourceId: rootB.id, userId: viewer.id } });

  console.log('[F11-QA] สร้างข้อมูลใช้แล้วทิ้งเรียบร้อย');
  console.log(`  STAFF        ${STAFF_EMAIL}  /  ${staffPassword}`);
  console.log(`  VIEWER       ${VIEWER_EMAIL}  /  ${viewerPassword}`);
  console.log(`  CONTRIBUTOR  ${CONTRIBUTOR_EMAIL}  /  ${contributorPassword}`);
  console.log(`  รากของบริษัท บี (ใช้ทดสอบการเดารหัส): ${rootB.id}`);
}

async function destroy() {
  const users = await prisma.user.findMany({
    where: { email: { in: [VIEWER_EMAIL, CONTRIBUTOR_EMAIL, STAFF_EMAIL] } },
    select: { id: true },
  });
  const userIds = users.map((row) => row.id);

  const roots = await prisma.resource.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = new Set(roots.map((row) => row.id));
  for (let depth = 0; depth < 12; depth += 1) {
    const children = await prisma.resource.findMany({
      where: { parentId: { in: [...ids] } },
      select: { id: true },
    });
    const before = ids.size;
    for (const child of children) ids.add(child.id);
    if (ids.size === before) break;
  }
  const all = [...ids];

  await prisma.activityLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.activityLog.deleteMany({ where: { resourceId: { in: all } } });
  await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: all } } });
  await prisma.resourceAccess.deleteMany({ where: { resourceId: { in: all } } });

  for (let pass = 0; pass < 12; pass += 1) {
    const remaining = await prisma.resource.findMany({ where: { id: { in: all } }, select: { id: true } });
    if (remaining.length === 0) break;
    const remainingIds = remaining.map((row) => row.id);
    const parents = await prisma.resource.findMany({
      where: { parentId: { in: remainingIds } },
      select: { parentId: true },
    });
    const hasChildren = new Set(parents.map((row) => row.parentId));
    const leaves = remainingIds.filter((id) => !hasChildren.has(id));
    if (leaves.length === 0) break;
    await prisma.resource.deleteMany({ where: { id: { in: leaves } } });
  }

  await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userIdentity.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  console.log(`[F11-QA] ลบข้อมูลใช้แล้วทิ้งเรียบร้อย (ผู้ใช้ ${userIds.length} ราย, ทรัพยากร ${all.length} รายการ)`);
}

async function main() {
  const command = process.argv[2];
  if (command === 'create') await create();
  else if (command === 'destroy') await destroy();
  else console.log('ใช้: create | destroy');
  await prisma.$disconnect();
}

void main();
