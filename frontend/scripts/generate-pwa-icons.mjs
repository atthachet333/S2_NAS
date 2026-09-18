/**
 * สร้างไอคอนทุกขนาดของ S2 NAS จากภาพต้นฉบับภาพเดียว (F24-B, ปรับต้นฉบับใหม่)
 *
 * ทำไมต้องมีสคริปต์: ต้นฉบับเป็นภาพ 1254x1254 ซึ่งใหญ่เกินกว่าจะส่งให้โทรศัพท์ทุกเครื่อง
 * ดาวน์โหลด ไอคอนทุกขนาดจึงถูกย่อลงมาจากไฟล์เดียวกัน เพื่อให้เอกลักษณ์ของแบรนด์
 * เหมือนกันทุกที่ และสร้างซ้ำได้เมื่อโลโก้เปลี่ยน
 *
 * **ต้นฉบับมีแหล่งเดียวคือ assets-src/s2-nas-icon.png** ไม่มีไอคอนไหนถูกวาดมือ
 * หรือย่อ/ขยายต่อจากไฟล์ที่สคริปต์นี้สร้างไว้ก่อนหน้า ทุกขนาดย่อลงมาจากต้นฉบับความละเอียดสูง
 * โดยตรง การขยายไฟล์เล็กขึ้นจะได้ขอบฟุ้งและอ่านไม่ออกที่ 16px
 *
 * ขอบเขต: สคริปต์นี้ดูแล favicon และไอคอนของ PWA เท่านั้น
 * โลโก้บนหัวจอ (public/s2-nas-logo.png ที่ BrandLogo ใช้) เป็นงานออกแบบคนละชิ้น
 * มีต้นฉบับของตัวเองที่ assets-src/s2-nas-logo-source.png และไม่ได้ถูกสร้างที่นี่
 *
 * **เรื่องแคชที่ต้องรู้เมื่อเปลี่ยนไอคอน**
 *
 * เบราว์เซอร์เก็บ /favicon.ico ไว้แน่นกว่าไฟล์อื่นมาก และยิงขอเองที่รากเว็บ
 * โดยไม่สนใจ <link> ใน HTML ผู้ที่เคยเข้าเว็บมาก่อนจึงอาจเห็นไอคอนเดิมบนแท็บ
 * ไปอีกพักหนึ่งหลังปล่อยของใหม่ ซึ่งยอมรับได้และไม่ถือเป็นปัญหาที่ต้องแก้
 *
 * ตั้งใจไม่ใส่ ?v= ต่อท้าย <link> เพื่อไล่แคช เพราะ Workbox เทียบ URL แบบตรงตัว
 * /favicon.svg?v=2 จะไม่ตรงกับ /favicon.svg ที่เก็บล่วงหน้าไว้ กลายเป็นว่าไอคอน
 * ต้องวิ่งออกเน็ตและพังตอนออฟไลน์ - แลกความสะอาดของแคชกับการถอยหลังของ PWA ไม่คุ้ม
 *
 * เครื่องที่ยังไม่เคยเข้า เครื่องที่ล้างแคชไอคอน และ PWA ที่อัปเดต service worker แล้ว
 * ได้ไอคอนใหม่ทันที เพราะไฟล์ในรายการเก็บล่วงหน้ามีเลขรุ่นกำกับอยู่
 *
 * วิธีใช้: node scripts/generate-pwa-icons.mjs
 *
 * sharp ถูกใช้จาก backend ของโปรเจกต์นี้ เพื่อไม่ต้องติดตั้งไลบรารีเนทีฟซ้ำสองที่
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, '..');
const require = createRequire(import.meta.url);

/** หา sharp จาก frontend ก่อน แล้วค่อยถอยไปใช้ของ backend */
function loadSharp() {
  for (const id of ['sharp', path.join(frontend, '..', 'backend', 'node_modules', 'sharp', 'lib', 'index.js')]) {
    try { return require(id); } catch { /* ลองตัวถัดไป */ }
  }
  throw new Error('ไม่พบ sharp - ติดตั้งที่ frontend หรือ backend ก่อนรันสคริปต์นี้');
}

const sharp = loadSharp();
const SOURCE = path.join(frontend, 'assets-src', 's2-nas-icon.png');
const out = (name) => path.join(frontend, 'public', name);

/**
 * สัดส่วนมุมโค้งของตัวไอคอน วัดจากต้นฉบับจริง ไม่ได้เดา
 *
 * ขอบสีน้ำเงินเริ่มที่ราว 177-184px บนกรอบกว้าง 990px คือราว 18.0-18.6%
 * ค่านี้ตั้งไว้ที่ 19% ซึ่งวัดแล้วว่า **ไม่กินเนื้อสีน้ำเงินแม้แต่พิกเซลเดียว**
 * (ที่ 20% เริ่มกินไป 160 พิกเซล) ส่วนขาวที่เหลือค้างตรงปลายมุมมีราว 0.4%
 * ของภาพ ซึ่งมองไม่เห็นตั้งแต่ขนาด 64px ลงไป - ยอมเหลือขาวดีกว่าเฉือนโลโก้
 */
const CORNER_RADIUS_RATIO = 0.19;

/** สีพื้นของไอคอนไล่จากน้ำเงินสว่างมุมบนซ้ายไปกรมท่ามุมล่างขวา วัดจากต้นฉบับ */
const GRADIENT_FROM = '#0155CB';
const GRADIENT_TO = '#00246F';

const PNG = { compressionLevel: 9, palette: true, quality: 90, effort: 10 };

/**
 * ต้นฉบับที่ตัดขอบขาวออกแล้ว จัดให้เป็นสี่เหลี่ยมจัตุรัส และคว้านมุมให้โปร่งใส
 *
 * ต้นฉบับมีขอบขาวราว 132px รอบด้าน ถ้าไม่ตัดออก ไอคอนจะดูเล็กลอยกลางกรอบ
 * โดยเฉพาะบนแท็บเบราว์เซอร์ที่มีพื้นที่แค่ 16px หลังตัดแล้วได้ 990x985
 * (ไม่จัตุรัสพอดีเพราะเงาใต้ไอคอนดันกรอบลงมา) จึงเติมให้เป็น 990x990 แบบโปร่งใส
 * ด้วย fit contain ซึ่งวางไว้กึ่งกลางและ **ไม่บีบสัดส่วนของโลโก้**
 */
async function master(size) {
  const radius = Math.round(size * CORNER_RADIUS_RATIO);
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
    + `<rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`,
  );
  const pipeline = sharp(SOURCE)
    .trim({ threshold: 10 })
    .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } });
  /*
   * ย่อจาก 990px ลงมาเหลือ 16-48px ทำให้ขอบของตัว S2 จางจนอ่านแทบไม่ออก
   * จึงเพิ่มความคมเล็กน้อยเฉพาะขนาดเล็ก เพื่อดึงเส้นขอบตัวอักษรกลับมา
   * ขนาดใหญ่ไม่ทำ เพราะจะเห็นเป็นขอบแข็งผิดธรรมชาติ
   */
  if (size <= 48) pipeline.sharpen({ sigma: 0.6, m1: 1, m2: 0.4 });
  const squared = await pipeline.ensureAlpha().toBuffer();
  // dest-in เก็บเฉพาะส่วนที่อยู่ในหน้ากาก - มุมนอกโค้งจึงกลายเป็นโปร่งใสแทนที่จะเป็นขาว
  return sharp(squared).composite([{ input: mask, blend: 'dest-in' }]).png(PNG).toBuffer();
}

/** ไอคอนสี่เหลี่ยมมุมโค้งพื้นโปร่งใส - ใช้กับ favicon และ manifest ทั่วไป */
const square = async (size) => master(size);

/**
 * ไอคอนบนพื้นทึบ สำหรับที่ที่ความโปร่งใสกลายเป็นดำหรือขาวไม่แน่นอน
 *
 * iOS ไม่รองรับความโปร่งใสของ apple-touch-icon - ส่วนโปร่งจะกลายเป็นดำสนิท
 * จึงต้องแบนลงบนพื้นก่อนเสมอ
 */
async function opaque(size) {
  const logo = await master(size);
  return sharp(await backdrop(size))
    .composite([{ input: logo }])
    .png(PNG)
    .toBuffer();
}

/** พื้นไล่สีแนวทแยงให้เข้ากับตัวไอคอน แทนที่จะเป็นเทาอ่อนซึ่งตัดกับแบรนด์ */
async function backdrop(size) {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0" stop-color="${GRADIENT_FROM}"/><stop offset="1" stop-color="${GRADIENT_TO}"/>`
    + `</linearGradient></defs><rect width="${size}" height="${size}" fill="url(#g)"/></svg>`,
  );
  return sharp(svg).png().toBuffer();
}

/**
 * รูปแบบ maskable ของ Android ซึ่งระบบจะครอบหน้ากากรูปอะไรก็ได้ทับอีกที
 *
 * เนื้อหาสำคัญต้องอยู่ในวงกลมกลางภาพขนาด 80% ของด้าน ตัวโลโก้จึงถูกย่อเหลือ 78%
 * แล้ววางบนพื้นไล่สีเดียวกับไอคอน ทำให้เมื่อโดนครอบเป็นวงกลม สี่เหลี่ยมมุมมน
 * หรือหยดน้ำ ก็ยังเห็นเป็นไอคอนเดียวกันโดยไม่มีขอบขาวโผล่
 */
async function maskable(size) {
  const inner = Math.round(size * 0.78);
  const pad = Math.round((size - inner) / 2);
  const logo = await master(inner);
  return sharp(await backdrop(size))
    .composite([{ input: logo, top: pad, left: pad }])
    .png(PNG)
    .toBuffer();
}

/**
 * ประกอบไฟล์ .ico ด้วยมือ เพราะ sharp เขียนรูปแบบนี้ไม่ได้
 *
 * ยังต้องมีไฟล์นี้อยู่ เพราะเบราว์เซอร์ยิงขอ /favicon.ico เองโดยไม่สนใจ <link>
 * และทางลัดบนเดสก์ท็อปของ Windows ก็อ่านจากไฟล์นี้ ข้างในเป็น PNG สามขนาดซ้อนกัน
 * ซึ่งเป็นรูปแบบที่ Windows Vista ขึ้นไปและเบราว์เซอร์ปัจจุบันอ่านได้ทั้งหมด
 */
async function ico(sizes) {
  const images = await Promise.all(sizes.map((size) => master(size)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // สงวนไว้
  header.writeUInt16LE(1, 2); // 1 = ไอคอน
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, index) => {
    const at = index * 16;
    directory.writeUInt8(sizes[index] >= 256 ? 0 : sizes[index], at + 0); // 0 หมายถึง 256
    directory.writeUInt8(sizes[index] >= 256 ? 0 : sizes[index], at + 1);
    directory.writeUInt8(0, at + 2); // ไม่ใช้จานสี
    directory.writeUInt8(0, at + 3); // สงวนไว้
    directory.writeUInt16LE(1, at + 4); // planes
    directory.writeUInt16LE(32, at + 6); // bit ต่อพิกเซล
    directory.writeUInt32LE(image.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.length;
  });

  return Buffer.concat([header, directory, ...images]);
}

/**
 * favicon.svg ที่ห่อ PNG ความละเอียดสูงไว้ข้างใน
 *
 * ทำไมไม่วาดเป็นเวกเตอร์: ไอคอนจริงมีไล่สีและเงา วาดใหม่เป็น path จะเป็นการ
 * ออกแบบใหม่ ซึ่งไม่ใช่สิ่งที่ต้องการ - ต้องเป็นภาพเดียวกับต้นฉบับเป๊ะ ๆ
 *
 * ทำไมต้องมีไฟล์นี้: index.html ประกาศ image/svg+xml ไว้เป็นอันแรก เบราว์เซอร์
 * สมัยใหม่จึงเลือกอันนี้ก่อน PNG เสมอ ถ้าปล่อยให้เป็นไฟล์เก่าค้างไว้ แท็บจะยังขึ้น
 * ไอคอนเดิมถึงแม้จะสร้าง PNG ใหม่ครบทุกขนาดแล้วก็ตาม
 */
async function svg(size) {
  const png = await master(size);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`
    + `<image width="${size}" height="${size}" href="data:image/png;base64,${png.toString('base64')}"/>`
    + `</svg>`,
    'utf8',
  );
}

/**
 * ขนาดที่ต้องสร้าง
 *
 * ชื่อไฟล์เดิมถูกรักษาไว้ทั้งหมด เพราะ index.html, manifest, รายการ precache
 * และ verify-pwa-build อ้างถึงชื่อเหล่านี้อยู่ การเปลี่ยนชื่อจะทำให้ลิงก์ที่ผู้ใช้
 * แคชไว้แล้วชี้ไปที่ว่างเปล่า
 */
const targets = [
  ['favicon.ico', () => ico([16, 32, 48])],
  ['favicon.svg', () => svg(256)],
  ['favicon-16x16.png', () => square(16)],
  ['favicon-32x32.png', () => square(32)],
  ['favicon-48x48.png', () => square(48)],
  ['icon-64x64.png', () => square(64)],
  ['icon-72x72.png', () => square(72)],
  ['icon-96x96.png', () => square(96)],
  ['icon-128x128.png', () => square(128)],
  ['icon-144x144.png', () => square(144)],
  ['icon-152x152.png', () => square(152)],
  ['icon-256x256.png', () => square(256)],
  ['icon-384x384.png', () => square(384)],
  ['pwa-192x192.png', () => square(192)],
  ['pwa-512x512.png', () => square(512)],
  ['pwa-maskable-512x512.png', () => maskable(512)],
  // iOS ไม่รองรับความโปร่งใสตรงนี้ จึงต้องแบนลงบนพื้นสีก่อน
  ['apple-touch-icon.png', () => opaque(180)],
  ['favicon.png', () => square(256)],
];

/*
 * public/s2-nas-logo.png ตั้งใจไม่อยู่ในรายการนี้
 *
 * ไฟล์นั้นคือโลโก้บนหัวจอ (BrandLogo) ซึ่งเป็นงานออกแบบคนละชิ้นกับไอคอนแอป
 * มันมีต้นฉบับของตัวเองที่ assets-src/s2-nas-logo-source.png และไม่ได้ถูกสร้าง
 * โดยสคริปต์นี้ - ที่นี่ดูแลเฉพาะ favicon และไอคอนของ PWA เท่านั้น
 *
 * ห้ามเอา s2-nas-logo-source.png กลับเข้ามาเป็นต้นทางของไฟล์ไหนในสคริปต์นี้
 * เพราะจะทำให้ไอคอนแอปมีต้นฉบับสองที่อีกครั้ง - brand-icons.test.ts ตรวจข้อนี้ไว้
 */

const source = await fs.stat(SOURCE).catch(() => null);
if (!source) throw new Error(`ไม่พบภาพต้นฉบับที่ ${SOURCE}`);

for (const [name, build] of targets) {
  const buffer = await build();
  await fs.writeFile(out(name), buffer);
  console.log(`${name.padEnd(26)} ${(buffer.length / 1024).toFixed(1)} KB`);
}

console.log(`\nสร้างจากต้นฉบับเดียว: ${path.relative(frontend, SOURCE)}`);
