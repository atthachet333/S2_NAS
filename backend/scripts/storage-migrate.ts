import { prisma } from '../src/core/prisma.js';
import { migrateStorage } from '../src/modules/storage/migration.service.js';
import type { StorageProviderKind } from '@prisma/client';

/**
 * ย้ายวัตถุระหว่างผู้ให้บริการพื้นที่จัดเก็บ (F23-E)
 *
 * **ไม่ทำอะไรเลยถ้าไม่ได้สั่งชัดเจน** คำสั่งเปล่า ๆ แสดงวิธีใช้แล้วจบด้วยรหัสผิดพลาด
 * เครื่องมือนี้แตะข้อมูลจริงของผู้ใช้ การเผลอพิมพ์คำสั่งแล้วมันเริ่มย้ายทั้งคลัง
 * เป็นพฤติกรรมที่ยอมรับไม่ได้ จึงต้องระบุทั้ง --from --to และเลือกอย่างใดอย่างหนึ่ง
 * ระหว่าง --dry-run กับ --execute เสมอ
 *
 * **ไม่ลบต้นทาง** การคืนพื้นที่ไม่ใช่งานของคำสั่งนี้ สำเนาที่ต้นทางยังอยู่ครบหลังย้ายเสร็จ
 *
 * **คำเตือนสำคัญ:** การย้ายเวอร์ชันใด ๆ ไปยัง S3 จะทำให้ชุดสำรองแบบพกพาใช้ไม่ได้
 * จนกว่า F23-F จะเสร็จ ระบบจะปฏิเสธการสำรองด้วย BACKUP_PROVIDER_UNSUPPORTED
 * โดยตั้งใจ ดีกว่าสร้างชุดสำรองที่ขาดไฟล์แล้วบอกว่าสำเร็จ
 */

const USAGE = `
ย้ายวัตถุระหว่างผู้ให้บริการพื้นที่จัดเก็บ

  npm run storage:migrate -- --from local --to s3 --dry-run
  npm run storage:migrate -- --from local --to s3 --execute --limit 100
  npm run storage:migrate -- --from local --to s3 --execute --resource-version <id>

ตัวเลือก
  --from local|s3          ผู้ให้บริการต้นทาง (จำเป็น)
  --to local|s3            ผู้ให้บริการปลายทาง (จำเป็น)
  --dry-run                ตรวจอย่างเดียว ไม่เขียนและไม่สลับข้อมูลกำกับ
  --execute                ลงมือย้ายจริง (ต้องเลือกอย่างใดอย่างหนึ่งกับ --dry-run)
  --limit <n>              จำกัดจำนวนเวอร์ชันในรอบนี้
  --resource-version <id>  ย้ายเฉพาะเวอร์ชันที่ระบุ
  --resource <id>          ย้ายเฉพาะทรัพยากรที่ระบุ (ระบุซ้ำได้)
  --json                   พิมพ์ผลเป็น JSON

หมายเหตุ
  ไม่มีการลบวัตถุที่ต้นทาง และรันซ้ำได้เสมอ - แต่ละแถวตัดสินจากสถานะจริงของตัวเอง
  การย้ายไป S3 จะทำให้ชุดสำรองแบบพกพาใช้ไม่ได้จนกว่า F23-F จะเสร็จ
`;

function optionValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const hasFlag = (flag: string): boolean => process.argv.includes(flag);

function parseProvider(value: string | undefined, flag: string): StorageProviderKind {
  if (value === 'local') return 'LOCAL';
  if (value === 's3') return 'S3';
  console.error(`[MIGRATE] ${flag} ต้องเป็น local หรือ s3`);
  process.exit(2);
}

const from = optionValue('--from');
const to = optionValue('--to');
const dryRun = hasFlag('--dry-run');
const execute = hasFlag('--execute');

if (!from || !to) {
  console.error(USAGE);
  process.exit(2);
}
if (dryRun === execute) {
  console.error('[MIGRATE] ต้องเลือกอย่างใดอย่างหนึ่งระหว่าง --dry-run กับ --execute\n');
  console.error(USAGE);
  process.exit(2);
}

const source = parseProvider(from, '--from');
const target = parseProvider(to, '--to');
if (source === target) {
  console.error('[MIGRATE] ต้นทางและปลายทางต้องต่างกัน');
  process.exit(2);
}

const limitRaw = optionValue('--limit');
const limit = limitRaw ? Number(limitRaw) : undefined;
if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
  console.error('[MIGRATE] --limit ต้องเป็นจำนวนเต็มบวก');
  process.exit(2);
}

/** รวบรวม --resource ทุกครั้งที่ปรากฏ เพื่อให้ย้ายทีละกลุ่มได้อย่างมีขอบเขต */
const resourceIds = process.argv.reduce<string[]>((ids, value, index) => {
  if (value === '--resource' && process.argv[index + 1]) ids.push(process.argv[index + 1]!);
  return ids;
}, []);

const summary = await migrateStorage({
  from: source, to: target, dryRun,
  limit, resourceVersionId: optionValue('--resource-version'),
  ...(resourceIds.length > 0 ? { resourceIds } : {}),
});

if (hasFlag('--json')) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const mode = dryRun ? 'DRY RUN' : 'EXECUTE';
  console.log(`[MIGRATE] ${mode} ${source} -> ${target}`);
  console.log(`          ตรวจ ${summary.scanned} · เข้าเกณฑ์ ${summary.eligible} · คัดลอก ${summary.copied}`);
  console.log(`          ตรวจสอบผ่าน ${summary.verified} · สลับแล้ว ${summary.switched} · ย้ายไว้ก่อนแล้ว ${summary.alreadyMigrated}`);
  console.log(`          ข้าม ${summary.skipped} · ล้มเหลว ${summary.failed}`);
  console.log(`          ต้นทางหาย ${summary.sourceMissing} · ปลายทางชนกัน ${summary.targetConflict} · checksum ไม่ตรง ${summary.checksumMismatch}`);
  console.log(`          ข้อมูล ${(summary.bytes / (1024 * 1024)).toFixed(1)} MB`);

  // รายงานความล้มเหลวด้วยรหัสแถวเท่านั้น ไม่มีคีย์ เส้นทาง หรือเนื้อหาเอกสาร
  for (const item of summary.items) {
    if (['MIGRATED', 'DRY_RUN', 'SKIP_ALREADY_MIGRATED', 'SKIP_NOT_ON_SOURCE'].includes(item.outcome)) continue;
    console.log(`          ! ${item.resourceVersionId} ${item.outcome}${item.detail ? ` - ${item.detail}` : ''}`);
  }

  if (!dryRun && summary.switched > 0 && target === 'S3') {
    console.log('\n[MIGRATE] คำเตือน: ชุดสำรองแบบพกพาจะใช้ไม่ได้จนกว่า F23-F จะเสร็จ');
  }
}

await prisma.$disconnect();
process.exit(summary.failed > 0 ? 1 : 0);
