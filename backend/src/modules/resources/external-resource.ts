import type { ResourceSourceType, ResourceType } from '@prisma/client';
import { badRequest } from '../../core/errors.js';

export const EXTERNAL_RESOURCE_TYPES = ['GOOGLE_SHEET', 'GOOGLE_DOC', 'GOOGLE_DRIVE', 'WEB_LINK'] as const;
export type ExternalResourceType = (typeof EXTERNAL_RESOURCE_TYPES)[number];

const CONFIG: Record<ExternalResourceType, { provider: string; sourceType: ResourceSourceType }> = {
  GOOGLE_SHEET: { provider: 'GOOGLE_SHEETS', sourceType: 'GOOGLE' },
  GOOGLE_DOC: { provider: 'GOOGLE_DOCS', sourceType: 'GOOGLE' },
  GOOGLE_DRIVE: { provider: 'GOOGLE_DRIVE', sourceType: 'GOOGLE' },
  WEB_LINK: { provider: 'WEB', sourceType: 'MANUAL' },
};

export function isExternalResourceType(type: ResourceType): type is ExternalResourceType {
  return (EXTERNAL_RESOURCE_TYPES as readonly ResourceType[]).includes(type);
}

export function externalResourceConfig(type: ExternalResourceType) {
  return CONFIG[type];
}

/** Validate and normalize locally. This function must never fetch or resolve the URL. */
export function validateExternalResourceUrl(type: ExternalResourceType, rawUrl: string): string {
  const value = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw badRequest('INVALID_EXTERNAL_RESOURCE_URL', 'ลิงก์ไม่ถูกต้องสำหรับประเภททรัพยากรนี้');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('UNSAFE_URL_SCHEME', 'ไม่รองรับลิงก์ประเภทนี้');
  }
  if (parsed.username || parsed.password) {
    throw badRequest('INVALID_EXTERNAL_RESOURCE_URL', 'ลิงก์ไม่ถูกต้องสำหรับประเภททรัพยากรนี้');
  }

  const hostname = parsed.hostname.toLocaleLowerCase();
  const path = parsed.pathname;
  const validForType =
    type === 'WEB_LINK' ||
    (type === 'GOOGLE_SHEET' && hostname === 'docs.google.com' && /^\/spreadsheets(?:\/|$)/u.test(path)) ||
    (type === 'GOOGLE_DOC' && hostname === 'docs.google.com' && /^\/document(?:\/|$)/u.test(path)) ||
    (type === 'GOOGLE_DRIVE' && hostname === 'drive.google.com' && path !== '/');

  if (!validForType) {
    throw badRequest('INVALID_EXTERNAL_RESOURCE_URL', 'ลิงก์ไม่ถูกต้องสำหรับประเภททรัพยากรนี้');
  }

  parsed.hash = '';
  return parsed.toString();
}
