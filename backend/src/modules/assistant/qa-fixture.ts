import { access, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import type { SearchTextSource } from '@prisma/client';
import { removeResourceDirectory } from '../../core/file-storage.js';
import { resolveStorageKey, storageProvider } from '../../core/storage-provider.js';
import { prisma } from '../../core/prisma.js';

/**
 * ตัวช่วยสร้างของทดสอบแบบใช้แล้วทิ้งสำหรับ F21
 *
 * **ปัญหาที่แก้:** ของทดสอบรุ่นก่อนสร้างแถว ResourceVersion โดยไม่เขียนไฟล์จริง และตั้ง
 * storageKey เป็นรูปแบบของตัวเองที่อยู่นอกโฟลเดอร์ resources/ ผลคือฐานข้อมูลอ้างถึงไฟล์
 * ที่ไม่มีอยู่ เมื่อชุดตรวจสอบความครบถ้วนของการสำรองข้อมูลเดินผ่าน มันจึงรายงาน
 * BACKUP_STORAGE_INCOMPLETE อย่างถูกต้อง แล้วชุดทดสอบทั้งกลุ่มล้มตามกันไป
 *
 * การแก้ที่ผิดคือไปผ่อนเกณฑ์ของการสำรองข้อมูล เพราะเกณฑ์นั้นทำงานถูกแล้ว - มันจับ
 * ของที่พังได้จริง ๆ สิ่งที่ต้องแก้คือของทดสอบต่างหากที่สร้างสถานะที่เป็นไปไม่ได้ในระบบจริง
 *
 * โมดูลนี้จึงสร้างไฟล์จริงผ่าน storageProvider ตัวเดียวกับที่การอัปโหลดจริงใช้
 * ของทดสอบจึงมีหน้าตาเหมือนของจริงทุกประการในสายตาของการสำรองข้อมูล
 * ไม่มีการยกเว้นหรือเงื่อนไขพิเศษใด ๆ ให้มัน
 *
 * โมดูลนี้ใช้เฉพาะชุดทดสอบและสคริปต์ QA เท่านั้น ไม่มีเส้นทางการทำงานจริงเรียกใช้
 */

export interface QaVersionSpec {
  text: string;
  textSource?: SearchTextSource;
}

export interface QaResourceSpec {
  name: string;
  ownerId: string;
  visibility?: 'ORGANIZATION' | 'RESTRICTED';
  versions: QaVersionSpec[];
  /** สร้างดัชนีข้อความให้ด้วยหรือไม่ ค่าเริ่มต้นคือสร้าง */
  withSearchIndex?: boolean;
}

/**
 * ขอบเขตของของทดสอบหนึ่งชุด
 *
 * จดจำทุกสิ่งที่สร้างไว้เพื่อให้เก็บกวาดได้ครบ ทั้งแถวในฐานข้อมูลและไฟล์บนดิสก์
 * การเก็บกวาดครึ่งเดียวคือสาเหตุเดิมของปัญหา จึงต้องเก็บทั้งสองฝั่งเสมอ
 */
export class QaFixtureScope {
  private readonly resourceIds: string[] = [];
  private readonly userIds: string[] = [];
  private readonly threadIds: string[] = [];

  constructor(readonly prefix: string) {}

  trackUser(userId: string): void { this.userIds.push(userId); }
  trackThread(threadId: string): void { this.threadIds.push(threadId); }

  async createUser(displayName: string): Promise<{ id: string; email: string }> {
    const email = `${this.prefix}-${crypto.randomBytes(3).toString('hex')}@example.invalid`;
    const user = await prisma.user.create({ data: { email, displayName, type: 'INTERNAL', status: 'ACTIVE' } });
    this.userIds.push(user.id);
    return { id: user.id, email: user.email };
  }

  /**
   * สร้างทรัพยากรพร้อมไฟล์จริงบนดิสก์
   *
   * ใช้ storageProvider.createStorageKey ตัวเดียวกับการอัปโหลดจริง เพื่อให้ path
   * อยู่ใต้ resources/<id>/ ตามแบบแผนเดียวกัน การเก็บกวาดด้วย removeResourceDirectory
   * จึงครอบคลุมได้จริง ไม่หลงเหลือไฟล์กำพร้าไว้
   */
  async createResource(spec: QaResourceSpec): Promise<string> {
    const resourceId = crypto.randomUUID();
    this.resourceIds.push(resourceId);

    await prisma.resource.create({ data: { id: resourceId, type: 'FILE', name: spec.name,
      normalizedName: spec.name.toLowerCase(), siblingKey: `${this.prefix}:${resourceId}`,
      ownerId: spec.ownerId, createdById: spec.ownerId,
      visibility: spec.visibility ?? 'ORGANIZATION', currentVersion: spec.versions.length } });

    await storageProvider.ensureResourceDirectory(resourceId);
    for (const [index, version] of spec.versions.entries()) {
      const bytes = Buffer.from(version.text, 'utf8');
      const storageKey = storageProvider.createStorageKey(resourceId);
      // เขียนไฟล์ก่อนบันทึกแถวเสมอ ถ้าลำดับกลับกันแล้วขั้นตอนเขียนล้มเหลว
      // จะเหลือแถวที่ชี้ไปยังไฟล์ที่ไม่มีอยู่ ซึ่งคือสภาพที่กำลังแก้อยู่พอดี
      await writeFile(resolveStorageKey(storageKey), bytes);
      const row = await prisma.resourceVersion.create({ data: { resourceId, versionNumber: index + 1,
        storageKey, size: BigInt(bytes.byteLength),
        checksum: crypto.createHash('sha256').update(bytes).digest('hex'), createdById: spec.ownerId } });

      if (spec.withSearchIndex !== false) {
        await prisma.resourceSearchIndex.create({ data: { resourceId, resourceVersionId: row.id,
          versionNumber: index + 1, status: 'READY', textSource: version.textSource ?? 'NATIVE_TEXT',
          extractedText: version.text, normalizedText: version.text.toLowerCase(),
          characterCount: version.text.length, extractorVersion: 'f21-qa-fixture' } });
      }
    }
    return resourceId;
  }

  /**
   * เก็บกวาดทั้งแถวและไฟล์
   *
   * ออกแบบให้เรียกซ้ำได้และไม่โยนข้อผิดพลาด เพราะตัวมันเองถูกเรียกจาก finally/teardown
   * ถ้าการเก็บกวาดล้มเหลวกลางทางแล้วโยนต่อ จะกลบสาเหตุจริงของความล้มเหลวที่เกิดก่อนหน้า
   */
  async destroy(): Promise<void> {
    try {
      if (this.threadIds.length) await prisma.assistantThread.deleteMany({ where: { id: { in: this.threadIds } } });
      if (this.userIds.length) await prisma.assistantThread.deleteMany({ where: { userId: { in: this.userIds } } });
      if (this.resourceIds.length) {
        await prisma.semanticChunk.deleteMany({ where: { resourceId: { in: this.resourceIds } } });
        await prisma.semanticDocumentIndex.deleteMany({ where: { resourceId: { in: this.resourceIds } } });
        await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: { in: this.resourceIds } } });
        await prisma.resourceVersion.deleteMany({ where: { resourceId: { in: this.resourceIds } } });
        await prisma.resource.deleteMany({ where: { id: { in: this.resourceIds } } });
        // ลบไฟล์หลังลบแถว ลำดับนี้ทำให้ไม่มีช่วงเวลาที่แถวชี้ไปยังไฟล์ที่ถูกลบไปแล้ว
        for (const resourceId of this.resourceIds) await removeResourceDirectory(resourceId);
      }
      if (this.userIds.length) await prisma.user.deleteMany({ where: { id: { in: this.userIds } } });
    } catch {
      /* การเก็บกวาดต้องไม่กลบข้อผิดพลาดเดิมที่ทำให้มาถึงจุดนี้ */
    }
  }
}

/**
 * นับแถวที่อ้างถึงไฟล์ที่ไม่มีอยู่จริง
 *
 * ใช้ยืนยันในเทสต์ว่าไม่มีการอ้างอิงกำพร้าหลงเหลือ ซึ่งเป็นเงื่อนไขเดียวกับที่
 * การตรวจสอบความครบถ้วนของชุดสำรองใช้ตัดสิน
 */
export async function countOrphanStorageReferences(resourceIds?: string[]): Promise<number> {
  const versions = await prisma.resourceVersion.findMany({
    where: resourceIds ? { resourceId: { in: resourceIds } } : undefined,
    select: { storageKey: true } });
  let orphans = 0;
  for (const version of versions) {
    try { await access(resolveStorageKey(version.storageKey)); }
    catch { orphans++; }
  }
  return orphans;
}

/**
 * เขียนไฟล์จริงสำหรับเวอร์ชันของของทดสอบหนึ่งชิ้น
 *
 * แยกออกมาให้ของทดสอบเดิมเรียกใช้ได้โดยไม่ต้องรื้อโครงสร้างทั้งไฟล์
 * คืนค่าที่จำเป็นต่อการบันทึกแถวให้ตรงกับไฟล์ทุกประการ ทั้งขนาดและ checksum
 * ผู้เรียกต้องเก็บกวาดด้วย removeResourceDirectory(resourceId) เสมอ
 */
export async function writeQaVersionFile(resourceId: string, text: string): Promise<{
  storageKey: string; size: bigint; checksum: string;
}> {
  const bytes = Buffer.from(text, 'utf8');
  await storageProvider.ensureResourceDirectory(resourceId);
  const storageKey = storageProvider.createStorageKey(resourceId);
  await writeFile(resolveStorageKey(storageKey), bytes);
  return { storageKey, size: BigInt(bytes.byteLength), checksum: crypto.createHash('sha256').update(bytes).digest('hex') };
}
