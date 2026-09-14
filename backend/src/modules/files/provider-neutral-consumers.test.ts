import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { S3Client } from '@aws-sdk/client-s3';
import { prisma } from '../../core/prisma.js';
import { FakeS3Client } from '../../core/storage/fake-s3-client.js';
import { LocalStorageProvider } from '../../core/storage/local.provider.js';
import { S3StorageProvider } from '../../core/storage/s3.provider.js';
import { setStorageProviderForTesting, setWriteProviderForTesting } from '../../core/storage/index.js';
import { removeQaUsers } from '../assistant/qa-fixture.js';
import { retrieveAssistantEvidence } from '../assistant/rag.service.js';
import { collectEvidence } from '../filing/candidates.js';
import { runJob } from '../search/search-index.service.js';
import { uploadFile } from './file.service.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * ผู้บริโภคปลายทางต้องไม่สนใจว่าไบต์อยู่ที่ไหน (F23-D)
 *
 * F21 และ F22 อ่านข้อความที่ถูกสกัดไว้ในฐานข้อมูล ไม่ได้แตะวัตถุเอง ชุดนี้จึงพิสูจน์
 * ว่าเมื่อเอกสารอยู่บนที่เก็บวัตถุ สายพานยังเดินครบ: สกัด -> ทำดัชนี -> ทั้งสอง
 * ความสามารถใช้ข้อความนั้นได้เหมือนเอกสารบนดิสก์ทุกประการ
 *
 * ถ้าวันหนึ่งมีใครทำให้ F21 หรือ F22 เปิดวัตถุเอง ชุดนี้จะยังผ่าน แต่ชุดตรวจอื่น
 * จะจับได้ - ที่นี่พิสูจน์เฉพาะว่า "ผลลัพธ์ไม่ขึ้นกับผู้ให้บริการ"
 */

const prefix = `f23n-${process.pid}-${Date.now()}`;
let fake: FakeS3Client;
let owner: AuthUser;
let folderId = '';
const created: string[] = [];

const auth = (id: string, email: string): AuthUser => ({
  id, email, displayName: email, type: 'INTERNAL', status: 'ACTIVE', mustChangePassword: false,
  roles: ['MEMBER'], permissions: ['resources:read', 'resources:write', 'resources:delete'],
});

/** อัปโหลดแล้วเดินงานทำดัชนีให้จบ เหมือนที่คิวเบื้องหลังทำกับไฟล์จริง */
async function uploadAndIndex(kind: 'LOCAL' | 'S3', name: string, text: string): Promise<string> {
  setWriteProviderForTesting(kind);
  const result = await uploadFile(owner, Readable.from(Buffer.from(text, 'utf8')), {
    fileName: `${prefix}-${name}`, parentId: folderId, declaredMime: 'text/plain',
  }, {});
  setWriteProviderForTesting('LOCAL');
  if (result.status !== 'CREATED') throw new Error('อัปโหลดไม่สำเร็จ');
  created.push(result.resource.id);

  const version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId: result.resource.id } });
  const index = await prisma.resourceSearchIndex.findFirstOrThrow({ where: { resourceVersionId: version.id } });
  // เรียกงานของแถวนี้โดยตรง ไม่ใช้คิวรวม เพื่อไม่ไปหยิบงานของคนอื่นบนฐานข้อมูลเดียวกัน
  await runJob(index.id);
  return result.resource.id;
}

describe('F23-D provider-neutral consumers', { concurrency: 1 }, () => {
  before(async () => {
    const user = await prisma.user.create({ data: {
      email: `${prefix}@example.invalid`, displayName: 'F23 neutrality', type: 'INTERNAL', status: 'ACTIVE' } });
    owner = auth(user.id, user.email);

    const id = crypto.randomUUID();
    await prisma.resource.create({ data: { id, type: 'FOLDER', name: `${prefix} folder`,
      normalizedName: `${prefix} folder`, siblingKey: `${prefix}:${id}`,
      ownerId: user.id, createdById: user.id, visibility: 'ORGANIZATION', currentVersion: null } });
    folderId = id;
  });

  beforeEach(() => {
    fake = new FakeS3Client();
    setStorageProviderForTesting('S3', new S3StorageProvider({
      region: 'auto', bucket: 'f23n-bucket', accessKeyId: 'id', secretAccessKey: 'secret',
      forcePathStyle: true, prefix: 'nas',
    }, fake as unknown as S3Client));
    setWriteProviderForTesting('LOCAL');
  });

  after(async () => {
    for (const id of created) {
      await prisma.resourceSearchIndex.deleteMany({ where: { resourceId: id } });
      await prisma.resourceVersion.deleteMany({ where: { resourceId: id } });
      await prisma.resource.deleteMany({ where: { id } });
      // ลบวัตถุบนดิสก์ด้วย มิฉะนั้นทุกครั้งที่รันจะทิ้งไฟล์กำพร้าไว้เพิ่มขึ้นเรื่อย ๆ
      await new LocalStorageProvider().removeResourceScope(id);
    }
    await prisma.resource.deleteMany({ where: { id: folderId } });
    await removeQaUsers([owner.id]);
    setStorageProviderForTesting('S3', null);
    setWriteProviderForTesting('LOCAL');
  });

  /** การทำดัชนีต้องสำเร็จเท่ากันทั้งสองผู้ให้บริการ และได้ข้อความชุดเดียวกัน */
  test('indexing succeeds identically for local and object-stored versions', async () => {
    const text = 'ใบกำกับภาษี บริษัท ทดสอบพื้นที่จัดเก็บ จำกัด เลขประจำตัวผู้เสียภาษี 0105500000031';
    const localId = await uploadAndIndex('LOCAL', 'index-local.txt', `${text} ฉบับดิสก์`);
    const s3Id = await uploadAndIndex('S3', 'index-s3.txt', `${text} ฉบับที่เก็บวัตถุ`);

    for (const id of [localId, s3Id]) {
      const index = await prisma.resourceSearchIndex.findFirstOrThrow({ where: { resourceId: id } });
      assert.equal(index.status, 'READY', 'การทำดัชนีต้องสำเร็จ');
      assert.match(index.extractedText ?? '', /ใบกำกับภาษี/u);
    }

    const s3Version = await prisma.resourceVersion.findFirstOrThrow({ where: { resourceId: s3Id } });
    assert.equal(s3Version.storageProvider, 'S3', 'เอกสารต้องอยู่บนที่เก็บวัตถุจริง');
  });

  /** F21 ต้องหาเอกสารที่อยู่บนที่เก็บวัตถุเจอ โดยไม่เคยเปิดวัตถุเอง */
  test('F21 retrieval finds an object-stored document through indexed text', async () => {
    const id = await uploadAndIndex('S3', 'assistant-source.txt',
      'รายงานการประชุมคณะกรรมการ เรื่องงบประมาณปี 2569 วงเงิน 4,500,000 บาท');

    const commandsBefore = fake.commands.length;
    const evidence = await retrieveAssistantEvidence({
      question: 'งบประมาณปี 2569 เท่าไร',
      scope: 'SELECTED_RESOURCES',
      resourceIds: [id],
      mode: 'QA',
    }, owner);

    assert.ok(evidence.evidence.length > 0, 'ต้องได้หลักฐานจากข้อความที่ทำดัชนีไว้');
    assert.match(evidence.evidence.map((item) => item.text).join(' '), /4,500,000/u);
    assert.equal(fake.commands.length, commandsBefore,
      'F21 ต้องไม่แตะที่เก็บวัตถุเลย - มันอ่านจากข้อความที่ทำดัชนีไว้เท่านั้น');
  });

  /**
   * การนำเข้าจาก Google ต้องใช้ผู้ให้บริการที่ตั้งไว้ เหมือนการอัปโหลดทุกทาง
   *
   * การนำเข้าเดินผ่าน uploadFile เส้นเดียวกับผู้ใช้ จึงไม่มีเส้นทางลัดที่เขียนลง
   * พื้นที่จัดเก็บเอง ชุดนี้ยืนยันข้อนั้นด้วยการอัปโหลดแบบมีที่มาเป็น GOOGLE
   * แล้วตรวจว่าผู้ให้บริการที่ถูกบันทึกเป็นค่าที่ตั้งไว้ ไม่ใช่ค่าที่ถูกกำหนดตายตัว
   */
  test('Google-sourced imports follow the configured default provider', async () => {
    for (const kind of ['LOCAL', 'S3'] as const) {
      setWriteProviderForTesting(kind);
      const result = await uploadFile(owner, Readable.from(Buffer.from(`google import ${kind}`, 'utf8')), {
        fileName: `${prefix}-google-${kind}.txt`, parentId: folderId, declaredMime: 'text/plain',
        sourceType: 'GOOGLE', sourceSystem: 'GOOGLE_DRIVE',
      }, {});
      setWriteProviderForTesting('LOCAL');
      if (result.status !== 'CREATED') throw new Error('นำเข้าไม่สำเร็จ');
      created.push(result.resource.id);

      const row = await prisma.resource.findUniqueOrThrow({ where: { id: result.resource.id },
        select: { storageProvider: true, sourceType: true, versions: { select: { storageProvider: true } } } });
      assert.equal(row.sourceType, 'GOOGLE');
      assert.equal(row.storageProvider, kind, `การนำเข้าต้องลงที่ ${kind} ตามค่าตั้ง`);
      assert.equal(row.versions[0]?.storageProvider, kind);
    }
  });

  /** F22 ต้องวิเคราะห์เอกสารที่อยู่บนที่เก็บวัตถุได้ โดยไม่เคยเปิดวัตถุเอง */
  test('F22 evidence collection reads an object-stored document without touching the store', async () => {
    const id = await uploadAndIndex('S3', 'filing-source.txt',
      'ใบกำกับภาษี บริษัท เดลต้าสโตเรจ จำกัด เลขประจำตัวผู้เสียภาษี 0105500000048 ปี 2569');

    const commandsBefore = fake.commands.length;
    const evidence = await collectEvidence(id, owner);

    assert.ok(evidence, 'ต้องรวบรวมหลักฐานได้');
    assert.equal(evidence!.textReady, true, 'ข้อความต้องพร้อมใช้หลังทำดัชนีเสร็จ');
    assert.ok(evidence!.taxIds.includes('0105500000048'), 'ต้องอ่านเลขผู้เสียภาษีจากข้อความที่ทำดัชนีไว้');
    assert.equal(fake.commands.length, commandsBefore,
      'F22 ต้องไม่แตะที่เก็บวัตถุเลย');
  });
});
