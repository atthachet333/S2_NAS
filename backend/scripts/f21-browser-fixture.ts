import { writeQaVersionFile } from '../src/modules/assistant/qa-fixture.js';
import { removeResourceDirectory } from '../src/core/file-storage.js';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { prisma } from '../src/core/prisma.js';

const action = process.argv[2] ?? 'create';
const marker = process.env.F21_BROWSER_MARKER ?? `f21-browser-${Date.now()}`;
const email = `${marker}@example.invalid`;
const password = `F21-QA-${marker.slice(-8)}!Aa7`;

async function destroy() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'f21-browser-', endsWith: '@example.invalid' } }, select: { id: true } });
  const userIds = users.map((user) => user.id);
  const resources = userIds.length ? await prisma.resource.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } }) : [];
  const resourceIds = resources.map((resource) => resource.id);
  if (resourceIds.length) {
    await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: resourceIds } } });
    await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: resourceIds } } });
    await prisma.resource.deleteMany({ where: { id: { in: resourceIds } } });
    for (const resourceId of resourceIds) await removeResourceDirectory(resourceId);
  }
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  return { users: userIds.length, resources: resourceIds.length };
}

async function create() {
  await destroy();
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'VIEWER' } });
  const user = await prisma.user.create({ data: { email, displayName: 'F21 Browser QA', type: 'INTERNAL', status: 'ACTIVE',
    mustChangePassword: false, passwordHash: await bcrypt.hash(password, 4), roles: { create: { roleId: role.id } } } });
  const specs = [
    { name: `${marker}-invoice.txt`, text: 'ใบแจ้งหนี้ทดสอบเบราว์เซอร์เลขที่ BROWSER-INV-2569-77 ยอดชำระ 64,210.75 บาท กำหนดชำระวันที่ 25 กันยายน 2569' },
    { name: `${marker}-contract.txt`, text: 'สัญญาทดสอบเบราว์เซอร์เลขที่ BROWSER-CT-441 กำหนดส่งมอบวันที่ 30 กันยายน 2569 ค่าปรับ 1,250 บาทต่อวัน' },
  ];
  const ids: string[] = [];
  for (const spec of specs) {
    const id = crypto.randomUUID(); ids.push(id);
    const resource = await prisma.resource.create({ data: { id, type: 'FILE', name: spec.name, normalizedName: spec.name.toLowerCase(),
      siblingKey: `${marker}:${id}`, ownerId: user.id, createdById: user.id, visibility: 'ORGANIZATION', currentVersion: 1,
      size: BigInt(spec.text.length), extension: 'txt', mimeType: 'text/plain' } });
    const stored = await writeQaVersionFile(resource.id, spec.text);
    const version = await prisma.resourceVersion.create({ data: { resourceId: resource.id, versionNumber: 1,
      storageKey: stored.storageKey, size: stored.size, checksum: stored.checksum,
      mimeType: 'text/plain', createdById: user.id } });
    await prisma.resourceSearchIndex.create({ data: { resourceId: id, resourceVersionId: version.id, versionNumber: 1,
      status: 'READY', textSource: 'NATIVE_TEXT', extractedText: spec.text, normalizedText: spec.text.toLowerCase(),
      characterCount: spec.text.length, extractorVersion: 'f21-browser', extractedAt: new Date() } });
  }
  return { marker, email, password, userId: user.id, resourceIds: ids, resourceNames: specs.map((spec) => spec.name) };
}

try {
  const result = action === 'destroy' ? await destroy() : await create();
  const json = JSON.stringify(result, null, 2);
  if (process.env.F21_BROWSER_OUT) writeFileSync(process.env.F21_BROWSER_OUT, json);
  console.log(json);
} finally { await prisma.$disconnect(); }
