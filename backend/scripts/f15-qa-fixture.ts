/**
 * ข้อมูลใช้แล้วทิ้งสำหรับทดสอบ F15 บนเบราว์เซอร์จริง
 *
 *   npm run qa:f15         สร้าง
 *   npm run qa:f15-clean   ลบทิ้ง
 *
 * ทุกอย่างขึ้นต้นด้วย f15qa เพื่อให้ลบออกได้หมดโดยไม่แตะข้อมูลจริง
 *
 * สร้างเอกสารสองแบบตามที่การทดสอบต้องการ: ฉบับที่เครื่องอ่านถูก และฉบับที่เครื่องอ่านผิด
 * โดยเขียนผลลงดัชนีโดยตรง ไม่ต้องรัน OCR จริงกับภาพ เพราะสิ่งที่กำลังทดสอบคือ
 * "คิวตรวจและการยืนยัน" ไม่ใช่ความสามารถของ Tesseract ซึ่ง F13 พิสูจน์ไปแล้ว
 */
import { Readable } from 'node:stream';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/core/prisma.js';
import { createFolder } from '../src/modules/resources/resource.service.js';
import { uploadFile } from '../src/modules/files/file.service.js';
import { drainOnce } from '../src/modules/search/index.worker.js';
import { createCategory } from '../src/modules/categories/category.service.js';
import type { AuthUser } from '../src/modules/auth/auth.service.js';

const PREFIX = 'f15qa';
const PASSWORD = 'F15qaReview!2026';
const audit = { ipAddress: '127.0.0.1', userAgent: 'f15-qa-fixture' };
const stream = (text: string) => Readable.from([Buffer.from(text, 'utf8')]);

/** ข้อความที่เครื่องอ่านผิด - ก กลายเป็น ค ซึ่งเป็นความผิดพลาดจริงที่พบใน F13 */
const MISREAD = 'ใบคำคับภาษี เลขที่ F15-0042 บริษัท เอส ทู จำคัด';
const CORRECT_OCR = 'ใบเสร็จรับเงิน เลขที่ RC-2569-118 ยอดรวม 4,500.00 บาท';

async function create(): Promise<void> {
  const existing = await prisma.user.findFirst({ where: { email: `${PREFIX}-staff@example.invalid` } });
  if (existing) {
    console.log('[F15-QA] มีข้อมูลชุดทดสอบอยู่แล้ว - รัน destroy ก่อนถ้าต้องการสร้างใหม่');
    return;
  }

  const staff = await prisma.user.create({
    data: {
      email: `${PREFIX}-staff@example.invalid`,
      displayName: 'F15 QA Staff',
      type: 'INTERNAL',
      status: 'ACTIVE',
      mustChangePassword: false,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
    },
  });

  /** ให้สิทธิ์ผู้ดูแลระบบ เพื่อให้ทดสอบหน้าจัดการประเภทเอกสารได้ด้วย */
  const adminRole = await prisma.role.findFirst({ where: { name: { in: ['ADMIN', 'SUPER_ADMIN'] } } });
  if (adminRole) {
    await prisma.userRole.create({ data: { userId: staff.id, roleId: adminRole.id } });
  }

  const user: AuthUser = {
    id: staff.id,
    email: staff.email,
    displayName: staff.displayName,
    type: 'INTERNAL',
    status: 'ACTIVE',
    mustChangePassword: false,
    roles: ['ADMIN'],
    permissions: [
      'resources:read',
      'resources:write',
      'resources:delete',
      'resources:tag:create',
      'admin:access',
    ],
  };

  const folder = await createFolder(user, { name: `${PREFIX} เอกสารทดสอบ`, parentId: null }, audit);

  const upload = async (name: string, body: string) => {
    const uploaded = await uploadFile(
      user,
      stream(body),
      { parentId: folder.id, fileName: name, allowDuplicateContent: true },
      audit,
    );
    for (let pass = 0; pass < 10 && (await drainOnce(3)) > 0; pass += 1) {
      /* รอทำดัชนี */
    }
    return uploaded.resource.id;
  };

  const misreadId = await upload(`${PREFIX} ใบกำกับภาษีอ่านผิด.txt`, MISREAD);
  const correctId = await upload(`${PREFIX} ใบเสร็จอ่านถูก.txt`, CORRECT_OCR);
  await upload(`${PREFIX} เอกสารทั่วไป.txt`, 'เอกสารธรรมดาสำหรับทดสอบการแก้ข้อมูลหลายรายการ');
  await upload(`${PREFIX} รายงานประจำเดือน.txt`, 'รายงานสำหรับทดสอบตัวกรองและการจัดประเภท');

  /**
   * ทำให้สองไฟล์แรกดูเหมือนผ่าน OCR มาแล้วและรอตรวจ
   * ฉบับที่อ่านผิดตั้งความมั่นใจไว้ต่ำ เพื่อให้ทดสอบตัวกรอง "ความมั่นใจต่ำ" ได้
   */
  for (const [id, confidence] of [
    [misreadId, 62],
    [correctId, 96],
  ] as const) {
    const resource = await prisma.resource.findUnique({
      where: { id },
      select: { currentVersion: true },
    });
    await prisma.resourceSearchIndex.updateMany({
      where: { resourceId: id, versionNumber: resource!.currentVersion! },
      data: {
        status: 'READY',
        jobKind: 'OCR',
        textSource: 'OCR',
        ocrRequested: true,
        ocrConfidence: confidence,
        ocrPageCount: 1,
        reviewStatus: 'UNREVIEWED',
      },
    });
  }

  await createCategory(user, { name: `${PREFIX} ใบกำกับภาษี` });
  await createCategory(user, { name: `${PREFIX} ใบเสร็จ` });

  console.log('[F15-QA] สร้างข้อมูลทดสอบเรียบร้อย');
  console.log(`[F15-QA] บัญชี : ${staff.email}`);
  console.log(`[F15-QA] รหัสผ่าน: ${PASSWORD}`);
  console.log(`[F15-QA] โฟลเดอร์: ${folder.id}`);
  console.log(`[F15-QA] อ่านผิด (ต้องแก้): ${misreadId}`);
  console.log(`[F15-QA] อ่านถูก (กดยืนยันได้): ${correctId}`);
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

  const indexes = await prisma.resourceSearchIndex.findMany({
    where: { resourceId: { in: ids } },
    select: { id: true },
  });
  await prisma.resourceTextCorrection.deleteMany({
    where: { resourceSearchIndexId: { in: indexes.map((row) => row.id) } },
  });
  await prisma.savedSearch.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.activityLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.activityLog.deleteMany({ where: { resourceId: { in: ids } } });
  await prisma.resourceTag.deleteMany({ where: { resourceId: { in: ids } } });
  await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: ids } } });
  await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: ids } } });
  await prisma.resource.deleteMany({ where: { parentId: { not: null }, id: { in: ids } } });
  await prisma.resource.deleteMany({ where: { id: { in: ids } } });
  await prisma.documentCategory.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.tag.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  console.log(
    `[F15-QA] ลบข้อมูลใช้แล้วทิ้งเรียบร้อย (ผู้ใช้ ${userIds.length} ราย, ทรัพยากร ${ids.length} รายการ)`,
  );
}

const command = process.argv[2];
if (command === 'create') await create();
else if (command === 'destroy') await destroy();
else console.log('ใช้: tsx scripts/f15-qa-fixture.ts create|destroy');

await prisma.$disconnect();
