import { Readable } from 'node:stream';

/**
 * บริการที่พูดภาษา S3 แบบอยู่ในหน่วยความจำ สำหรับการทดสอบ (F23-C)
 *
 * **ปลอมที่ชั้นขนส่ง ไม่ใช่ปลอมทั้งผู้ให้บริการ** ตัวนี้สวมบทบาทของ S3Client เท่านั้น
 * โค้ดของ S3StorageProvider ที่ถูกทดสอบจึงเป็นโค้ดจริงทุกบรรทัด ทั้งการประกอบคำสั่ง
 * การเติมคำนำหน้า การแปลงข้อผิดพลาด และการแบ่งหน้า ถ้าปลอมทั้งผู้ให้บริการ
 * สิ่งที่ทดสอบจะกลายเป็นของปลอมนั้นเอง ซึ่งไม่บอกอะไรเลยเกี่ยวกับของจริง
 *
 * **สิ่งที่ตัวนี้ไม่ใช่:** ไม่ใช่ S3 จริง ไม่รับประกันความเข้ากันได้กับบริการจริง
 * และไม่ควรถูกอ้างว่าเป็นการทดสอบเชื่อมต่อกับปลายทางจริง
 */

interface StoredObject {
  body: Buffer;
  lastModified: Date;
}

export type FakeS3FailureMode = 'NONE' | 'UNREACHABLE' | 'ACCESS_DENIED' | 'BUCKET_MISSING' | 'TIMEOUT';

export interface RecordedCommand {
  name: string;
  input: Record<string, unknown>;
}

function s3Error(name: string, status: number): Error {
  const error = new Error(name) as Error & { name: string; $metadata: { httpStatusCode: number } };
  error.name = name;
  error.$metadata = { httpStatusCode: status };
  return error;
}

export class FakeS3Client {
  readonly objects = new Map<string, StoredObject>();
  readonly commands: RecordedCommand[] = [];

  /** โหมดความล้มเหลวที่ใช้ได้ทันทีกับทุกคำสั่ง - สำหรับทดสอบการแปลงข้อผิดพลาด */
  failureMode: FakeS3FailureMode = 'NONE';
  /** ทำให้คำสั่งถัดไปหนึ่งครั้งล้มเหลว ใช้ทดสอบความล้มเหลวกลางงาน */
  failNextOnce: FakeS3FailureMode | null = null;
  /** จำนวนวัตถุสูงสุดต่อหนึ่งหน้าของ ListObjectsV2 - ทำให้ทดสอบการแบ่งหน้าได้จริง */
  listPageSize = 1000;

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
    const name = command.constructor.name;
    this.commands.push({ name, input: command.input });

    const failure = this.failNextOnce ?? this.failureMode;
    if (this.failNextOnce) this.failNextOnce = null;
    switch (failure) {
      case 'UNREACHABLE': throw s3Error('NetworkingError', 0);
      case 'TIMEOUT': throw s3Error('TimeoutError', 0);
      case 'ACCESS_DENIED': throw s3Error('AccessDenied', 403);
      case 'BUCKET_MISSING': throw s3Error('NoSuchBucket', 404);
      default: break;
    }

    switch (name) {
      case 'PutObjectCommand': return this.put(command.input);
      case 'GetObjectCommand': return this.get(command.input);
      case 'HeadObjectCommand': return this.head(command.input);
      case 'DeleteObjectCommand': return this.remove(command.input);
      case 'DeleteObjectsCommand': return this.removeMany(command.input);
      case 'CopyObjectCommand': return this.copy(command.input);
      case 'ListObjectsV2Command': return this.list(command.input);
      case 'HeadBucketCommand': return {};
      default: throw s3Error('NotImplemented', 501);
    }
  }

  private async put(input: Record<string, unknown>): Promise<unknown> {
    const key = String(input.Key);
    const body = input.Body;
    const bytes = body instanceof Readable ? await collect(body) : Buffer.from(body as Buffer);
    this.objects.set(key, { body: bytes, lastModified: new Date() });
    return { ETag: `"${bytes.byteLength.toString(16)}"` };
  }

  private get(input: Record<string, unknown>): unknown {
    const object = this.require(String(input.Key));
    const range = typeof input.Range === 'string' ? parseRange(input.Range) : null;
    if (!range) {
      return { Body: Readable.from(object.body), ContentLength: object.body.byteLength };
    }
    // ปลายทางที่เลยขนาดจริงถูกตัดให้พอดี ตรงกับพฤติกรรมของ HTTP Range
    const end = Math.min(range.end, object.body.byteLength - 1);
    const slice = object.body.subarray(range.start, end + 1);
    return { Body: Readable.from(slice), ContentLength: slice.byteLength };
  }

  private head(input: Record<string, unknown>): unknown {
    const object = this.require(String(input.Key));
    return { ContentLength: object.body.byteLength, LastModified: object.lastModified };
  }

  private remove(input: Record<string, unknown>): unknown {
    // S3 ตอบสำเร็จแม้คีย์นั้นไม่มีอยู่
    this.objects.delete(String(input.Key));
    return {};
  }

  private removeMany(input: Record<string, unknown>): unknown {
    const payload = input.Delete as { Objects?: Array<{ Key?: string }> } | undefined;
    for (const item of payload?.Objects ?? []) {
      if (item.Key) this.objects.delete(item.Key);
    }
    return { Deleted: (payload?.Objects ?? []).map((item) => ({ Key: item.Key })) };
  }

  private copy(input: Record<string, unknown>): unknown {
    const source = String(input.CopySource);
    // CopySource มีรูปแบบ "<bucket>/<key>" - ตัดชื่อถังส่วนแรกออก
    const sourceKey = source.slice(source.indexOf('/') + 1);
    const object = this.require(sourceKey);
    this.objects.set(String(input.Key), { body: Buffer.from(object.body), lastModified: new Date() });
    return {};
  }

  private list(input: Record<string, unknown>): unknown {
    const prefix = String(input.Prefix ?? '');
    const after = input.ContinuationToken ? String(input.ContinuationToken) : null;
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = after ? keys.indexOf(after) + 1 : 0;
    const page = keys.slice(start, start + this.listPageSize);
    const truncated = start + page.length < keys.length;
    return {
      Contents: page.map((Key) => ({ Key })),
      IsTruncated: truncated,
      NextContinuationToken: truncated ? page[page.length - 1] : undefined,
    };
  }

  private require(key: string): StoredObject {
    const object = this.objects.get(key);
    if (!object) throw s3Error('NoSuchKey', 404);
    return object;
  }
}

function parseRange(header: string): { start: number; end: number } | null {
  const match = /^bytes=(\d+)-(\d+)$/.exec(header);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]) };
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
