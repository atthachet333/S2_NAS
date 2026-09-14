import crypto from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { runStorageProviderContract } from './contract.harness.js';
import { FakeS3Client } from './fake-s3-client.js';
import { LocalStorageProvider } from './local.provider.js';
import { S3StorageProvider } from './s3.provider.js';

/**
 * สัญญาเดียวกัน สองผู้ให้บริการ (F23-C)
 *
 * ผู้ให้บริการบนดิสก์ทดสอบกับดิสก์จริงของเครื่อง ส่วนผู้ให้บริการ S3 ทดสอบกับบริการ
 * ที่พูดภาษา S3 ในหน่วยความจำ โค้ดของผู้ให้บริการทั้งสองรายเป็นของจริงทั้งคู่
 * สิ่งที่ถูกแทนที่มีเพียงปลายทางของการเชื่อมต่อเท่านั้น
 */

runStorageProviderContract({
  name: 'LocalStorageProvider',
  async create() {
    const provider = new LocalStorageProvider();
    const created: string[] = [];
    const wrapped = new Proxy(provider, {
      get(target, property, receiver) {
        if (property === 'createStorageKey') {
          return (resourceId: string) => {
            const key = target.createStorageKey(resourceId);
            created.push(resourceId);
            return key;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    return {
      provider: wrapped,
      // ของทดสอบทั้งหมดอยู่ใต้รหัสทรัพยากรที่สุ่มขึ้นมาใหม่ จึงเก็บกวาดได้ครบโดยไม่แตะของจริง
      cleanup: async () => {
        for (const resourceId of new Set(created)) await provider.removeResourceScope(resourceId);
      },
    };
  },
});

runStorageProviderContract({
  name: 'S3StorageProvider (in-memory S3-compatible transport)',
  async create() {
    const fake = new FakeS3Client();
    const provider = new S3StorageProvider({
      region: 'auto',
      bucket: 'contract-bucket',
      accessKeyId: 'contract-key-id',
      secretAccessKey: 'contract-secret',
      forcePathStyle: true,
      prefix: `contract/${crypto.randomUUID()}`,
    }, fake as unknown as S3Client);
    return { provider, cleanup: async () => { fake.objects.clear(); } };
  },
});
