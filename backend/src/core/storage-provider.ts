import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { resolveInsideStorage } from './storage.js';

export type StorageProviderKind = 'LOCAL_DISK' | 'NETWORK_SHARE' | 'S3_COMPATIBLE';

export interface StorageProvider {
  readonly kind: StorageProviderKind;
  createStorageKey(resourceId: string): string;
  ensureResourceDirectory(resourceId: string): Promise<void>;
}

export class LocalDiskStorageProvider implements StorageProvider {
  readonly kind = 'LOCAL_DISK' as const;

  createStorageKey(resourceId: string): string {
    return `resources/${resourceId}/${crypto.randomUUID()}`;
  }

  async ensureResourceDirectory(resourceId: string): Promise<void> {
    await fs.mkdir(resolveInsideStorage('resources', resourceId), { recursive: true });
  }
}

export const storageProvider: StorageProvider = new LocalDiskStorageProvider();
export const storageProviderInfo = { kind: storageProvider.kind, rootConfigured: Boolean(env.STORAGE_ROOT) } as const;

export function resolveStorageKey(storageKey: string): string {
  return resolveInsideStorage(...storageKey.split('/').filter(Boolean));
}
