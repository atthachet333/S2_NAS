/**
 * ข้อมูลใช้แล้วทิ้งสำหรับทดสอบ F16 บนเบราว์เซอร์จริง
 *
 *   npm run qa:f16         สร้าง
 *   npm run qa:f16-clean   ลบทิ้ง
 *
 * ทุกอย่างขึ้นต้นด้วย f16qa เพื่อให้ลบออกได้หมดโดยไม่แตะข้อมูลจริง
 */
import { Readable } from 'node:stream';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/core/prisma.js';
import { createFolder } from '../src/modules/resources/resource.service.js';
import { uploadFile } from '../src/modules/files/file.service.js';
import { createPolicy } from '../src/modules/governance/retention.service.js';
import type { AuthUser } from '../src/modules/auth/auth.service.js';

const PREFIX = 'f16qa';
const PASSWORD = 'F16qaGovern!2026';
const audit = { ipAddress: '127.0.0.1', userAgent: 'f16-qa-fixture' };
const stream = (text: string) => Readable.from([Buffer.from(text, 'utf8')]);

async function create(): Promise<void> {
  const existing = await prisma.user.findFirst({ where: { email: `${PREFIX}-staff@example.invalid` } });
  if (existing) {
    console.log('[F16-QA] มีข้อมูลชุดทดสอบอยู่แล้ว - รัน destroy ก่อน');
    return;
  }

  const staff = await prisma.user.create({
    data: {
      email: `${PREFIX}-staff@example.invalid`,
      displayName: 'F16 QA Staff',
      type: 'INTERNAL',
      status: 'ACTIVE',
      mustChangePassword: false,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
    },
  });

  /** ให้บทบาทผู้ดูแลระบบ เพื่อให้ทดสอบหน้าการเก็บรักษาและ Legal Hold ได้ */
  const adminRole = await prisma.role.findFirst({ where: { name: { in: ['ADMIN', 'SUPER_ADMIN'] } } });
  if (adminRole) await prisma.userRole.create({ data: { userId: staff.id, roleId: adminRole.id } });

  const permissions = await prisma.permission.findMany({ select: { code: true } });
  const user: AuthUser = {
    id: staff.id,
    email: staff.email,
    displayName: staff.displayName,
    type: 'INTERNAL',
    status: 'ACTIVE',
    mustChangePassword: false,
    roles: ['ADMIN'],
    permissions: permissions.map((row) => row.code),
  };

  const folder = await createFolder(user, { name: `${PREFIX} เอกสารทดสอบ`, parentId: null }, audit);

  const upload = async (name: string) => {
    const uploaded = await uploadFile(
      user,
      stream(`เอกสารสำหรับทดสอบการกำกับดูแล ${name}`),
      { parentId: folder.id, fileName: name, allowDuplicateContent: true },
      audit,
    );
    return uploaded.resource.id;
  };

  const plain = await upload(`${PREFIX} เอกสารทั่วไป.txt`);
  const toArchive = await upload(`${PREFIX} เอกสารเก็บเข้าคลัง.txt`);
  const toHold = await upload(`${PREFIX} เอกสารระงับการลบ.txt`);
  const inTrash = await upload(`${PREFIX} เอกสารในถังขยะ.txt`);
  await upload(`${PREFIX} เอกสารสำหรับหลายรายการ.txt`);

  const fiveYears = await createPolicy(user, {
    name: `${PREFIX} เก็บ 5 ปี`,
    description: 'ตัวอย่างสำหรับทดสอบ',
    retentionDays: 365 * 5,
  });
  await createPolicy(user, {
    name: `${PREFIX} เก็บถาวร`,
    description: 'ตัวอย่างสำหรับทดสอบ',
    retainForever: true,
  });

  /**
   * เอกสารในถังขยะที่ยังอยู่ใต้นโยบาย - ใช้ทดสอบข้อความนับถอยหลัง
   * ตั้งให้พ้นอายุถังขยะไปแล้ว เพื่อให้เห็นว่าระบบไม่ลบเพราะนโยบายยังคุ้มครองอยู่
   */
  const until = new Date();
  until.setFullYear(until.getFullYear() + 5);
  await prisma.resource.update({
    where: { id: inTrash },
    data: {
      retentionPolicyId: fiveYears.id,
      retentionStartAt: new Date(),
      retentionStartBasis: 'CREATED_AT',
      retentionUntil: until,
      deletedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      deletedById: staff.id,
    },
  });

  console.log('[F16-QA] สร้างข้อมูลทดสอบเรียบร้อย');
  console.log(`[F16-QA] บัญชี   : ${staff.email}`);
  console.log(`[F16-QA] รหัสผ่าน : ${PASSWORD}`);
  console.log(`[F16-QA] โฟลเดอร์ : ${folder.id}`);
  console.log(`[F16-QA] ทั่วไป          : ${plain}`);
  console.log(`[F16-QA] จะเก็บเข้าคลัง  : ${toArchive}`);
  console.log(`[F16-QA] จะระงับการลบ   : ${toHold}`);
  console.log(`[F16-QA] อยู่ในถังขยะ    : ${inTrash}`);
}

async function destroy(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: PREFIX } },
    select: { id: true },
  });
  const userIds = users.map((row) => row.id);

  const resources = await prisma.resource.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = resources.map((row) => row.id);

  await prisma.legalHold.deleteMany({ where: { resourceId: { in: ids } } });
  await prisma.savedSearch.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.activityLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.activityLog.deleteMany({ where: { resourceId: { in: ids } } });
  await prisma.resourceTag.deleteMany({ where: { resourceId: { in: ids } } });
  await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: ids } } });
  await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: ids } } });
  await prisma.resource.updateMany({
    where: { id: { in: ids } },
    data: { retentionPolicyId: null, documentCategoryId: null },
  });
  await prisma.resource.deleteMany({ where: { parentId: { not: null }, id: { in: ids } } });
  await prisma.resource.deleteMany({ where: { id: { in: ids } } });
  await prisma.retentionPolicy.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  console.log(
    `[F16-QA] ลบข้อมูลใช้แล้วทิ้งเรียบร้อย (ผู้ใช้ ${userIds.length} ราย, ทรัพยากร ${ids.length} รายการ)`,
  );
}

const command = process.argv[2];
if (command === 'create') await create();
else if (command === 'destroy') await destroy();
else console.log('ใช้: tsx scripts/f16-qa-fixture.ts create|destroy');

await prisma.$disconnect();
