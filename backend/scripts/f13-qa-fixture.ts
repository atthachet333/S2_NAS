import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { prisma } from '../src/core/prisma.js';
import { createFolder } from '../src/modules/resources/resource.service.js';
import { uploadFile } from '../src/modules/files/file.service.js';
import type { AuthUser } from '../src/modules/auth/auth.service.js';

/**
 * เอกสารสแกนใช้แล้วทิ้งสำหรับตรวจ OCR ด้วยเบราว์เซอร์จริง
 *
 * สร้างภาพที่มีข้อความจริงด้วยเครื่องมือของ Windows แล้วห่อเป็น PDF ที่หน้าเป็นภาพ
 * ซึ่งเป็นโครงสร้างเดียวกับที่เครื่องสแกนสร้างออกมา
 *
 *   npx tsx scripts/f13-qa-fixture.ts create <staffEmail>
 *   npx tsx scripts/f13-qa-fixture.ts destroy
 */

const TAG = 'f13qa';

function renderImage(target: string, lines: Array<{ text: string; font: string; size: number }>): void {
  const draws = lines
    .map((line, index) =>
      [
        `$f${index} = New-Object System.Drawing.Font('${line.font}', ${line.size})`,
        `$g.DrawString('${line.text.replace(/'/g, "''")}', $f${index}, [System.Drawing.Brushes]::Black, 30, ${40 + index * 95})`,
      ].join('; '),
    )
    .join('; ');

  const script = [
    'Add-Type -AssemblyName System.Drawing',
    `$bmp = New-Object System.Drawing.Bitmap 1100,${140 + lines.length * 95}`,
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.Clear([System.Drawing.Color]::White)',
    '$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit',
    draws,
    '$g.Dispose()',
    `$bmp.Save('${target.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Jpeg)`,
    '$bmp.Dispose()',
  ].join('; ');

  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
    timeout: 60_000,
  });
}

/** ห่อ JPEG เป็น PDF ที่หน้าเป็นภาพ - โครงสร้างเดียวกับที่เครื่องสแกนสร้าง */
function wrapAsScannedPdf(jpeg: Buffer, width: number, height: number): Buffer {
  const objects: Buffer[] = [];
  const push = (body: string, stream?: Buffer): void => {
    const index = objects.length + 1;
    const parts = [Buffer.from(`${index} 0 obj\n${body}\n`, 'latin1')];
    if (stream) parts.push(Buffer.from('stream\n', 'latin1'), stream, Buffer.from('\nendstream\n', 'latin1'));
    parts.push(Buffer.from('endobj\n', 'latin1'));
    objects.push(Buffer.concat(parts));
  };

  push('<< /Type /Catalog /Pages 2 0 R >>');
  push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> >>`);
  push(
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
    jpeg,
  );

  return Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'latin1'),
    ...objects,
    Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
  ]);
}

async function create(staffEmail: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: staffEmail } });
  if (!user) {
    console.log(`[F13-QA] ไม่พบผู้ใช้ ${staffEmail}`);
    return;
  }

  const staff: AuthUser = {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    type: 'INTERNAL',
    status: 'ACTIVE',
    mustChangePassword: false,
    roles: ['MEMBER'],
    permissions: ['resources:read', 'resources:write', 'resources:delete'],
  };
  const audit = {};

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 's2-f13qa-'));
  try {
    const folder = await createFolder(staff, { name: `${TAG} เอกสารสแกน`, parentId: null }, audit);

    /* ---- เอกสารสแกน: PDF ที่หน้าเป็นภาพล้วน ---- */
    const scanJpg = path.join(dir, 'scan.jpg');
    renderImage(scanJpg, [
      { text: 'INVOICE SCANNED COPY 2569', font: 'Arial', size: 42 },
      { text: 'ใบกำกับภาษี เลขที่ INV-8842', font: 'Leelawadee UI', size: 40 },
    ]);
    const pdf = wrapAsScannedPdf(await fsp.readFile(scanJpg), 1100, 330);
    const scanned = await uploadFile(
      staff,
      Readable.from([pdf]),
      { parentId: folder.id, fileName: `${TAG} ใบกำกับภาษีสแกน.pdf`, allowDuplicateContent: true },
      audit,
    );

    /* ---- ภาพเอกสาร ---- */
    const photoJpg = path.join(dir, 'photo.jpg');
    renderImage(photoJpg, [{ text: 'ใบเสร็จรับเงิน RCP-F13', font: 'Leelawadee UI', size: 44 }]);
    const image = await uploadFile(
      staff,
      Readable.from([await fsp.readFile(photoJpg)]),
      { parentId: folder.id, fileName: `${TAG} ใบเสร็จถ่ายรูป.jpg`, allowDuplicateContent: true },
      audit,
    );

    console.log('[F13-QA] สร้างเอกสารใช้แล้วทิ้งเรียบร้อย');
    console.log(`  โฟลเดอร์      ${folder.id}`);
    console.log(`  เอกสารสแกน    ${scanned.resource.id}`);
    console.log(`  ภาพเอกสาร     ${image.resource.id}`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function destroy(): Promise<void> {
  const roots = await prisma.resource.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = new Set(roots.map((row) => row.id));
  for (let depth = 0; depth < 6; depth += 1) {
    const children = await prisma.resource.findMany({
      where: { parentId: { in: [...ids] } },
      select: { id: true },
    });
    const before = ids.size;
    for (const child of children) ids.add(child.id);
    if (ids.size === before) break;
  }
  const all = [...ids];

  await prisma.activityLog.deleteMany({ where: { resourceId: { in: all } } });
  await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: all } } });
  await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: all } } });

  for (let pass = 0; pass < 6; pass += 1) {
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

  console.log(`[F13-QA] ลบเอกสารใช้แล้วทิ้งเรียบร้อย (${all.length} รายการ)`);
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  if (command === 'create') await create(argument ?? '');
  else if (command === 'destroy') await destroy();
  else console.log('ใช้: create <staffEmail> | destroy');
  await prisma.$disconnect();
}

void main();
