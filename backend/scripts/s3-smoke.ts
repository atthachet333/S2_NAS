import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { S3StorageProvider, classifyS3Error } from '../src/core/storage/s3.provider.js';

/**
 * ตรวจความเข้ากันได้กับบริการ S3 ของจริง (F23-G)
 *
 * **ทำไมต้องมีสคริปต์นี้แยกจากชุดทดสอบปกติ** ชุดทดสอบของ F23-C ถึง F23-F คุยกับ
 * ชั้นขนส่งจำลองในหน่วยความจำ ซึ่งพิสูจน์ตรรกะของเราได้ครบ แต่ไม่ได้พิสูจน์เลยว่า
 * การลงลายมือชื่อ SigV4, TLS, การเปลี่ยนเส้นทาง, รูปแบบเส้นทางของถัง, โทเคนแบ่งหน้า
 * และความหมายของการลบ ทำงานเหมือนกันกับบริการจริง สิ่งเหล่านั้นพิสูจน์ได้ทางเดียว
 * คือยิงไปที่ปลายทางจริง
 *
 * **ปลอดภัยกับข้อมูลจริงโดยโครงสร้าง** สคริปต์นี้ไม่แตะฐานข้อมูลเลย ไม่อ่านแถวใด ๆ
 * และเขียนเฉพาะใต้คำนำหน้าที่สุ่มขึ้นใหม่ทุกครั้ง แล้วลบทิ้งทั้งหมดเมื่อจบ
 * ต่อให้ชี้ไปที่ถังที่มีข้อมูลอื่นอยู่ ก็ไม่มีคำสั่งใดที่แตะของนอกคำนำหน้าของรอบนั้น
 *
 * วิธีใช้ (ใส่ค่าที่ระดับโปรเซสเท่านั้น ห้ามเขียนลง .env):
 *
 *   S2_NAS_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com \
 *   S2_NAS_S3_REGION=auto \
 *   S2_NAS_S3_BUCKET=s2-nas-f23-qa \
 *   S2_NAS_S3_ACCESS_KEY_ID=... \
 *   S2_NAS_S3_SECRET_ACCESS_KEY=... \
 *   S2_NAS_S3_FORCE_PATH_STYLE=1 \
 *   npm run qa:s3-smoke
 */

const required = ['S2_NAS_S3_REGION', 'S2_NAS_S3_BUCKET', 'S2_NAS_S3_ACCESS_KEY_ID', 'S2_NAS_S3_SECRET_ACCESS_KEY'] as const;
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`\n[S3-SMOKE] ยังไม่ได้ตั้งค่า: ${missing.join(', ')}`);
  console.error('[S3-SMOKE] ตั้งค่าที่ระดับโปรเซสเท่านั้น ห้ามเขียนลง .env\n');
  process.exit(2);
}

/**
 * คำนำหน้าของรอบนี้ สุ่มใหม่ทุกครั้ง
 *
 * ทุกวัตถุที่สคริปต์นี้สร้างอยู่ใต้คำนำหน้านี้เท่านั้น การเก็บกวาดจึงครอบคลุมได้จริง
 * และไม่มีทางไปลบของที่ระบบอื่นฝากไว้ในถังเดียวกัน
 */
const runPrefix = `${(process.env.S2_NAS_S3_PREFIX ?? 'f23-qa').replace(/\/+$/, '')}/smoke-${crypto.randomUUID()}`;

const provider = new S3StorageProvider({
  endpoint: process.env.S2_NAS_S3_ENDPOINT,
  region: process.env.S2_NAS_S3_REGION!,
  bucket: process.env.S2_NAS_S3_BUCKET!,
  accessKeyId: process.env.S2_NAS_S3_ACCESS_KEY_ID!,
  secretAccessKey: process.env.S2_NAS_S3_SECRET_ACCESS_KEY!,
  forcePathStyle: process.env.S2_NAS_S3_FORCE_PATH_STYLE === '1',
  prefix: runPrefix,
});

const results: Array<{ name: string; ok: boolean; detail?: string; ms: number }> = [];
const timings = new Map<string, number[]>();

async function step(name: string, work: () => Promise<void>): Promise<void> {
  const started = Date.now();
  try {
    await work();
    results.push({ name, ok: true, ms: Date.now() - started });
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, detail: (error as Error).message.slice(0, 160) });
  }
}

function record(bucket: string, ms: number): void {
  const list = timings.get(bucket) ?? [];
  list.push(ms);
  timings.set(bucket, list);
}

const pct = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

const resourceId = crypto.randomUUID();
const smallBody = Buffer.from('S2 NAS real endpoint smoke · ใบกำกับภาษี · 🧾', 'utf8');
const smallChecksum = crypto.createHash('sha256').update(smallBody).digest('hex');
let smallKey = '';

console.log(`[S3-SMOKE] ปลายทาง ${process.env.S2_NAS_S3_ENDPOINT ?? 'AWS S3 default'}`);
console.log(`[S3-SMOKE] ถัง ${process.env.S2_NAS_S3_BUCKET} · คำนำหน้าของรอบนี้ ${runPrefix}`);

/* ---------------- 1. สุขภาพและการยืนยันตัวตน ---------------- */

await step('health (HeadBucket, proves SigV4 + TLS + endpoint)', async () => {
  const health = await provider.health();
  assert(health.status === 'READY', `สถานะ ${health.status} ${health.detail ?? ''}`);
});

/* ---------------- 2. เขียนและอ่าน ---------------- */

await step('PutObject + checksum measured from the wire', async () => {
  smallKey = provider.createStorageKey(resourceId);
  const started = Date.now();
  const stored = await provider.put(smallKey, Readable.from(smallBody));
  record('upload', Date.now() - started);
  assert(stored.size === smallBody.byteLength, 'ขนาดไม่ตรง');
  assert(stored.checksum === smallChecksum, 'checksum ไม่ตรง');
});

await step('HeadObject reports the true size', async () => {
  const stat = await provider.stat(smallKey);
  assert(stat !== null, 'ไม่พบวัตถุที่เพิ่งเขียน');
  assert(stat!.size === smallBody.byteLength, `ขนาด ${stat!.size}`);
});

await step('GetObject returns identical bytes', async () => {
  const started = Date.now();
  const read = await collect(await provider.getStream(smallKey));
  record('download', Date.now() - started);
  assert(read.equals(smallBody), 'ไบต์ที่อ่านกลับมาไม่ตรงกับต้นฉบับ');
});

/* ---------------- 3. ช่วงไบต์ ---------------- */

await step('range GetObject honours inclusive bounds', async () => {
  const started = Date.now();
  const slice = await collect(await provider.getRangeStream(smallKey, 0, 7));
  record('range', Date.now() - started);
  assert(slice.equals(smallBody.subarray(0, 8)), `ได้ ${slice.toString('hex')}`);
});

await step('range beyond the end is clamped, not an error', async () => {
  const slice = await collect(await provider.getRangeStream(smallKey, smallBody.byteLength - 4, 10_000));
  assert(slice.equals(smallBody.subarray(smallBody.byteLength - 4)), 'ช่วงท้ายไม่ตรง');
});

/* ---------------- 4. คัดลอกฝั่งบริการ ---------------- */

const copyKey = provider.createStorageKey(resourceId);
await step('CopyObject duplicates server-side', async () => {
  await provider.copy(smallKey, copyKey);
  const read = await collect(await provider.getStream(copyKey));
  assert(read.equals(smallBody), 'สำเนาไม่ตรงกับต้นฉบับ');
});

/* ---------------- 5. แบ่งหน้าและขอบเขตของคำนำหน้า ---------------- */

const pageResourceId = crypto.randomUUID();
await step('ListObjectsV2 paginates correctly (writes 12 objects)', async () => {
  const keys: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    const key = provider.createStorageKey(pageResourceId);
    keys.push(key);
    await provider.put(key, Readable.from(Buffer.from(`page-${index}`, 'utf8')));
  }
  const listed = await provider.listLogicalKeys(`resources/${pageResourceId}/`);
  assert(listed.length === 12, `แจกแจงได้ ${listed.length} จาก 12 - โทเคนแบ่งหน้าอาจไม่ถูกต้อง`);
  for (const key of keys) assert(listed.includes(key), 'คีย์ที่เขียนไว้หายจากการแจกแจง');
});

await step('listing is scoped to the run prefix only', async () => {
  const all = await provider.listLogicalKeys('resources/');
  assert(all.every((key) => key.startsWith('resources/')), 'มีคีย์นอกขอบเขตปนมา');
  assert(all.length >= 13, `คาดว่าอย่างน้อย 13 คีย์ ได้ ${all.length}`);
});

/* ---------------- 6. การลบ ---------------- */

await step('DeleteObject removes exactly one object', async () => {
  assert(await provider.delete(copyKey), 'ลบไม่สำเร็จ');
  assert((await provider.stat(copyKey)) === null, 'วัตถุยังอยู่หลังลบ');
  assert((await provider.stat(smallKey)) !== null, 'ลบผิดวัตถุ');
});

await step('deleting a missing key is idempotent success', async () => {
  assert(await provider.delete(`resources/${crypto.randomUUID()}/${crypto.randomUUID()}`), 'ควรถือว่าสำเร็จ');
});

await step('removeResourceScope deletes a whole resource scope (batch delete)', async () => {
  await provider.removeResourceScope(pageResourceId);
  const listed = await provider.listLogicalKeys(`resources/${pageResourceId}/`);
  assert(listed.length === 0, `ยังเหลือ ${listed.length} วัตถุหลังเก็บกวาด`);
  assert((await provider.stat(smallKey)) !== null, 'เก็บกวาดเกินขอบเขตของทรัพยากร');
});

/* ---------------- 7. ความล้มเหลวที่ต้องถูกจำแนกถูกต้อง ---------------- */

await step('a missing object is NOT_FOUND, not an infrastructure failure', async () => {
  const absent = `resources/${crypto.randomUUID()}/${crypto.randomUUID()}`;
  assert((await provider.stat(absent)) === null, 'ควรคืน null');
  try {
    await collect(await provider.getStream(absent));
    throw new Error('ควรล้มเหลว');
  } catch (error) {
    const code = (error as { code?: string }).code;
    assert(code === 'STORAGE_OBJECT_NOT_FOUND', `ได้รหัส ${code}`);
  }
});

await step('bad credentials classify as ACCESS_DENIED', async () => {
  const bad = new S3StorageProvider({
    endpoint: process.env.S2_NAS_S3_ENDPOINT,
    region: process.env.S2_NAS_S3_REGION!,
    bucket: process.env.S2_NAS_S3_BUCKET!,
    // จงใจใช้ค่าที่ใช้ไม่ได้ และเลี่ยงคำนำหน้าของกุญแจจริง เพื่อไม่ให้เครื่องสแกนความลับแจ้งเตือนผิด
    accessKeyId: 'not-a-real-key-for-qa-only',
    secretAccessKey: 'invalid-secret-for-qa-only',
    forcePathStyle: process.env.S2_NAS_S3_FORCE_PATH_STYLE === '1',
    prefix: runPrefix,
  });
  const health = await bad.health();
  assert(health.status === 'DEGRADED' || health.status === 'UNAVAILABLE', `ได้ ${health.status}`);
});

await step('a missing bucket is reported as unavailable', async () => {
  const bad = new S3StorageProvider({
    endpoint: process.env.S2_NAS_S3_ENDPOINT,
    region: process.env.S2_NAS_S3_REGION!,
    bucket: `s2-nas-does-not-exist-${crypto.randomUUID()}`,
    accessKeyId: process.env.S2_NAS_S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S2_NAS_S3_SECRET_ACCESS_KEY!,
    forcePathStyle: process.env.S2_NAS_S3_FORCE_PATH_STYLE === '1',
    prefix: runPrefix,
  });
  const health = await bad.health();
  assert(health.status !== 'READY', 'ถังที่ไม่มีอยู่ต้องไม่รายงานว่าพร้อม');
});

await step('an unreachable endpoint classifies as UNREACHABLE', async () => {
  const bad = new S3StorageProvider({
    endpoint: 'https://127.0.0.1:9',
    region: 'auto', bucket: 'unreachable', accessKeyId: 'id', secretAccessKey: 'secret',
    forcePathStyle: true, prefix: 'x',
  });
  const health = await bad.health();
  assert(health.status === 'UNAVAILABLE' || health.status === 'DEGRADED', `ได้ ${health.status}`);
});

/* ---------------- 8. วัตถุขนาดใหญ่แบบสตรีม ---------------- */

const largeKey = provider.createStorageKey(resourceId);
await step('a 16 MB object streams up and back with a matching checksum', async () => {
  const chunk = Buffer.alloc(1024 * 1024, 0x41);
  const total = 16;
  const hash = crypto.createHash('sha256');
  for (let index = 0; index < total; index += 1) hash.update(chunk);
  const expected = hash.digest('hex');

  const source = Readable.from((function* () {
    for (let index = 0; index < total; index += 1) yield chunk;
  })());

  const startedUp = Date.now();
  const stored = await provider.put(largeKey, source);
  const upMs = Date.now() - startedUp;
  assert(stored.checksum === expected, 'checksum ของวัตถุใหญ่ไม่ตรง');

  const startedDown = Date.now();
  const read = await collect(await provider.getStream(largeKey));
  const downMs = Date.now() - startedDown;
  assert(read.byteLength === total * chunk.byteLength, 'ขนาดที่อ่านกลับไม่ตรง');

  const mb = (total * chunk.byteLength) / (1024 * 1024);
  console.log(`[S3-SMOKE] 16 MB: อัปโหลด ${(mb / (upMs / 1000)).toFixed(1)} MB/s · ดาวน์โหลด ${(mb / (downMs / 1000)).toFixed(1)} MB/s`);
});

/* ---------------- 9. เก็บกวาดทุกอย่างของรอบนี้ ---------------- */

let cleanupFailed = false;
try {
  await provider.removeResourceScope(resourceId);
  await provider.removeResourceScope(pageResourceId);
  const leftovers = await provider.listLogicalKeys('resources/');
  if (leftovers.length > 0) {
    cleanupFailed = true;
    console.error(`[S3-SMOKE] เหลือวัตถุ ${leftovers.length} ชิ้นใต้คำนำหน้าของรอบนี้`);
  }
} catch (error) {
  cleanupFailed = true;
  console.error(`[S3-SMOKE] เก็บกวาดไม่สำเร็จ: ${classifyS3Error(error)}`);
}

/* ---------------- รายงาน ---------------- */

const failed = results.filter((result) => !result.ok);
console.log('');
for (const result of results) {
  console.log(`  ${result.ok ? 'ผ่าน' : 'ไม่ผ่าน'}  ${result.name} (${result.ms} ms)${result.detail ? ` - ${result.detail}` : ''}`);
}
console.log('');
for (const [name, values] of timings) {
  console.log(`[S3-SMOKE] ${name}: p50 ${pct(values, 50)} ms · p95 ${pct(values, 95)} ms (n=${values.length})`);
}
console.log(`[S3-SMOKE] ${results.length - failed.length}/${results.length} ผ่าน · เก็บกวาด ${cleanupFailed ? 'ไม่สำเร็จ' : 'เรียบร้อย'}`);

/** เขียนผลเป็น JSON ได้ เพื่อแนบเข้ารายงาน - ไม่มีความลับใด ๆ ในไฟล์นี้ */
if (process.argv.includes('--json')) {
  const out = path.join(os.tmpdir(), `s2nas-s3-smoke-${Date.now()}.json`);
  await fsp.writeFile(out, JSON.stringify({
    endpointConfigured: Boolean(process.env.S2_NAS_S3_ENDPOINT),
    forcePathStyle: process.env.S2_NAS_S3_FORCE_PATH_STYLE === '1',
    results, timings: Object.fromEntries(timings), cleanupFailed,
  }, null, 2));
  console.log(`[S3-SMOKE] เขียนผลไว้ที่ ${out}`);
}

process.exit(failed.length > 0 || cleanupFailed ? 1 : 0);
