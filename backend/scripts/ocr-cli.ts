import { prisma } from '../src/core/prisma.js';
import { env } from '../src/config/env.js';
import { probeEngine } from '../src/modules/search/ocr/engine.js';
import {
  listOcrEligible,
  ocrDiagnostics,
  ocrStateFor,
  requestOcr,
  retryFailedOcr,
} from '../src/modules/search/ocr/ocr.service.js';
import { drainOcrOnce } from '../src/modules/search/index.worker.js';

/**
 * เครื่องมือบรรทัดคำสั่งสำหรับ OCR
 *
 * ใช้เซอร์วิสชุดเดียวกับ API และหน้าจอทุกประการ ไม่มีเส้นทางลัดของตัวเอง
 * กติกาเรื่องความเหมาะสมของไฟล์ การเข้าคิว และการทำงาน จึงมีคำตอบชุดเดียวทั้งระบบ
 *
 * ไม่รับเส้นทางจริงบนดิสก์เป็นอาร์กิวเมนต์เด็ดขาด - รับเฉพาะรหัสทรัพยากร
 * แล้วให้เซิร์ฟเวอร์เป็นผู้แปลงเป็นเส้นทางจริงเอง
 *
 *   npm run ocr:status
 *   npm run ocr:run -- <resourceId>
 *   npm run ocr:retry-failed
 *   npm run ocr:eligible
 */

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function status(): Promise<number> {
  const diagnostics = await ocrDiagnostics();

  console.log('\n[OCR] สถานะเครื่องมืออ่านข้อความ\n');
  line('เปิดใช้งาน', diagnostics.enabled ? 'ใช่' : 'ไม่');
  line('เครื่องมือ', diagnostics.engine ?? '-');
  line('ภาษาที่ตั้งไว้', diagnostics.configuredLanguages);
  line('ภาษาที่มีในเครื่อง', diagnostics.languages.length > 0 ? diagnostics.languages.join(', ') : '-');

  if (diagnostics.missingLanguages.length > 0) {
    line('ภาษาที่ขาด', diagnostics.missingLanguages.join(', '));
  }

  /**
   * พร้อมใช้งานก็ต่อเมื่อเรียกโปรแกรมได้จริง และมีข้อมูลภาษาครบตามที่ตั้งไว้
   * การตั้งค่าถูกต้องไม่ได้แปลว่าโปรแกรมมีอยู่ และโปรแกรมที่มีอยู่ไม่ได้แปลว่าอ่านภาษาไทยได้
   */
  const ready = diagnostics.enabled && diagnostics.engineAvailable;
  line('สถานะ', ready ? 'READY' : 'NOT READY');
  if (!ready && diagnostics.reason) line('สาเหตุ', diagnostics.reason);

  console.log('\n  คิวงาน');
  line('รอดำเนินการ', String(diagnostics.queued));
  line('กำลังทำงาน', String(diagnostics.processing));
  line('อ่านสำเร็จแล้ว', String(diagnostics.ready));
  line('ล้มเหลว', String(diagnostics.failed));
  line('รอการสั่ง OCR', String(diagnostics.eligibleCount));
  console.log('');

  return ready ? 0 : 1;
}

async function run(resourceId: string): Promise<number> {
  if (!resourceId) {
    console.log('[OCR] ต้องระบุรหัสทรัพยากร: npm run ocr:run -- <resourceId>');
    return 1;
  }

  const probe = await probeEngine();
  if (!probe.available) {
    console.log(`[OCR] เครื่องมือยังไม่พร้อม: ${probe.reason ?? 'ไม่ทราบสาเหตุ'}`);
    return 1;
  }

  const before = await ocrStateFor(resourceId, probe);
  if (!before.eligible) {
    console.log(`[OCR] ไฟล์นี้ไม่เข้าเงื่อนไข: ${before.reason ?? 'ไม่ทราบสาเหตุ'}`);
    return 1;
  }

  await requestOcr(resourceId);
  console.log('[OCR] เข้าคิวแล้ว กำลังทำงาน…');

  // ทำงานจนกว่าคิวจะว่าง เพื่อให้ผู้ใช้บรรทัดคำสั่งเห็นผลทันที
  for (let pass = 0; pass < 50; pass += 1) {
    const done = await drainOcrOnce(env.S2_NAS_OCR_CONCURRENCY);
    if (done === 0) break;
  }

  const after = await ocrStateFor(resourceId, probe);
  console.log(`[OCR] สถานะ: ${after.status ?? '-'}`);
  if (after.textSource) line('ที่มาของข้อความ', after.textSource);
  if (after.ocrPageCount !== null) line('จำนวนหน้าที่อ่าน', String(after.ocrPageCount));
  if (after.ocrConfidence !== null) line('ความมั่นใจเฉลี่ย', `${after.ocrConfidence}%`);
  if (after.truncated) line('หมายเหตุ', 'อ่านได้ไม่ครบทั้งฉบับ');

  return after.status === 'READY' ? 0 : 1;
}

async function retry(): Promise<number> {
  const queued = await retryFailedOcr();
  console.log(`[OCR] นำกลับเข้าคิวแล้ว ${queued} รายการ`);
  if (queued === 0) console.log('       (งานที่ล้มเหลวแบบถาวรจะไม่ถูกลองใหม่)');
  return 0;
}

async function eligible(): Promise<number> {
  const rows = await listOcrEligible(50);
  if (rows.length === 0) {
    console.log('[OCR] ไม่มีไฟล์ที่รอการสั่ง OCR');
    return 0;
  }
  console.log(`\n[OCR] ไฟล์ที่น่าจะได้ประโยชน์จาก OCR (${rows.length} รายการแรก)\n`);
  for (const row of rows) {
    console.log(`  ${row.resourceId}  ${row.name}  — ${row.reason}`);
  }
  console.log('');
  return 0;
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  let code = 0;

  switch (command) {
    case 'status':
      code = await status();
      break;
    case 'run':
      code = await run(argument ?? '');
      break;
    case 'retry-failed':
      code = await retry();
      break;
    case 'eligible':
      code = await eligible();
      break;
    default:
      console.log('ใช้: status | run <resourceId> | retry-failed | eligible');
      code = 1;
  }

  await prisma.$disconnect();
  process.exitCode = code;
}

void main();
