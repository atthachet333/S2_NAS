import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import {
  CopyObjectCommand, DeleteObjectsCommand, DeleteObjectCommand, GetObjectCommand,
  HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { env } from '../../config/env.js';
import { AppError } from '../errors.js';
import { logger } from '../logger.js';
import type {
  StagedObject, StorageHealth, StorageProvider, StorageStat, StoredObject,
} from './provider.js';

/**
 * พื้นที่จัดเก็บบนบริการที่เข้ากันได้กับ S3 (F23-C)
 *
 * **ทั่วไป ไม่ผูกกับผู้ให้บริการรายใดรายหนึ่ง** ปลายทาง ภูมิภาค ถัง และรูปแบบเส้นทาง
 * มาจากค่าตั้งทั้งหมด จึงใช้ได้กับ AWS S3, Cloudflare R2, MinIO และบริการอื่นที่พูดภาษาเดียวกัน
 *
 * **ถังต้องเป็นแบบส่วนตัวเสมอ** ไม่มีที่ใดในไฟล์นี้ตั้ง ACL ไม่มีการสร้าง URL ที่ลงลายมือชื่อ
 * และไม่มีเส้นทางใดที่ทำให้เบราว์เซอร์คุยกับถังโดยตรง การอ่านทุกครั้งผ่านเซิร์ฟเวอร์ NAS
 * ซึ่งตรวจสิทธิ์เสร็จแล้วก่อนจะมาถึงที่นี่
 *
 * **ETag ไม่ใช่ checksum ของเรา** ETag ของวัตถุที่อัปโหลดแบบหลายส่วนไม่ใช่ SHA-256
 * ของเนื้อไฟล์ และต่อให้เป็น MD5 ก็ยังไม่ใช่สิ่งที่ NAS ใช้ตัดสินความสมบูรณ์
 * checksum ที่เชื่อถือได้คือค่าที่ชั้นแอปคำนวณจากไบต์ที่ไหลผ่านจริงเท่านั้น
 */

export interface S3ProviderConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** คำนำหน้าที่ทำให้เป็นรูปแบบเดียวแล้ว - ไม่มี / นำหน้าและไม่มี / ต่อท้าย */
  prefix: string;
}

/** ข้อผิดพลาดจากฝั่งบริการที่แยกความหมายแล้ว - ใช้ตัดสินใจต่อได้โดยไม่ต้องเดาจากข้อความ */
export type S3FailureKind = 'NOT_FOUND' | 'ACCESS_DENIED' | 'BUCKET_MISSING' | 'UNREACHABLE' | 'UNKNOWN';

/**
 * รหัสความล้มเหลวของเครือข่ายจากชั้นล่างของ Node
 *
 * **พบจากการยิงไปยังปลายทางจริงที่ติดต่อไม่ได้** ข้อผิดพลาดของซ็อกเก็ตมาในรูป
 * name = "Error" และรหัสจริงอยู่ที่ฟิลด์ code ต่างจากข้อผิดพลาดของ SDK ที่ใส่ชื่อไว้ใน name
 * การดูเฉพาะ name จึงทำให้ "ต่อไม่ติด" ถูกจำแนกเป็น "ไม่ทราบสาเหตุ" แล้วรายงานเป็น 502
 * แทนที่จะเป็น 503 ซึ่งชี้ให้คนไปแก้ผิดที่
 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH',
  'ENETUNREACH', 'EPIPE', 'EAI_AGAIN', 'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

export function classifyS3Error(error: unknown): S3FailureKind {
  const err = error as {
    name?: string; $metadata?: { httpStatusCode?: number }; Code?: string; code?: string;
    cause?: { code?: string; name?: string };
  };
  /**
   * ดูทุกช่องที่รหัสอาจอยู่ ไม่ใช่ช่องแรกที่ไม่ว่าง
   *
   * ผู้ให้บริการแต่ละรายและชั้นขนส่งแต่ละแบบวางรหัสไว้คนละที่ การเลือกดูช่องเดียว
   * ทำให้การจำแนกถูกต้องกับบางปลายทางเท่านั้น ซึ่งแย่กว่าการไม่จำแนกเลย
   */
  const candidates = [err?.name, err?.Code, err?.code, err?.cause?.code, err?.cause?.name]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (candidates.some((value) => NETWORK_ERROR_CODES.has(value))) return 'UNREACHABLE';

  const name = candidates[0] ?? '';
  const status = err?.$metadata?.httpStatusCode;

  const has = (...names: string[]): boolean => candidates.some((value) => names.includes(value));

  if (has('NoSuchBucket')) return 'BUCKET_MISSING';
  if (has('NoSuchKey', 'NotFound') || status === 404) {
    // ถังที่ไม่มีอยู่กับวัตถุที่ไม่มีอยู่ตอบ 404 เหมือนกัน แต่ความหมายต่างกันมาก
    return 'NOT_FOUND';
  }
  if (has('AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'Forbidden',
    'CredentialsProviderError', 'InvalidRequest') || status === 401 || status === 403) return 'ACCESS_DENIED';
  if (has('TimeoutError', 'NetworkingError', 'AbortError', 'RequestTimeout')) return 'UNREACHABLE';
  // 5xx จากฝั่งบริการคือปลายทางมีปัญหา ไม่ใช่คำขอของเราผิด
  if (typeof status === 'number' && status >= 500) return 'UNREACHABLE';
  return 'UNKNOWN';
}

/**
 * แปลงความล้มเหลวของโครงสร้างพื้นฐานเป็นข้อผิดพลาดของระบบ
 *
 * **ห้ามยุบทุกอย่างเป็น "ไม่พบไฟล์"** วัตถุที่หายไปจริงกับบริการที่ติดต่อไม่ได้
 * ต้องการการแก้คนละแบบสิ้นเชิง การรายงานผิดจะทำให้คนไล่หาไฟล์ที่ไม่เคยหาย
 */
function toAppError(error: unknown, operation: string): AppError {
  const kind = classifyS3Error(error);
  switch (kind) {
    case 'ACCESS_DENIED':
      return new AppError('STORAGE_ACCESS_DENIED', 'พื้นที่จัดเก็บปฏิเสธการเข้าถึง', 502);
    case 'BUCKET_MISSING':
      return new AppError('STORAGE_BUCKET_MISSING', 'ไม่พบถังเก็บวัตถุที่ตั้งค่าไว้', 502);
    case 'UNREACHABLE':
      return new AppError('STORAGE_UNAVAILABLE', 'ติดต่อพื้นที่จัดเก็บไม่ได้', 503);
    case 'NOT_FOUND':
      return new AppError('STORAGE_OBJECT_NOT_FOUND', 'ไม่พบวัตถุในพื้นที่จัดเก็บ', 404);
    default:
      logger.error({ operation, kind }, '[STORAGE] ปฏิบัติการกับพื้นที่จัดเก็บล้มเหลว');
      return new AppError('STORAGE_OPERATION_FAILED', 'ปฏิบัติการกับพื้นที่จัดเก็บไม่สำเร็จ', 502);
  }
}

export class S3StorageProvider implements StorageProvider {
  readonly kind = 'S3' as const;

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(config: S3ProviderConfig, client?: S3Client) {
    this.bucket = config.bucket;
    this.prefix = config.prefix;
    this.client = client ?? new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  /** รูปแบบคีย์เดียวกับดิสก์ เพื่อให้ย้ายข้ามผู้ให้บริการได้โดยคีย์เชิงตรรกะไม่เปลี่ยน */
  createStorageKey(resourceId: string): string {
    return `resources/${resourceId}/${crypto.randomUUID()}`;
  }

  /** ไม่มีโฟลเดอร์ให้สร้างในที่เก็บวัตถุ คีย์คือสิ่งเดียวที่มีอยู่จริง */
  async prepare(): Promise<void> {
    /* ไม่ต้องเตรียมอะไร */
  }

  /**
   * เขียนวัตถุจากสตรีม พร้อมวัดขนาดและ checksum จากไบต์ที่ไหลผ่านจริง
   *
   * ค่าที่คืนมาจากการวัดของเราเอง ไม่ใช่จากคำตอบของบริการ เพราะสิ่งที่ต้องพิสูจน์คือ
   * "ไบต์ที่เราตั้งใจเขียน" ตรงกับ "ไบต์ที่บันทึกไว้ใน metadata" ไม่ใช่ว่าบริการตอบว่าอะไร
   */
  async put(key: string, source: Readable): Promise<StoredObject> {
    const hash = crypto.createHash('sha256');
    let size = 0;
    const measured = Readable.from((async function* () {
      for await (const chunk of source) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        hash.update(buffer);
        yield buffer;
      }
    })());

    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket, Key: this.physicalKey(key), Body: measured,
      }));
    } catch (error) {
      throw toAppError(error, 'put');
    }
    return { size, checksum: hash.digest('hex') };
  }

  /**
   * อัปโหลดไฟล์ที่พักไว้ขึ้นเป็นวัตถุ
   *
   * สตรีมจากไฟล์ที่พักไว้โดยตรง ไม่อ่านทั้งก้อนเข้าหน่วยความจำ และส่ง ContentLength
   * ที่รู้อยู่แล้วจากขั้นตอนพัก เพื่อให้ไม่ต้องบัฟเฟอร์เพื่อหาความยาว
   *
   * ขนาดกับ checksum มาจากขั้นตอนพักซึ่งวัดจากไบต์ชุดเดียวกัน จึงไม่คำนวณซ้ำที่นี่
   * การลบไฟล์ที่พักไว้ยังเป็นหน้าที่ของชั้นที่สร้างมัน ไม่ใช่ของผู้ให้บริการ
   */
  async commitStaged(key: string, staged: StagedObject): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.physicalKey(key),
        Body: fs.createReadStream(staged.path),
        ContentLength: staged.size,
      }));
    } catch (error) {
      throw toAppError(error, 'commitStaged');
    }
  }

  async getStream(key: string): Promise<Readable> {
    try {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket, Key: this.physicalKey(key),
      }));
      return asReadable(result.Body);
    } catch (error) {
      throw toAppError(error, 'getStream');
    }
  }

  /**
   * ช่วงไบต์แบบรวมปลายทั้งสองด้าน
   *
   * ส่งเป็นหัวข้อ Range ให้บริการตัดให้ ไม่ดึงวัตถุทั้งก้อนลงมาแล้วค่อยตัดเอง
   * ซึ่งจะทำให้การเปิดวิดีโอหรือ PDF หน้าท้าย ๆ ต้องโหลดทั้งไฟล์ก่อนทุกครั้ง
   */
  async getRangeStream(key: string, start: number, end: number): Promise<Readable> {
    try {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket, Key: this.physicalKey(key), Range: `bytes=${start}-${end}`,
      }));
      return asReadable(result.Body);
    } catch (error) {
      throw toAppError(error, 'getRangeStream');
    }
  }

  /**
   * ข้อมูลของวัตถุ - null เมื่อไม่มีวัตถุนั้นจริง ๆ เท่านั้น
   *
   * ความล้มเหลวของโครงสร้างพื้นฐานถูกโยนต่อ ไม่ถูกแปลงเป็น null เพราะ null แปลว่า
   * "ตรวจแล้วไม่มี" ซึ่งเป็นคำตอบที่เราไม่มีสิทธิ์ให้เมื่อยังติดต่อบริการไม่ได้
   */
  async stat(key: string): Promise<StorageStat | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket, Key: this.physicalKey(key),
      }));
      return {
        size: Number(result.ContentLength ?? 0),
        mtime: result.LastModified ?? new Date(0),
      };
    } catch (error) {
      if (classifyS3Error(error) === 'NOT_FOUND') return null;
      throw toAppError(error, 'stat');
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  /**
   * ลบวัตถุ - คืน true เมื่อไม่มีวัตถุนั้นเหลืออยู่แล้ว
   *
   * S3 ตอบสำเร็จแม้ลบคีย์ที่ไม่มีอยู่ ซึ่งตรงกับความหมายที่ผู้เรียกต้องการอยู่แล้ว
   * ความล้มเหลวจริงคืน false เพื่อให้ผู้เรียกรายงานตามจริง เหมือนผู้ให้บริการบนดิสก์
   */
  async delete(key: string): Promise<boolean> {
    try {
      await this.client.send(new DeleteObjectCommand({
        Bucket: this.bucket, Key: this.physicalKey(key),
      }));
      return true;
    } catch (error) {
      const kind = classifyS3Error(error);
      if (kind === 'NOT_FOUND') return true;
      logger.error({ kind, provider: this.kind }, '[STORAGE] ลบวัตถุไม่สำเร็จ');
      return false;
    }
  }

  /** คัดลอกที่ฝั่งบริการ ไม่ดึงลงมาแล้วส่งกลับขึ้นไป */
  async copy(fromKey: string, toKey: string): Promise<void> {
    try {
      await this.client.send(new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${this.physicalKey(fromKey)}`,
        Key: this.physicalKey(toKey),
      }));
    } catch (error) {
      throw toAppError(error, 'copy');
    }
  }

  /**
   * ลบทุกวัตถุของทรัพยากรหนึ่ง
   *
   * **ขอบเขตแคบโดยตั้งใจ** แจกแจงเฉพาะใต้คำนำหน้าที่ตั้งไว้ต่อด้วย resources/<id>/ เท่านั้น
   * ถังหนึ่งอาจมีข้อมูลของระบบอื่นอยู่ด้วย การแจกแจงทั้งถังแล้วลบสิ่งที่ "ดูเหมือนของเรา"
   * คือวิธีที่จะลบของคนอื่นสักวันหนึ่ง
   */
  async removeResourceScope(resourceId: string): Promise<void> {
    const scope = this.physicalKey(`resources/${resourceId}/`);
    let token: string | undefined;
    try {
      do {
        const listed = await this.client.send(new ListObjectsV2Command({
          Bucket: this.bucket, Prefix: scope, ContinuationToken: token,
        }));
        const keys = (listed.Contents ?? [])
          .map((item) => item.Key)
          .filter((k): k is string => typeof k === 'string' && k.startsWith(scope));
        if (keys.length > 0) {
          await this.client.send(new DeleteObjectsCommand({
            Bucket: this.bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }));
        }
        token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (token);
    } catch (error) {
      // เหมือนผู้ให้บริการบนดิสก์: เก็บกวาดไม่สำเร็จไม่ใช่ความล้มเหลวร้ายแรงของงานหลัก
      logger.error({ kind: classifyS3Error(error) }, '[STORAGE] เก็บกวาดวัตถุของทรัพยากรไม่สำเร็จ');
    }
  }

  /**
   * แจกแจงคีย์เชิงตรรกะใต้คำนำหน้าที่ระบุ - ใช้ตรวจหาวัตถุที่ไม่มีใครอ้างถึง (F23-E)
   *
   * **ขอบเขตถูกบังคับสองชั้น** ชั้นแรกส่ง Prefix ให้บริการกรองให้ ชั้นที่สองกรองซ้ำ
   * ฝั่งเราอีกครั้งก่อนตัดคำนำหน้าออก บริการที่ตีความ Prefix ต่างไปจึงยังทำให้เรา
   * หลุดออกนอกขอบเขตของ NAS ไม่ได้
   *
   * คืนคีย์เชิงตรรกะเสมอ เพื่อให้ผู้เรียกเทียบกับค่าที่บันทึกในฐานข้อมูลได้ตรง ๆ
   */
  async listLogicalKeys(logicalPrefix: string): Promise<string[]> {
    const scope = this.physicalKey(logicalPrefix);
    const keys: string[] = [];
    let token: string | undefined;

    do {
      const listed = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket, Prefix: scope, ContinuationToken: token,
      }));
      for (const item of listed.Contents ?? []) {
        if (typeof item.Key !== 'string' || !item.Key.startsWith(scope)) continue;
        keys.push(this.prefix ? item.Key.slice(this.prefix.length + 1) : item.Key);
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);

    return keys;
  }

  /**
   * สุขภาพของพื้นที่จัดเก็บ
   *
   * ใช้ HEAD ที่ระดับถัง ซึ่งเป็นสิทธิ์ที่น้อยที่สุดที่ยืนยันได้ว่าถังมีอยู่และเข้าถึงได้
   * ไม่เรียกแจกแจงวัตถุ เพราะการใช้งานปกติไม่ต้องการสิทธิ์นั้น และการบังคับให้ต้องมี
   * จะผลักให้ผู้ดูแลระบบให้สิทธิ์กว้างกว่าที่จำเป็น
   */
  async health(): Promise<StorageHealth> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { status: 'READY' };
    } catch (error) {
      switch (classifyS3Error(error)) {
        case 'BUCKET_MISSING':
        case 'NOT_FOUND':
          return { status: 'UNAVAILABLE', detail: 'ไม่พบถังเก็บวัตถุที่ตั้งค่าไว้' };
        case 'ACCESS_DENIED':
          // ตั้งค่าไว้แล้วแต่สิทธิ์ไม่พอ - ต่างจากยังไม่ได้ตั้งค่า และต่างจากติดต่อไม่ได้
          return { status: 'DEGRADED', detail: 'พื้นที่จัดเก็บปฏิเสธการเข้าถึง' };
        case 'UNREACHABLE':
          return { status: 'UNAVAILABLE', detail: 'ติดต่อพื้นที่จัดเก็บไม่ได้' };
        default:
          return { status: 'DEGRADED', detail: 'ตรวจสอบพื้นที่จัดเก็บไม่สำเร็จ' };
      }
    }
  }

  /** ไม่มีไฟล์บนดิสก์ให้ชี้ - ผู้เรียกที่ต้องการเส้นทางจริงต้องรู้ตัวตั้งแต่ตรงนี้ */
  localPathFor(): string | null {
    return null;
  }

  /**
   * คีย์เชิงตรรกะ -> คีย์จริงในถัง
   *
   * คำนำหน้าถูกเติมที่นี่ที่เดียว ผู้เรียกทุกรายจึงเห็นเฉพาะคีย์เชิงตรรกะเสมอ
   * และคีย์ที่บันทึกในฐานข้อมูลไม่ผูกกับค่าตั้งของถัง ย้ายถังได้โดยไม่ต้องแก้ข้อมูล
   */
  private physicalKey(key: string): string {
    const normalized = key.split('/').filter(Boolean).join('/') + (key.endsWith('/') ? '/' : '');
    return this.prefix ? `${this.prefix}/${normalized}` : normalized;
  }
}

function asReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body && typeof (body as { transformToWebStream?: unknown }).transformToWebStream === 'function') {
    return Readable.fromWeb((body as { transformToWebStream(): never }).transformToWebStream());
  }
  throw new AppError('STORAGE_OPERATION_FAILED', 'พื้นที่จัดเก็บคืนข้อมูลในรูปแบบที่อ่านไม่ได้', 502);
}

/** สร้างผู้ให้บริการจากค่าตั้ง - คืน null เมื่อยังตั้งค่าไม่ครบ */
export function s3ProviderFromEnv(client?: S3Client): S3StorageProvider | null {
  if (!env.S2_NAS_S3_BUCKET || !env.S2_NAS_S3_REGION
    || !env.S2_NAS_S3_ACCESS_KEY_ID || !env.S2_NAS_S3_SECRET_ACCESS_KEY) return null;
  return new S3StorageProvider({
    endpoint: env.S2_NAS_S3_ENDPOINT,
    region: env.S2_NAS_S3_REGION,
    bucket: env.S2_NAS_S3_BUCKET,
    accessKeyId: env.S2_NAS_S3_ACCESS_KEY_ID,
    secretAccessKey: env.S2_NAS_S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S2_NAS_S3_FORCE_PATH_STYLE === 1,
    prefix: env.S3_PREFIX,
  }, client);
}
