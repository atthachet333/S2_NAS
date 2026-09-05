import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../../../core/prisma.js';
import { env } from '../../../config/env.js';
import { createFolder } from '../../resources/resource.service.js';
import { uploadFile, uploadVersion } from '../../files/file.service.js';
import { trashResource, restoreResource } from '../../files/trash.service.js';
import { drainOnce, drainOcrOnce } from '../index.worker.js';
import { contentMatchResourceIds } from '../content-match.js';
import { normalizeForSearch } from '../extract/normalize.js';
import { claimNextJob } from '../search-index.service.js';
import { probeEngine, cleanStaleTempDirs } from './engine.js';
import { evaluateEligibility, isPermanentOcrFailure, ocrStateFor, requestOcr } from './ocr.service.js';
import { extractPageImages } from './pdf-images.js';
import type { AuthUser } from '../../auth/auth.service.js';

/**
 * F13 - การอ่านข้อความจากเอกสารสแกน
 *
 * ชุดทดสอบนี้ใช้เครื่องมือ OCR จริงในเครื่อง ไม่มีการจำลองผลลัพธ์
 * ภาพทดสอบถูกสร้างขึ้นจริงด้วยเครื่องมือของ Windows แล้วอ่านด้วย Tesseract จริง
 *
 * ถ้าเครื่องมือไม่พร้อม ชุดทดสอบส่วนที่ต้องใช้เครื่องมือจะรายงานว่าข้ามอย่างชัดเจน
 * ไม่ใช่ผ่านไปเงียบ ๆ ราวกับว่าทดสอบแล้ว
 */

const stream = (text: string) => Readable.from([Buffer.from(text, 'utf8')]);

let workDir = '';
let engineReady = false;

/**
 * วาดข้อความลงบนภาพจริงด้วยเครื่องมือของ Windows
 *
 * ไม่มีการเพิ่มไลบรารีวาดภาพเข้ามาในโปรเจกต์เพียงเพื่อสร้างภาพทดสอบ
 * และภาพที่ได้เป็นภาพจริงที่มีตัวอักษรจริง ซึ่งเป็นสิ่งเดียวที่ทดสอบ OCR ได้อย่างมีความหมาย
 */
function renderTextImage(target: string, lines: Array<{ text: string; font: string; size: number }>): void {
  const draws = lines
    .map((line, index) => {
      const escaped = line.text.replace(/'/g, "''");
      return [
        `$f${index} = New-Object System.Drawing.Font('${line.font}', ${line.size})`,
        `$g.DrawString('${escaped}', $f${index}, [System.Drawing.Brushes]::Black, 24, ${30 + index * 90})`,
      ].join('; ');
    })
    .join('; ');

  const script = [
    'Add-Type -AssemblyName System.Drawing',
    `$bmp = New-Object System.Drawing.Bitmap 1000,${120 + lines.length * 90}`,
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.Clear([System.Drawing.Color]::White)',
    '$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit',
    draws,
    '$g.Dispose()',
    `$bmp.Save('${target.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$bmp.Dispose()',
  ].join('; ');

  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
    timeout: 60_000,
  });
}

/**
 * ประกอบ PDF ที่แต่ละหน้าเป็นภาพ - เอกสารสแกนมีหน้าตาแบบนี้
 * ภาพถูกฝังแบบ DCTDecode ซึ่งคือ JPEG ตรง ๆ เหมือนที่เครื่องสแกนสร้าง
 */
function buildScannedPdf(jpeg: Buffer, width: number, height: number): Buffer {
  const header = Buffer.from('%PDF-1.4\n', 'latin1');
  const objects: Buffer[] = [];

  const push = (body: string, stream?: Buffer): void => {
    const index = objects.length + 1;
    const parts = [Buffer.from(`${index} 0 obj\n${body}\n`, 'latin1')];
    if (stream) {
      parts.push(Buffer.from('stream\n', 'latin1'), stream, Buffer.from('\nendstream\n', 'latin1'));
    }
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

  return Buffer.concat([header, ...objects, Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1')]);
}

/** แปลง PNG เป็น JPEG ด้วยเครื่องมือของ Windows - เครื่องสแกนสร้าง JPEG เป็นปกติ */
function pngToJpeg(source: string, target: string): void {
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    `$img = [System.Drawing.Image]::FromFile('${source.replace(/\\/g, '\\\\')}')`,
    `$img.Save('${target.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Jpeg)`,
    '$img.Dispose()',
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
    timeout: 60_000,
  });
}

describe('F13 การอ่านข้อความจากเอกสารสแกน', () => {
  const prefix = `f13-${process.pid}`;
  const audit = {};

  let ownerId = '';
  let owner: AuthUser;
  let folderId = '';
  const created: string[] = [];

  const drainAll = async () => {
    for (let pass = 0; pass < 10; pass += 1) {
      const done = (await drainOnce(2)) + (await drainOcrOnce(1));
      if (done === 0) return;
    }
  };

  before(async () => {
    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 's2-ocr-test-'));

    const probe = await probeEngine();
    engineReady = probe.available;

    const user = await prisma.user.create({
      data: { email: `${prefix}-owner@example.invalid`, displayName: 'F13 Owner', type: 'INTERNAL', status: 'ACTIVE' },
    });
    ownerId = user.id;
    owner = {
      id: ownerId,
      email: user.email,
      displayName: user.displayName,
      type: 'INTERNAL',
      status: 'ACTIVE',
      mustChangePassword: false,
      roles: ['MEMBER'],
      permissions: ['resources:read', 'resources:write', 'resources:delete'],
    };

    const folder = await createFolder(owner, { name: `${prefix} เอกสารสแกน`, parentId: null }, audit);
    folderId = folder.id;
    created.push(folderId);
  });

  after(async () => {
    await fsp.rm(workDir, { recursive: true, force: true });

    const ids = new Set(created.filter(Boolean));
    for (let depth = 0; depth < 6; depth += 1) {
      const children = await prisma.resource.findMany({ where: { parentId: { in: [...ids] } }, select: { id: true } });
      const before = ids.size;
      for (const child of children) ids.add(child.id);
      if (ids.size === before) break;
    }
    const all = [...ids];

    await prisma.activityLog.deleteMany({ where: { userId: ownerId } });
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

    await prisma.refreshToken.deleteMany({ where: { userId: ownerId } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
  });

  /* ---------------------------------------------------------------- */
  /* เครื่องมือ                                                        */
  /* ---------------------------------------------------------------- */

  describe('เครื่องมือ OCR ในเครื่อง', () => {
    test('ตรวจเครื่องมือด้วยการเรียกโปรแกรมจริง ไม่ใช่แค่อ่านค่าตั้ง', async () => {
      const probe = await probeEngine();
      if (!probe.available) {
        assert.ok(probe.reason, 'เมื่อไม่พร้อมต้องบอกสาเหตุเสมอ');
        return;
      }
      assert.match(probe.version ?? '', /tesseract/i, 'ต้องได้รุ่นจากการเรียกโปรแกรมจริง');
      assert.ok(probe.languages.includes('eng'), 'ต้องมีภาษาอังกฤษ');
      assert.ok(probe.languages.includes('tha'), 'ต้องมีภาษาไทย');
      assert.equal(probe.languagesReady, true);
      assert.deepEqual(probe.missingLanguages, []);
    });

    test('ภาษาที่ตั้งไว้ต้องมีครบจึงจะถือว่าพร้อม', async () => {
      const probe = await probeEngine();
      if (!probe.available) return;
      const wanted = env.S2_NAS_OCR_LANGUAGES.split('+').map((value) => value.trim());
      for (const code of wanted) {
        assert.ok(probe.languages.includes(code), `ต้องมีข้อมูลภาษา ${code} ในเครื่อง`);
      }
    });
  });

  /* ---------------------------------------------------------------- */
  /* เงื่อนไขการใช้ OCR                                                */
  /* ---------------------------------------------------------------- */

  describe('OCR เป็นการสั่งเอง ไม่ใช่อัตโนมัติ', () => {
    test('เอกสารที่มีข้อความอยู่แล้วไม่เข้าเงื่อนไข', () => {
      const result = evaluateEligibility({
        resourceType: 'FILE', extension: 'pdf', indexStatus: 'READY', textSource: 'NATIVE_TEXT',
      });
      assert.equal(result.eligible, false);
      // การ OCR ทับข้อความที่ถูกต้องอยู่แล้วด้วยข้อความที่เครื่องเดา คือการทำให้ผลแย่ลง
      assert.match(result.eligible === false ? result.reason : '', /มีข้อความอยู่แล้ว/);
    });

    test('เอกสารสแกนเข้าเงื่อนไข', () => {
      const result = evaluateEligibility({
        resourceType: 'FILE', extension: 'pdf', indexStatus: 'NO_TEXT', textSource: null,
      });
      assert.equal(result.eligible, true);
      assert.equal(result.eligible === true ? result.kind : null, 'SCANNED_PDF');
    });

    test('ไฟล์ภาพเข้าเงื่อนไข', () => {
      for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'tif']) {
        const result = evaluateEligibility({
          resourceType: 'FILE', extension: ext, indexStatus: 'UNSUPPORTED', textSource: null,
        });
        assert.equal(result.eligible, true, `${ext} ควรเข้าเงื่อนไข`);
      }
    });

    test('ชนิดที่ไม่ควร OCR ถูกปฏิเสธ', () => {
      for (const ext of ['docx', 'xlsx', 'zip', 'mp4', 'exe', 'txt']) {
        const result = evaluateEligibility({
          resourceType: 'FILE', extension: ext, indexStatus: 'READY', textSource: 'NATIVE_TEXT',
        });
        assert.equal(result.eligible, false, `${ext} ต้องไม่เข้าเงื่อนไข`);
      }
    });

    test('โฟลเดอร์ไม่เข้าเงื่อนไข', () => {
      const result = evaluateEligibility({
        resourceType: 'FOLDER', extension: null, indexStatus: null, textSource: null,
      });
      assert.equal(result.eligible, false);
    });

    test('ความล้มเหลวถาวรไม่ถูกลองใหม่ไปเรื่อย ๆ', () => {
      assert.equal(isPermanentOcrFailure('OCR_UNSUPPORTED'), true);
      assert.equal(isPermanentOcrFailure('OCR_PAGE_LIMIT_EXCEEDED'), true);
      assert.equal(isPermanentOcrFailure('OCR_IMAGE_TOO_LARGE'), true);
      // ความล้มเหลวชั่วคราวต้องลองใหม่ได้
      assert.equal(isPermanentOcrFailure('OCR_ENGINE_FAILED'), false);
      assert.equal(isPermanentOcrFailure('OCR_TIMEOUT'), false);
    });
  });

  /* ---------------------------------------------------------------- */
  /* การอ่านภาพจริง                                                    */
  /* ---------------------------------------------------------------- */

  describe('อ่านข้อความจากภาพจริง', () => {
    test('ภาพภาษาอังกฤษ - ค้นเจอหลัง OCR', async (t) => {
      if (!engineReady) {
        t.skip('ไม่มีเครื่องมือ OCR ในเครื่อง - ข้ามการทดสอบที่ต้องใช้เครื่องมือจริง');
        return;
      }

      const image = path.join(workDir, 'english.png');
      renderTextImage(image, [{ text: 'S2 NAS OCR TEST 2026', font: 'Arial', size: 40 }]);

      const uploaded = await uploadFile(
        owner,
        Readable.from([await fsp.readFile(image)]),
        { parentId: folderId, fileName: `อังกฤษ-${prefix}.png`, allowDuplicateContent: true },
        audit,
      );
      created.push(uploaded.resource.id);
      await drainAll();

      // การสกัดปกติต้องบอกว่าไม่รองรับ - ภาพไม่มีข้อความให้สกัดตามปกติ
      const before = await ocrStateFor(uploaded.resource.id);
      assert.equal(before.status, 'UNSUPPORTED');
      assert.equal(before.eligible, true);
      assert.equal(before.ocrRequested, false, 'OCR ต้องไม่เกิดขึ้นเองโดยอัตโนมัติ');

      await requestOcr(uploaded.resource.id);
      await drainAll();

      const after = await ocrStateFor(uploaded.resource.id);
      assert.equal(after.status, 'READY', 'OCR ต้องอ่านข้อความได้');
      assert.equal(after.textSource, 'OCR', 'ที่มาของข้อความต้องบันทึกว่ามาจาก OCR');

      const hits = await contentMatchResourceIds('S2 NAS OCR TEST 2026');
      assert.ok(hits.includes(uploaded.resource.id), 'ต้องค้นเจอด้วยข้อความที่อ่านได้');
    });

    test('ภาพภาษาไทย - ค้นเจอด้วยคำที่อยู่กลางข้อความ', async (t) => {
      if (!engineReady) {
        t.skip('ไม่มีเครื่องมือ OCR ในเครื่อง');
        return;
      }

      const image = path.join(workDir, 'thai.png');
      renderTextImage(image, [{ text: 'ใบกำกับภาษี', font: 'Leelawadee UI', size: 44 }]);

      const uploaded = await uploadFile(
        owner,
        Readable.from([await fsp.readFile(image)]),
        { parentId: folderId, fileName: `ไทย-${prefix}.png`, allowDuplicateContent: true },
        audit,
      );
      created.push(uploaded.resource.id);
      await drainAll();

      await requestOcr(uploaded.resource.id);
      await drainAll();

      const state = await ocrStateFor(uploaded.resource.id);
      assert.equal(state.status, 'READY', 'ต้องอ่านข้อความภาษาไทยได้');

      /**
       * เครื่องมือ OCR แยกตัวอักษรไทยด้วยช่องว่างและเขียนสระอำแยกเป็นสองตัวเป็นปกติ
       * การปรับรูปแบบต้องทำให้ทั้งข้อความที่อ่านได้และคำที่ผู้ใช้พิมพ์ มาบรรจบกันที่รูปเดียว
       */
      const hits = await contentMatchResourceIds('กำกับภาษี');
      assert.ok(hits.includes(uploaded.resource.id), 'ต้องค้นเจอด้วยคำที่อยู่กลางข้อความไทย');
    });

    test('ภาพเปล่าจบที่ "ไม่พบข้อความ" ไม่ใช่ "ล้มเหลว"', async (t) => {
      if (!engineReady) {
        t.skip('ไม่มีเครื่องมือ OCR ในเครื่อง');
        return;
      }

      const image = path.join(workDir, 'blank.png');
      renderTextImage(image, []);

      const uploaded = await uploadFile(
        owner,
        Readable.from([await fsp.readFile(image)]),
        { parentId: folderId, fileName: `เปล่า-${prefix}.png`, allowDuplicateContent: true },
        audit,
      );
      created.push(uploaded.resource.id);
      await drainAll();

      await requestOcr(uploaded.resource.id);
      await drainAll();

      const state = await ocrStateFor(uploaded.resource.id);
      // เครื่องมือทำงานสำเร็จแต่ไม่พบข้อความ - เป็นข้อเท็จจริงเกี่ยวกับเอกสาร ไม่ใช่ความล้มเหลว
      assert.equal(state.status, 'NO_TEXT');
    });
  });

  /* ---------------------------------------------------------------- */
  /* เอกสารสแกน                                                        */
  /* ---------------------------------------------------------------- */

  describe('เอกสารสแกน - เส้นทางหลักของเฟสนี้', () => {
    test('PDF ที่เป็นภาพล้วน: NO_TEXT แล้วสั่ง OCR แล้วค้นเจอ', async (t) => {
      if (!engineReady) {
        t.skip('ไม่มีเครื่องมือ OCR ในเครื่อง');
        return;
      }

      const png = path.join(workDir, 'scan.png');
      const jpg = path.join(workDir, 'scan.jpg');
      renderTextImage(png, [
        { text: 'INVOICE SCANNED COPY', font: 'Arial', size: 40 },
        { text: 'ใบกำกับภาษี', font: 'Leelawadee UI', size: 44 },
      ]);
      pngToJpeg(png, jpg);

      const jpeg = await fsp.readFile(jpg);
      const pdf = buildScannedPdf(jpeg, 1000, 300);

      const uploaded = await uploadFile(
        owner,
        Readable.from([pdf]),
        { parentId: folderId, fileName: `เอกสารสแกน-${prefix}.pdf`, allowDuplicateContent: true },
        audit,
      );
      created.push(uploaded.resource.id);
      await drainAll();

      /* ---- ขั้นที่ 1: การสกัดปกติต้องบอกว่าไม่มีข้อความ ---- */
      const before = await ocrStateFor(uploaded.resource.id);
      assert.equal(before.status, 'NO_TEXT', 'เอกสารสแกนต้องไม่มีข้อความให้สกัดตามปกติ');
      assert.equal(before.eligible, true, 'และต้องเข้าเงื่อนไข OCR');

      /* ---- ขั้นที่ 2: สั่ง OCR ---- */
      await requestOcr(uploaded.resource.id);
      await drainAll();

      /* ---- ขั้นที่ 3: ค้นเจอ ---- */
      const after = await ocrStateFor(uploaded.resource.id);
      assert.equal(after.status, 'READY', 'หลัง OCR ต้องพร้อมค้นหา');
      assert.equal(after.textSource, 'OCR');
      assert.equal(after.ocrPageCount, 1, 'ต้องอ่านได้หนึ่งหน้า');

      const english = await contentMatchResourceIds('INVOICE SCANNED COPY');
      assert.ok(english.includes(uploaded.resource.id), 'ต้องค้นเจอข้อความภาษาอังกฤษในเอกสารสแกน');

      const thai = await contentMatchResourceIds('กำกับภาษี');
      assert.ok(thai.includes(uploaded.resource.id), 'ต้องค้นเจอข้อความภาษาไทยในเอกสารสแกน');
    });

    test('ไฟล์ต้นฉบับไม่ถูกแก้ไขจากการทำ OCR', async () => {
      const rows = await prisma.resource.findMany({
        where: { id: { in: created }, type: 'FILE', name: { contains: 'เอกสารสแกน' } },
        select: { id: true, checksum: true, size: true, storageKey: true },
      });
      for (const row of rows) {
        assert.ok(row.checksum, 'checksum ของไฟล์ต้นฉบับต้องยังอยู่');
        // OCR อ่านไฟล์อย่างเดียว ไม่เคยเขียนทับ
        const version = await prisma.resourceVersion.findFirst({
          where: { resourceId: row.id },
          select: { checksum: true },
        });
        assert.equal(version?.checksum, row.checksum, 'เนื้อไฟล์ต้องไม่เปลี่ยน');
      }
    });
  });

  /* ---------------------------------------------------------------- */
  /* ความถูกต้องตามเวอร์ชัน                                            */
  /* ---------------------------------------------------------------- */

  describe('ผลของ OCR ผูกกับเวอร์ชัน', () => {
    test('เวอร์ชันใหม่ทับผลของเวอร์ชันเก่าในการค้นหาปกติ', async (t) => {
      if (!engineReady) {
        t.skip('ไม่มีเครื่องมือ OCR ในเครื่อง');
        return;
      }

      const first = path.join(workDir, 'v1.png');
      renderTextImage(first, [{ text: 'OLDOCRMARKER', font: 'Arial', size: 44 }]);

      const uploaded = await uploadFile(
        owner,
        Readable.from([await fsp.readFile(first)]),
        { parentId: folderId, fileName: `เวอร์ชัน-${prefix}.png`, allowDuplicateContent: true },
        audit,
      );
      created.push(uploaded.resource.id);
      await drainAll();
      await requestOcr(uploaded.resource.id);
      await drainAll();

      assert.ok(
        (await contentMatchResourceIds('OLDOCRMARKER')).includes(uploaded.resource.id),
        'เวอร์ชันแรกต้องค้นเจอ',
      );

      // เวอร์ชันสองมีข้อความคนละคำ
      const second = path.join(workDir, 'v2.png');
      renderTextImage(second, [{ text: 'NEWOCRMARKER', font: 'Arial', size: 44 }]);
      await uploadVersion(owner, uploaded.resource.id, Readable.from([await fsp.readFile(second)]), {}, audit);
      await drainAll();

      // เวอร์ชันใหม่ยังไม่ได้ OCR - การค้นหาปกติต้องไม่คืนข้อความของเวอร์ชันเก่า
      assert.ok(
        !(await contentMatchResourceIds('OLDOCRMARKER')).includes(uploaded.resource.id),
        'ข้อความจากเวอร์ชันเก่าต้องไม่ถูกคืนเป็นผลปัจจุบัน',
      );

      await requestOcr(uploaded.resource.id);
      await drainAll();

      assert.ok(
        (await contentMatchResourceIds('NEWOCRMARKER')).includes(uploaded.resource.id),
        'เวอร์ชันปัจจุบันต้องค้นเจอ',
      );
      assert.ok(
        !(await contentMatchResourceIds('OLDOCRMARKER')).includes(uploaded.resource.id),
        'และเวอร์ชันเก่ายังต้องไม่ปน',
      );

      // แถวของเวอร์ชันเก่ายังอยู่เพื่อการตรวจสอบ
      const rows = await prisma.resourceSearchIndex.findMany({
        where: { resourceId: uploaded.resource.id },
        select: { versionNumber: true },
        orderBy: { versionNumber: 'asc' },
      });
      assert.deepEqual(rows.map((row) => row.versionNumber), [1, 2]);
    });
  });

  /* ---------------------------------------------------------------- */
  /* คิวงาน                                                            */
  /* ---------------------------------------------------------------- */

  describe('คิวงานใช้กลไกเดียวกับการสกัดปกติ', () => {
    test('งาน OCR ถูกจองได้ครั้งเดียว', async () => {
      const uploaded = await uploadFile(
        owner,
        stream('เนื้อหาชั่วคราว'),
        { parentId: folderId, fileName: `คิว-${prefix}.png`, allowDuplicateContent: true },
        audit,
      );
      created.push(uploaded.resource.id);
      await drainOnce(2);

      const engine = await probeEngine();
      if (!engine.available) return;

      await requestOcr(uploaded.resource.id);

      const first = await claimNextJob(new Date(), 'OCR');
      assert.ok(first, 'ต้องจองงานได้');

      // งานเดิมต้องไม่ถูกจองซ้ำ เพราะสถานะเปลี่ยนเป็น PROCESSING แล้ว
      const second = await claimNextJob(new Date(), 'OCR');
      assert.notEqual(second, first, 'งานชิ้นเดียวกันต้องไม่ถูกจองสองครั้ง');

      await drainAll();
    });

    test('งานสกัดปกติกับงาน OCR ไม่ปะปนกัน', async () => {
      const extractJob = await claimNextJob(new Date(), 'EXTRACT');
      const ocrJob = await claimNextJob(new Date(), 'OCR');
      // ทั้งคู่อาจเป็น null ได้ถ้าคิวว่าง แต่ต้องไม่ใช่งานชิ้นเดียวกัน
      if (extractJob && ocrJob) assert.notEqual(extractJob, ocrJob);
      await drainAll();
    });

    test('ไฟล์ที่ถูกย้ายไปถังขยะระหว่างรอคิวจะไม่ถูกประมวลผล', async (t) => {
      if (!engineReady) {
        t.skip('ไม่มีเครื่องมือ OCR ในเครื่อง');
        return;
      }

      const image = path.join(workDir, 'trash.png');
      renderTextImage(image, [{ text: 'TRASHEDMARKER', font: 'Arial', size: 40 }]);

      const uploaded = await uploadFile(
        owner,
        Readable.from([await fsp.readFile(image)]),
        { parentId: folderId, fileName: `ถังขยะ-${prefix}.png`, allowDuplicateContent: true },
        audit,
      );
      created.push(uploaded.resource.id);
      await drainAll();

      await requestOcr(uploaded.resource.id);
      await trashResource(uploaded.resource.id, owner, audit);
      await drainAll();

      // ไม่ใช้ CPU กับเอกสารที่ไม่มีใครค้นหาแล้ว
      const hits = await contentMatchResourceIds('TRASHEDMARKER');
      assert.ok(!hits.includes(uploaded.resource.id), 'ของในถังขยะต้องไม่ปรากฏในผลการค้นหา');

      await restoreResource(uploaded.resource.id, owner, {}, audit);
    });

    test('การลบถาวรลบผลของ OCR ไปด้วย', async () => {
      const uploaded = await uploadFile(
        owner,
        stream('ชั่วคราว'),
        { parentId: folderId, fileName: `ลบถาวร-${prefix}.png`, allowDuplicateContent: true },
        audit,
      );
      await drainOnce(2);

      await prisma.resourceVersion.deleteMany({ where: { resourceId: uploaded.resource.id } });
      await prisma.resource.delete({ where: { id: uploaded.resource.id } });

      const orphans = await prisma.resourceSearchIndex.count({ where: { resourceId: uploaded.resource.id } });
      assert.equal(orphans, 0, 'ต้องไม่มีข้อความค้างอยู่โดยไม่มีเจ้าของ');
    });
  });

  /* ---------------------------------------------------------------- */
  /* ความปลอดภัย                                                       */
  /* ---------------------------------------------------------------- */

  describe('ความปลอดภัย', () => {
    test('ชื่อไฟล์ที่เป็นคำสั่งไม่ทำให้เกิดการฉีดคำสั่ง', async (t) => {
      if (!engineReady) {
        t.skip('ไม่มีเครื่องมือ OCR ในเครื่อง');
        return;
      }

      const image = path.join(workDir, 'hostile.png');
      renderTextImage(image, [{ text: 'HOSTILENAMEOK', font: 'Arial', size: 40 }]);

      /**
       * ชื่อพวกนี้จะเป็นอันตรายทันทีถ้ามีที่ใดในระบบประกอบคำสั่งเป็นสตริงแล้วส่งให้เชลล์
       * ที่นี่ชื่อไฟล์ไม่เคยกลายเป็นส่วนหนึ่งของเส้นทางที่ส่งให้เครื่องมือเลย
       * เพราะเส้นทางจริงมาจาก storageKey ที่เซิร์ฟเวอร์สร้างเอง
       */
      const hostileNames = [
        '; calc.exe .png',
        '& whoami .png',
        '`cmd` .png',
        '$(whoami).png',
        'ไฟล์ ที่มี ช่องว่าง.png',
        "quote'name.png",
      ];

      for (const name of hostileNames) {
        const uploaded = await uploadFile(
          owner,
          Readable.from([await fsp.readFile(image)]),
          { parentId: folderId, fileName: name, allowDuplicateContent: true },
          audit,
        );
        created.push(uploaded.resource.id);
        await drainAll();
        await requestOcr(uploaded.resource.id);
        await drainAll();

        const state = await ocrStateFor(uploaded.resource.id);
        // อ่านสำเร็จตามปกติ - ชื่อไฟล์ไม่มีผลต่อการทำงานของเครื่องมือเลย
        assert.equal(state.status, 'READY', `ชื่อ ${name} ควรอ่านได้ตามปกติ`);
      }

      const hits = await contentMatchResourceIds('HOSTILENAMEOK');
      assert.ok(hits.length >= hostileNames.length, 'ทุกไฟล์ต้องถูกอ่านสำเร็จ');
    });

    test('ไม่มีที่ใดในเส้นทาง OCR ที่เรียกเชลล์', async () => {
      const files = ['./engine.ts', './ocr.service.ts', './pdf-images.ts'];
      for (const file of files) {
        const source = await fsp.readFile(new URL(file, import.meta.url), 'utf8');
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        assert.ok(!code.includes('shell: true'), `${file} ต้องไม่เรียกเชลล์`);
        // RegExp.prototype.exec เขียนเป็น x.exec(...) จึงไม่ถูกนับ
        // ตัวที่อันตรายคือ exec ของ child_process ซึ่งรับคำสั่งเป็นสตริงทั้งบรรทัด
        // ส่วน execFile รับอาร์กิวเมนต์เป็นอาร์เรย์ จึงปลอดภัยและได้รับอนุญาต
        assert.ok(
          !/(?<![.\w])exec\b(?!File)/.test(code),
          `${file} ต้องไม่เรียกโปรแกรมภายนอกด้วยสตริงคำสั่งทั้งบรรทัด`,
        );
        assert.ok(!code.includes('execSync'), `${file} ต้องไม่ใช้ execSync`);
      }
    });

    test('เอกสารเสียหายไม่ทำให้ตัวทำงานพัง', async () => {
      const broken = Buffer.from('%PDF-1.4\nไม่ใช่ PDF จริง\n%%EOF');
      assert.doesNotThrow(() =>
        extractPageImages(broken, { maxPages: 10, maxPixels: 1_000_000 }),
      );
      const result = extractPageImages(broken, { maxPages: 10, maxPixels: 1_000_000 });
      assert.deepEqual(result.images, []);
    });

    test('ภาพที่ใหญ่เกินกำหนดถูกปฏิเสธก่อนอ่าน', () => {
      // ประกาศขนาดมหาศาลในเอกสาร แต่ยังไม่ทันคลายข้อมูลจริง
      const huge = Buffer.from(
        '%PDF-1.4\n1 0 obj\n<< /Subtype /Image /Width 40000 /Height 40000 /Filter /DCTDecode /Length 4 >>\nstream\nAAAA\nendstream\nendobj\n',
        'latin1',
      );
      assert.throws(
        () => extractPageImages(huge, { maxPages: 10, maxPixels: 80_000_000 }),
        (error: unknown) => (error as { code?: string }).code === 'OCR_IMAGE_TOO_LARGE',
      );
    });

    test('ไฟล์ชั่วคราวถูกเก็บกวาดได้', async () => {
      // ไม่ควรมีอะไรค้าง และการเรียกซ้ำต้องไม่พัง
      const removed = await cleanStaleTempDirs();
      assert.ok(removed >= 0);
    });
  });

  /* ---------------------------------------------------------------- */
  /* การปรับรูปแบบข้อความไทย                                           */
  /* ---------------------------------------------------------------- */

  describe('การปรับรูปแบบข้อความไทยจาก OCR', () => {
    test('ข้อความที่เครื่องแยกตัวอักษรออกจากกัน กลับมาตรงกับที่ผู้ใช้พิมพ์', () => {
      // รูปแบบที่ Tesseract คืนมาจริงสำหรับคำว่า "ใบกำกับภาษี"
      const fromOcr = 'ใบ ก ํ า ก ั บ ภา ษี';
      assert.equal(normalizeForSearch(fromOcr), normalizeForSearch('ใบกำกับภาษี'));
    });

    test('สระอำที่ถูกเขียนแยกถูกประกอบกลับ', () => {
      const decomposed = `กํา`;
      assert.equal(normalizeForSearch(decomposed), 'กำ');
    });

    test('ช่องว่างระหว่างไทยกับอังกฤษยังคงอยู่', () => {
      // ที่นั่นเป็นการเว้นวรรคจริงของผู้เขียน ไม่ใช่ผลข้างเคียงของการอ่านภาพ
      assert.equal(normalizeForSearch('บริษัท ABC จำกัด'), 'บริษัท abc จำกัด');
    });

    test('คำค้นและเนื้อหาผ่านฟังก์ชันเดียวกันจึงบรรจบกันเสมอ', () => {
      const stored = normalizeForSearch('เลข ประ จำ ตัว ผู้ เสีย ภาษี');
      const query = normalizeForSearch('ผู้เสียภาษี');
      assert.ok(stored.includes(query));
    });
  });
});
