import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(here, '..', '..');

dotenv.config({ path: path.join(BACKEND_ROOT, '.env') });

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  BACKEND_PORT: z.coerce.number().int().min(1).max(65535).default(8889),
  BACKEND_HOST: z.string().min(1).default('0.0.0.0'),

  CORS_ORIGIN: z.string().default('http://localhost:8888'),
  /**
   * ที่อยู่สาธารณะของ S2 NAS สำหรับประกอบ URL ของลิงก์แชร์ภายนอก (F18)
   *
   * ต้องมาจากการตั้งค่า ไม่ใช่จาก Host header ของคำขอ - ผู้โจมตีกำหนด header นั้นได้
   * และจะทำให้ระบบสร้างลิงก์ที่ชี้ไปโดเมนของเขาเอง แล้วส่งต่อให้เหยื่อโดยที่ลิงก์นั้น
   * ดูเหมือนออกมาจากระบบของเราจริง ๆ
   */
  S2_NAS_PUBLIC_BASE_URL: z.string().url().optional(),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required').optional(),

  S2_NAS_STORAGE_ROOT: z.string().min(1).default('./storage'),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().int().positive().default(100),
  S2_NAS_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().optional(),
  S2_NAS_ZIP_MAX_RESOURCES: z.coerce.number().int().positive().default(1000),
  S2_NAS_ZIP_MAX_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024 * 1024),
  /** อายุของแต่ละรายการในถังขยะ นับจาก deletedAt ของรายการนั้นเอง (0 = ปิดการเก็บกวาดอัตโนมัติ) */
  S2_NAS_TRASH_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(14),

  /* ---- การสกัดข้อความในเอกสารเพื่อค้นหา (F12) ---- */

  /**
   * ไฟล์ที่ใหญ่กว่านี้จะไม่ถูกสกัดข้อความ
   *
   * ไม่ใช่ข้อจำกัดของการอัปโหลด - ไฟล์ยังอัปโหลดและดาวน์โหลดได้ตามปกติ
   * เพียงแต่ค้นจากเนื้อในไม่ได้ ค่านี้กันไม่ให้ไฟล์ก้อนเดียวกินหน่วยความจำของเซิร์ฟเวอร์
   */
  S2_NAS_EXTRACT_MAX_FILE_BYTES: z.coerce.number().int().positive().default(64 * 1024 * 1024),
  /** ข้อความที่ยาวเกินนี้จะถูกตัด และแถวดัชนีจะถูกทำเครื่องหมายว่า truncated */
  S2_NAS_EXTRACT_MAX_TEXT_CHARS: z.coerce.number().int().positive().default(400_000),
  /** เวลาสูงสุดต่อหนึ่งไฟล์ - ไฟล์ที่ทำให้ตัวสกัดค้างต้องไม่หยุดคิวทั้งคิว */
  S2_NAS_EXTRACT_MAX_SECONDS: z.coerce.number().int().positive().default(60),
  /** จำนวนงานที่ทำพร้อมกัน - ตั้งใจให้ต่ำ การค้นหาสำคัญน้อยกว่าการที่ระบบยังรับงานได้ */
  S2_NAS_EXTRACT_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  /** ระยะห่างของการตรวจคิว (วินาที) */
  S2_NAS_EXTRACT_POLL_SECONDS: z.coerce.number().int().positive().default(15),
  /** 0 = ปิดการสกัดข้อความทั้งหมด (ระบบยังทำงานได้ครบ เพียงแต่ค้นจากเนื้อในไม่ได้) */
  S2_NAS_EXTRACT_ENABLED: z.coerce.number().int().min(0).max(1).default(1),

  /* ---- การค้นหาเชิงความหมายด้วยโมเดลในเครื่อง (F20) ---- */

  /** 0 = ปิด semantic search; lexical search และระบบหลักยังทำงานตามปกติ */
  S2_NAS_SEMANTIC_ENABLED: z.coerce.number().int().min(0).max(1).default(0),
  /**
   * โฟลเดอร์โมเดลที่ provision ไว้แล้ว โมเดลไม่มีสิทธิ์ดาวน์โหลดไฟล์ตอน runtime
   * ค่าปริยายอยู่ใน backend/models และถูก ignore จาก Git
   */
  S2_NAS_EMBEDDING_MODEL_PATH: z.string().min(1).default('./models/semantic/paraphrase-multilingual-minilm-l12-v2'),
  /** semantic worker ตั้งใจทำทีละงานเพื่อไม่แย่ง CPU/RAM จาก upload, extract และ OCR */
  S2_NAS_SEMANTIC_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(1),
  S2_NAS_SEMANTIC_POLL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
  /** เพดานป้องกันเอกสารผิดปกติ; การตัดจะถูกแสดงในสถานะดัชนี */
  S2_NAS_SEMANTIC_MAX_TEXT_CHARS: z.coerce.number().int().min(1000).default(400_000),
  S2_NAS_SEMANTIC_MAX_CHUNKS: z.coerce.number().int().min(1).max(4096).default(256),
  S2_NAS_SEMANTIC_CHUNK_TOKENS: z.coerce.number().int().min(64).max(480).default(448),
  S2_NAS_SEMANTIC_OVERLAP_TOKENS: z.coerce.number().int().min(0).max(128).default(64),
  S2_NAS_SEMANTIC_JOB_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(1800).default(180),
  /**
   * เพดานงานที่รอคิวอนุมานได้พร้อมกัน
   *
   * คิวที่ไม่มีขอบเขตจะกลืนงานค้างไว้เงียบ ๆ จนหน่วยความจำหมด การปฏิเสธ
   * อย่างชัดเจนทำให้ผู้เรียกรู้ตัวและถอยได้
   */
  /**
   * จำนวน chunk ต่อหนึ่งครั้งที่ส่งเข้าโมเดลระหว่างทำดัชนี
   *
   * ค่านี้กำหนด "ช่วงรอที่แย่ที่สุด" ของคำค้นผู้ใช้โดยตรง เพราะงานที่กำลังรันอยู่
   * จะไม่ถูกตัดกลางคัน คำค้นจึงรออย่างมากหนึ่งแบตช์
   *
   * วัดบนเครื่องจริง: แบตช์ 8 ทำให้คำค้นรอ ~2.4 วินาที, แบตช์ 4 ~1.2 วินาที
   * ขณะที่กำลังการผลิตของงานเบื้องหลังต่างกันเพียงเล็กน้อย
   */
  S2_NAS_SEMANTIC_EMBED_BATCH: z.coerce.number().int().min(1).max(64).default(4),
  S2_NAS_SEMANTIC_QUEUE_LIMIT: z.coerce.number().int().min(4).max(1024).default(64),
  S2_NAS_SEMANTIC_CANDIDATE_LIMIT: z.coerce.number().int().min(20).max(1000).default(200),
  /**
   * cosine similarity ขั้นต่ำก่อนผล semantic จะเข้าสู่การจัดอันดับ
   *
   * ค่านี้ผูกกับโมเดล ไม่ใช่ค่าสากล - ตระกูล E5 ให้คะแนนอัดแน่นในช่วงสูง
   * ส่วนโมเดล paraphrase แบบสมมาตรกระจายคะแนนกว้างกว่ามาก
   *
   * วัดจากคลังเอกสารธุรกิจจริง (19 คำค้นที่ควรเจอ + 5 คำค้นที่ไม่ควรเจออะไรเลย):
   *   คำค้นที่ควรเจอ   คะแนนสูงสุด ต่ำสุด 0.4887  มัธยฐาน 0.6944
   *   คำค้นที่ไม่ควรเจอ คะแนนสูงสุด สูงสุด 0.3055  มัธยฐาน 0.0912
   * 0.40 อยู่กึ่งกลางช่องว่างนั้นพอดี เหลือระยะกันชนราว 0.09 ทั้งสองด้าน
   *
   * เลือกใช้เกณฑ์คะแนนสัมบูรณ์อย่างเดียว ไม่ใช้กฎ "คะแนนตกจากอันดับหนึ่ง"
   * เพราะข้อมูลจริงบอกว่าระยะห่างอันดับ 1-2 ของคำค้นที่ควรเจอต่ำสุดคือ 0.0298
   * ซึ่งทับกับของคำค้นที่ไม่ควรเจอ (สูงสุด ~0.0155) - กฎนั้นจะตัดผลที่ถูกต้องทิ้ง
   */
  S2_NAS_SEMANTIC_MIN_SCORE: z.coerce.number().min(-1).max(1).default(0.4),

  /* ---- ผู้ช่วยเอกสารแบบ local-only (F21) ---- */
  /** ปิดโดยปริยายจนกว่าจะ provision และผ่าน real-model QA */
  S2_NAS_ASSISTANT_ENABLED: z.coerce.number().int().min(0).max(1).default(0),
  S2_NAS_ASSISTANT_PROVIDER: z.enum(['LLAMA_CPP', 'FAKE']).default('LLAMA_CPP'),
  S2_NAS_ASSISTANT_MODEL_PATH: z.string().min(1).default('./models/assistant/model.gguf'),
  S2_NAS_ASSISTANT_LLAMA_BIN: z.string().min(1).default('./models/assistant/llama-cli.exe'),
  /**
   * ตัวนับ token จริงจาก vocab ของโมเดล
   *
   * ตัววางแผนงบ (budget.ts) ต้องรู้ขนาด prompt ก่อนเรียกโมเดล การเดาจากจำนวน
   * ตัวอักษรใช้ไม่ได้เพราะภาษาไทยกินประมาณ 0.61 token ต่อตัวอักษร แต่อังกฤษ
   * ประมาณ 0.25 ต่างกันเกินสองเท่า ถ้าเดาต่ำไปตัววางแผนจะคิดว่ามีที่ว่างมากกว่าจริง
   * แล้วอนุมัติคำขอที่ล้น context - ซึ่งคือ F21-D1 ที่กำลังแก้อยู่พอดี
   *
   * ไบนารีนี้โหลดเฉพาะ vocab ไม่ได้โหลดน้ำหนักโมเดล จึงใช้เวลาราว 0.4 วินาที
   */
  S2_NAS_ASSISTANT_TOKENIZER_BIN: z.string().min(1).default('./models/assistant/llama-tokenize.exe'),
  S2_NAS_ASSISTANT_MODEL_ID: z.string().min(1).max(191).default('Qwen3-4B-Instruct'),
  S2_NAS_ASSISTANT_QUANTIZATION: z.string().min(1).max(32).default('Q4_K_M'),
  S2_NAS_ASSISTANT_CONTEXT_TOKENS: z.coerce.number().int().min(2048).max(131072).default(8192),
  S2_NAS_ASSISTANT_THREADS: z.coerce.number().int().min(1).max(64).default(4),
  S2_NAS_ASSISTANT_BATCH_SIZE: z.coerce.number().int().min(32).max(2048).default(256),
  /**
   * เพดาน token ที่โมเดลสร้างได้ต่อคำตอบ
   *
   * วัดบนเครื่องจริง: generation ~3.4 tokens/s ดังนั้น 768 tokens = ~226 วินาที ซึ่งเกิน
   * S2_NAS_ASSISTANT_TIMEOUT_SECONDS (180) ด้วยตัวมันเองโดยยังไม่นับเวลาอ่าน prompt เลย
   * คำตอบที่ยาวจริงจึงถูกตัดด้วย timeout เสมอแทนที่จะตอบจบ
   *
   * 384 tokens = ~113 วินาที ยังเหลือเวลาให้ prompt eval และยังมากกว่าคำตอบที่วัดได้จริง
   * (23-58 tokens) หลายเท่า
   */
  S2_NAS_ASSISTANT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(4096).default(384),
  S2_NAS_ASSISTANT_MAX_QUESTION_CHARS: z.coerce.number().int().min(100).max(20000).default(4000),
  S2_NAS_ASSISTANT_MAX_SELECTED_RESOURCES: z.coerce.number().int().min(1).max(50).default(20),
  S2_NAS_ASSISTANT_CANDIDATE_LIMIT: z.coerce.number().int().min(10).max(100).default(40),
  S2_NAS_ASSISTANT_EVIDENCE_LIMIT: z.coerce.number().int().min(1).max(20).default(10),
  /**
   * เพดานความยาวรวมของหลักฐานที่ส่งเข้าโมเดล
   *
   * **นี่คือขอบเขตความถูกต้อง ไม่ใช่แค่เรื่องความเร็ว** วัดได้ว่า 1 ตัวอักษรของหลักฐาน
   * กลายเป็นประมาณ 0.61 prompt token ค่าเดิม 24,000 ตัวอักษรจึงเท่ากับราว 14,600 tokens
   * ซึ่งเกิน context window ที่ตั้งไว้ 8,192 tokens
   *
   * เมื่อ prompt ยาวเกิน context llama.cpp จะตัดทิ้งเงียบ ๆ โมเดลจึงถูกขอให้อ้างอิง
   * หลักฐานที่มันไม่เคยเห็น - เป็นการอ้างอิงที่ตรวจไม่พบว่าผิด
   *
   * 12,000 ตัวอักษร = ~7,300 tokens ยังอยู่ใต้ context พร้อมที่ว่างสำหรับ system prompt
   * และประวัติการสนทนา
   */
  S2_NAS_ASSISTANT_MAX_EVIDENCE_CHARS: z.coerce.number().int().min(1000).max(100000).default(12000),
  S2_NAS_ASSISTANT_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(900).default(180),
  S2_NAS_ASSISTANT_QUEUE_LIMIT: z.coerce.number().int().min(1).max(50).default(5),

  /* ---- OCR สำหรับเอกสารสแกน (F13) ---- */

  /**
   * OCR เป็นความสามารถเสริม ไม่ใช่สิ่งที่ระบบต้องมีจึงจะทำงานได้
   *
   * ถ้าเครื่องมือไม่พร้อม S2 NAS ต้องเริ่มทำงานได้ตามปกติ และรายงานว่า OCR ไม่พร้อมอย่างตรงไปตรงมา
   * ค่าตั้งที่ผิดจึงทำให้ "OCR ใช้ไม่ได้" ไม่ใช่ "ระบบเริ่มไม่ได้"
   */
  S2_NAS_OCR_ENABLED: z.coerce.number().int().min(0).max(1).default(0),
  /** เส้นทางของโปรแกรม OCR ในเครื่อง - ไม่พึ่ง PATH และไม่มีการดาวน์โหลดอะไรเอง */
  S2_NAS_OCR_BIN: z.string().optional(),
  /**
   * ภาษาที่ใช้อ่าน - ต้องระบุภาษาไทยด้วยเสมอสำหรับเอกสารไทย
   * การปล่อยให้อ่านด้วยภาษาอังกฤษอย่างเดียวจะได้ข้อความขยะที่ดูเหมือนสำเร็จ
   */
  S2_NAS_OCR_LANGUAGES: z.string().min(1).max(64).default('tha+eng'),
  /** จำนวนหน้าสูงสุดต่อเอกสารหนึ่งฉบับ - หน้าที่เกินถูกบันทึกว่าอ่านไม่ครบ ไม่ใช่เงียบ ๆ */
  S2_NAS_OCR_MAX_PAGES: z.coerce.number().int().min(1).max(500).default(50),
  /** เวลาสูงสุดต่อหนึ่งหน้า */
  S2_NAS_OCR_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(60000),
  /** OCR กิน CPU มาก ค่าเริ่มต้นจึงเป็นหนึ่ง - การที่ระบบยังรับงานได้สำคัญกว่า */
  S2_NAS_OCR_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  /** ขนาดไฟล์ภาพสูงสุดที่ยอมอ่าน */
  S2_NAS_OCR_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(32 * 1024 * 1024),
  /** จำนวนพิกเซลรวมสูงสุด - กันภาพที่บีบอัดมาเล็กแต่คลายออกมาใหญ่มหาศาล */
  S2_NAS_OCR_MAX_PIXELS: z.coerce.number().int().positive().default(80_000_000),
  /** รากของไฟล์ชั่วคราวระหว่างทำ OCR - ต้องอยู่นอกพื้นที่จัดเก็บของผู้ใช้ */
  S2_NAS_OCR_TEMP_ROOT: z.string().optional(),

  /**
   * รากของชุดสำรองข้อมูล - ต้องอยู่นอก S2_NAS_STORAGE_ROOT เสมอ
   * มิฉะนั้นการสำรอง storage จะไล่สำรองชุดสำรองของตัวเองซ้อนกันไปเรื่อย ๆ
   */
  S2_NAS_BACKUP_ROOT: z.string().min(1).default('./backups'),
  /** พื้นที่พักสำหรับ restore แบบ staged - ไม่ใช่พื้นที่ใช้งานจริง */
  S2_NAS_RESTORE_STAGE_ROOT: z.string().min(1).optional(),
  /** โฟลเดอร์ของ MariaDB client (mariadb-dump / mariadb) - ไม่พึ่ง PATH ของเครื่อง */
  S2_NAS_MARIADB_BIN: z.string().optional(),
  /**
   * คำนำหน้าชื่อฐานข้อมูลสำหรับ staged restore
   * บัญชีของแอปสร้างฐานข้อมูลได้เฉพาะบาง namespace เท่านั้น จึงต้องตั้งค่าได้
   */
  S2_NAS_RESTORE_DB_PREFIX: z.string().min(1).default('test_s2nas_restore_'),

  /* ---- การสำรองข้อมูลอัตโนมัติ (ค่าเริ่มต้น ปรับต่อได้ที่หน้าตั้งค่า) ---- */
  S2_NAS_BACKUP_ENABLED: booleanish.default('true'),
  S2_NAS_BACKUP_TIME: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).default('02:00'),
  /** โซนเวลาที่ใช้ตีความเวลาสำรองข้อมูล - ห้ามสมมติว่าเป็น UTC */
  S2_NAS_BACKUP_TIMEZONE: z.string().min(1).default('Asia/Bangkok'),
  S2_NAS_BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  S2_NAS_BACKUP_MIN_KEEP_COUNT: z.coerce.number().int().positive().default(7),
  /**
   * เวลาที่ยอมให้ "ตามเก็บ" งานที่พลาดไปเพราะเซิร์ฟเวอร์ดับ
   * ถ้าพลาดไปนานกว่านี้ ให้รอรอบถัดไปแทนการสำรองย้อนหลังแบบไม่มีความหมาย
   */
  S2_NAS_BACKUP_CATCHUP_GRACE_HOURS: z.coerce.number().int().nonnegative().default(6),
  /** เตือนเมื่อไม่มีชุดสำรองที่สำเร็จภายในกี่ชั่วโมง */
  S2_NAS_BACKUP_STALE_HOURS: z.coerce.number().int().positive().default(48),

  /* ---- สำเนานอกเครื่อง (deployment configuration ไม่ใช่ค่าที่แก้ผ่านหน้าเว็บ) ---- */
  S2_NAS_OFFSITE_COPY_ENABLED: booleanish.default('false'),
  S2_NAS_OFFSITE_BACKUP_ROOT: z.string().optional(),
  S2_NAS_OFFSITE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  /* ---- เข้าสู่ระบบด้วย Google (ยืนยันตัวตนอย่างเดียว) ---- */
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  /** ความลับนี้ต้องอยู่ฝั่ง backend เท่านั้น ห้ามส่งออกไปที่เบราว์เซอร์ */
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().optional(),

  /**
   * OAuth client แยกสำหรับการเชื่อมต่อ Google Drive (F19)
   *
   * ตั้งใจไม่ถอยไปใช้ client ของการเข้าสู่ระบบเมื่อไม่ได้ตั้งค่า - สองอย่างนี้
   * ขอสิทธิ์คนละระดับ ถ้าใช้ร่วมกัน หน้าจอยินยอมตอนล็อกอินจะขอสิทธิ์อ่าน Drive
   * ไปด้วยทุกครั้ง ซึ่งผู้ใช้ไม่ได้ขอและไม่ควรต้องยอมรับเพื่อจะเข้าระบบ
   */
  GOOGLE_DRIVE_CLIENT_ID: z.string().optional(),
  GOOGLE_DRIVE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_DRIVE_REDIRECT_URI: z.string().optional(),

  /**
   * กุญแจเข้ารหัสข้อมูลรับรองของการเชื่อมต่อภายนอก - base64 หรือ hex ที่ถอดแล้วได้ 32 ไบต์
   *
   * ถ้าไม่มี การเชื่อมต่อ Google Drive จะถูกปิดทั้งฟีเจอร์ แทนที่จะเก็บ token
   * เป็นข้อความธรรมดา
   */
  S2_NAS_INTEGRATION_ENCRYPTION_KEY: z.string().optional(),

  /** รอบตรวจการเปลี่ยนแปลงฝั่ง Google - ค่าเริ่มต้น 15 นาที */
  S2_NAS_DRIVE_SYNC_POLL_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),
  S2_NAS_DRIVE_SYNC_ENABLED: z.coerce.number().int().min(0).max(1).default(1),
  /** จำนวนไฟล์ที่ดาวน์โหลดพร้อมกัน - มากเกินไปจะชนโควตาของ Google */
  S2_NAS_DRIVE_SYNC_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  /** ที่อยู่ของหน้าเว็บ ใช้พาผู้ใช้กลับหลังจบขั้นตอนกับ Google */
  S2_NAS_APP_ORIGIN: z.string().default('http://localhost:8888'),

  /* ---- ล็อกข้ามอินสแตนซ์ ---- */
  /** เวลารอล็อกสูงสุด - สั้นโดยตั้งใจ ตอบว่าไม่ว่างดีกว่าค้างรอ */
  S2_NAS_BACKUP_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(60).default(10),

  /* ---- การซ้อมกู้คืน ---- */
  S2_NAS_RESTORE_REHEARSAL_ENABLED: booleanish.default('true'),
  /** 0 = อาทิตย์ ... 6 = เสาร์ ตามโซนเวลาเดียวกับตารางสำรองข้อมูล */
  S2_NAS_RESTORE_REHEARSAL_DAY: z.coerce.number().int().min(0).max(6).default(0),
  S2_NAS_RESTORE_REHEARSAL_TIME: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).default('03:30'),
  /** เตือนเมื่อไม่มีการซ้อมกู้คืนสำเร็จภายในกี่วัน */
  S2_NAS_REHEARSAL_STALE_DAYS: z.coerce.number().int().positive().default(14),
  /** พื้นที่พักของการซ้อม - ต้องแยกจาก storage, backup และ offsite */
  S2_NAS_REHEARSAL_STAGE_ROOT: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().default(''),
  JWT_REFRESH_SECRET: z.string().default(''),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  STRICT_DB_STARTUP: booleanish.default('false'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // ห้ามให้ backend start แบบเงียบ ๆ เมื่อ environment ไม่ถูกต้อง
  console.error('\n[CONFIG] Environment ไม่ถูกต้อง:\n' + issues + '\n');
  process.exit(1);
}

const raw = parsed.data;

if (raw.NODE_ENV === 'production' && (raw.JWT_ACCESS_SECRET.length < 32 || raw.JWT_REFRESH_SECRET.length < 32)) {
  console.error('\n[CONFIG] JWT secrets ต้องยาวอย่างน้อย 32 ตัวอักษรใน production\n');
  process.exit(1);
}

/** Storage root ที่ resolve เป็น absolute path แล้ว (ใช้ภายใน backend เท่านั้น) */
const storageRoot = path.isAbsolute(raw.S2_NAS_STORAGE_ROOT)
  ? path.normalize(raw.S2_NAS_STORAGE_ROOT)
  : path.resolve(BACKEND_ROOT, raw.S2_NAS_STORAGE_ROOT);

const embeddingModelPath = path.isAbsolute(raw.S2_NAS_EMBEDDING_MODEL_PATH)
  ? path.normalize(raw.S2_NAS_EMBEDDING_MODEL_PATH)
  : path.resolve(BACKEND_ROOT, raw.S2_NAS_EMBEDDING_MODEL_PATH);

const assistantModelPath = path.isAbsolute(raw.S2_NAS_ASSISTANT_MODEL_PATH)
  ? path.normalize(raw.S2_NAS_ASSISTANT_MODEL_PATH)
  : path.resolve(BACKEND_ROOT, raw.S2_NAS_ASSISTANT_MODEL_PATH);
const assistantLlamaBin = path.isAbsolute(raw.S2_NAS_ASSISTANT_LLAMA_BIN)
  ? path.normalize(raw.S2_NAS_ASSISTANT_LLAMA_BIN)
  : path.resolve(BACKEND_ROOT, raw.S2_NAS_ASSISTANT_LLAMA_BIN);
const assistantTokenizerBin = path.isAbsolute(raw.S2_NAS_ASSISTANT_TOKENIZER_BIN)
  ? path.normalize(raw.S2_NAS_ASSISTANT_TOKENIZER_BIN)
  : path.resolve(BACKEND_ROOT, raw.S2_NAS_ASSISTANT_TOKENIZER_BIN);

/** รากของชุดสำรอง resolve เป็น absolute path แล้ว (ใช้ภายใน backend เท่านั้น) */
const backupRoot = path.isAbsolute(raw.S2_NAS_BACKUP_ROOT)
  ? path.normalize(raw.S2_NAS_BACKUP_ROOT)
  : path.resolve(BACKEND_ROOT, raw.S2_NAS_BACKUP_ROOT);

const restoreStageRoot = raw.S2_NAS_RESTORE_STAGE_ROOT
  ? (path.isAbsolute(raw.S2_NAS_RESTORE_STAGE_ROOT)
      ? path.normalize(raw.S2_NAS_RESTORE_STAGE_ROOT)
      : path.resolve(BACKEND_ROOT, raw.S2_NAS_RESTORE_STAGE_ROOT))
  : path.join(backupRoot, '_restore-stage');

/**
 * ชุดสำรองต้องไม่อยู่ใต้ storage ที่กำลังถูกสำรอง
 * ถ้าปล่อยผ่าน การสำรองครั้งที่สองจะกินชุดสำรองครั้งแรกเข้าไปด้วย และโตแบบทวีคูณ
 */
const withinStorage = (target: string): boolean => {
  const rel = path.relative(storageRoot, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** ทั้งสองรากต้องไม่ซ้อนกันไม่ว่าทางใด - ซ้อนกันเมื่อไรก็คัดลอกตัวเองไม่รู้จบเมื่อนั้น */
const nested = (a: string, b: string): boolean => {
  const rel = path.relative(a, b);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

if (withinStorage(backupRoot) || nested(backupRoot, storageRoot)) {
  console.error('\n[CONFIG] S2_NAS_BACKUP_ROOT ต้องไม่ซ้อนกับ S2_NAS_STORAGE_ROOT ไม่ว่าทางใด\n');
  process.exit(1);
}

const rehearsalStageRoot = raw.S2_NAS_REHEARSAL_STAGE_ROOT
  ? (path.isAbsolute(raw.S2_NAS_REHEARSAL_STAGE_ROOT)
      ? path.normalize(raw.S2_NAS_REHEARSAL_STAGE_ROOT)
      : path.resolve(BACKEND_ROOT, raw.S2_NAS_REHEARSAL_STAGE_ROOT))
  : path.join(backupRoot, '_rehearsal-stage');

const offsiteRoot = raw.S2_NAS_OFFSITE_BACKUP_ROOT
  ? (path.isAbsolute(raw.S2_NAS_OFFSITE_BACKUP_ROOT)
      ? path.normalize(raw.S2_NAS_OFFSITE_BACKUP_ROOT)
      : path.resolve(BACKEND_ROOT, raw.S2_NAS_OFFSITE_BACKUP_ROOT))
  : null;

/**
 * ปลายทางนอกเครื่องต้องไม่ซ้อนกับ storage หรือ backup root
 * ถ้าซ้อน การคัดลอกออกนอกเครื่องจะคัดลอกตัวมันเองซ้ำไปเรื่อย ๆ
 */
if (offsiteRoot && (nested(offsiteRoot, storageRoot) || nested(storageRoot, offsiteRoot) ||
    nested(offsiteRoot, backupRoot) || nested(backupRoot, offsiteRoot))) {
  console.error('\n[CONFIG] S2_NAS_OFFSITE_BACKUP_ROOT ต้องไม่ซ้อนกับ storage หรือ backup root\n');
  process.exit(1);
}

/**
 * พื้นที่พักของการซ้อมต้องไม่ทับ storage จริงเด็ดขาด
 * มิฉะนั้นการซ้อมกู้คืนจะเขียนทับไฟล์ที่ใช้งานอยู่ ซึ่งเป็นสิ่งที่การซ้อมต้องไม่ทำ
 */
if (nested(rehearsalStageRoot, storageRoot) || nested(storageRoot, rehearsalStageRoot) ||
    (offsiteRoot && (nested(rehearsalStageRoot, offsiteRoot) || nested(offsiteRoot, rehearsalStageRoot)))) {
  console.error('\n[CONFIG] พื้นที่พักของการซ้อมกู้คืนต้องไม่ซ้อนกับ storage หรือปลายทางนอกเครื่อง\n');
  process.exit(1);
}

export const env = {
  ...raw,
  STORAGE_ROOT: storageRoot,
  BACKUP_ROOT: backupRoot,
  RESTORE_STAGE_ROOT: restoreStageRoot,
  OFFSITE_BACKUP_ROOT: offsiteRoot,
  REHEARSAL_STAGE_ROOT: rehearsalStageRoot,
  EMBEDDING_MODEL_PATH: embeddingModelPath,
  ASSISTANT_MODEL_PATH: assistantModelPath,
  ASSISTANT_LLAMA_BIN: assistantLlamaBin,
  ASSISTANT_TOKENIZER_BIN: assistantTokenizerBin,
  MAX_UPLOAD_SIZE_BYTES: raw.S2_NAS_MAX_UPLOAD_BYTES ?? raw.MAX_UPLOAD_SIZE_MB * 1024 * 1024,
  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
  isTest: raw.NODE_ENV === 'test',
  /** ค่าเริ่มต้นคือ origin แรกที่อนุญาต ซึ่งคือที่อยู่ของหน้าเว็บอยู่แล้ว */
  publicBaseUrl:
    raw.S2_NAS_PUBLIC_BASE_URL ??
    raw.CORS_ORIGIN.split(',')[0]?.trim() ??
    'http://localhost:8888',
  corsOrigins: raw.CORS_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
} as const;

export type Env = typeof env;
