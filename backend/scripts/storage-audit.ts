import { prisma } from '../src/core/prisma.js';
import { auditStorage } from '../src/modules/storage/audit.service.js';

/**
 * ตรวจความสอดคล้องของพื้นที่จัดเก็บ (F23-E)
 *
 * **อ่านอย่างเดียวเสมอ** ไม่มีทางเลือกใดในคำสั่งนี้ที่แก้ไขข้อมูลหรือลบวัตถุ
 * การซ่อมต้องเป็นการตัดสินใจของคนหลังจากอ่านรายงานแล้ว
 *
 * **ค่าเริ่มต้นไม่อ่านไบต์** ตรวจการมีอยู่และขนาดจากข้อมูลกำกับของพื้นที่จัดเก็บ
 * ซึ่งเร็วพอจะรันบ่อย ๆ ได้ การตรวจ SHA-256 ต้องอ่านทุกไบต์ของทั้งคลัง
 * จึงต้องขอด้วย --checksum และรายงานจะบอกเสมอว่ารอบนั้นตรวจ checksum หรือไม่
 */

const USAGE = `
ตรวจความสอดคล้องของพื้นที่จัดเก็บ (อ่านอย่างเดียว)

  npm run audit:storage
  npm run audit:storage -- --checksum
  npm run audit:storage -- --orphans
  npm run audit:storage -- --checksum --orphans --json

ตัวเลือก
  --checksum   อ่านไบต์จริงเพื่อตรวจ SHA-256 (ช้ากว่ามาก)
  --orphans    ตรวจหาวัตถุที่ไม่มีแถวใดอ้างถึง
  --limit <n>  จำกัดจำนวนแถวที่ตรวจ
  --json       พิมพ์ผลเป็น JSON
  --help       แสดงวิธีใช้
`;

const hasFlag = (flag: string): boolean => process.argv.includes(flag);
const optionValue = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

if (hasFlag('--help')) {
  console.log(USAGE);
  process.exit(0);
}

const limitRaw = optionValue('--limit');
const limit = limitRaw ? Number(limitRaw) : undefined;
if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
  console.error('[AUDIT] --limit ต้องเป็นจำนวนเต็มบวก');
  process.exit(2);
}

const startedAt = Date.now();
const report = await auditStorage({
  checksum: hasFlag('--checksum'), orphans: hasFlag('--orphans'), limit,
});
const durationMs = Date.now() - startedAt;

if (hasFlag('--json')) {
  console.log(JSON.stringify({ ...report, durationMs }, null, 2));
} else {
  const counts = new Map<string, number>();
  for (const finding of report.findings) counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);

  console.log('[AUDIT] ตรวจพื้นที่จัดเก็บ (อ่านอย่างเดียว)');
  console.log(`        เวอร์ชัน ${report.checkedVersions} · ทรัพยากร ${report.checkedResources}`);
  console.log(`        ตรวจ checksum: ${report.checksumVerified ? 'ใช่' : 'ไม่ - ตรวจเฉพาะการมีอยู่และขนาด'}`);
  if (report.checksumVerified) console.log(`        อ่านข้อมูล ${(report.bytesRead / (1024 * 1024)).toFixed(1)} MB`);
  console.log(`        สถานะผู้ให้บริการ: ${JSON.stringify(report.providerStatus)}`);
  console.log(`        ตรวจวัตถุกำพร้า: ดิสก์ ${report.orphanScan.local ? 'ใช่' : 'ไม่'} · ที่เก็บวัตถุ ${report.orphanScan.s3 ? 'ใช่' : 'ไม่'}`);

  if (report.findings.length === 0) {
    console.log('        ผลลัพธ์: ไม่พบความไม่สอดคล้อง');
  } else {
    console.log(`        พบ ${report.findings.length} รายการ`);
    for (const [kind, count] of counts) console.log(`          ${kind}: ${count}`);
    // รายละเอียดจำกัดไว้เพื่อให้อ่านได้ และอ้างด้วยรหัสแถวเท่านั้น
    for (const finding of report.findings.slice(0, 20)) {
      const ref = finding.resourceVersionId ?? finding.resourceId ?? finding.provider ?? '-';
      console.log(`          ! ${finding.kind} ${ref}${finding.detail ? ` - ${finding.detail}` : ''}`);
    }
    if (report.findings.length > 20) console.log(`          … อีก ${report.findings.length - 20} รายการ`);
  }
  console.log(`        ใช้เวลา ${(durationMs / 1000).toFixed(1)} วินาที`);
}

await prisma.$disconnect();
/** ความไม่สอดคล้องทำให้จบด้วยรหัสไม่เป็นศูนย์ เพื่อให้ระบบตรวจอัตโนมัติจับได้ */
process.exit(report.findings.length > 0 ? 1 : 0);
