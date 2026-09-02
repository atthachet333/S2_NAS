import type { ResourceDto } from './api';
import type { DriveEntry } from './drive';

export type ExternalResourceType = Extract<ResourceDto['type'], 'GOOGLE_SHEET' | 'GOOGLE_DOC' | 'GOOGLE_DRIVE' | 'WEB_LINK'>;

export const EXTERNAL_RESOURCE_TYPES: ExternalResourceType[] = ['GOOGLE_SHEET', 'GOOGLE_DOC', 'GOOGLE_DRIVE', 'WEB_LINK'];

export const EXTERNAL_RESOURCE_META: Record<ExternalResourceType, { label: string; nameLabel: string; toast: string; providerLabel: string }> = {
  GOOGLE_SHEET: { label: 'Google Sheet', nameLabel: 'ชื่อ Google Sheet', toast: 'เพิ่ม Google Sheet แล้ว', providerLabel: 'Google Sheets' },
  GOOGLE_DOC: { label: 'Google Doc', nameLabel: 'ชื่อ Google Doc', toast: 'เพิ่ม Google Doc แล้ว', providerLabel: 'Google Docs' },
  GOOGLE_DRIVE: { label: 'Google Drive', nameLabel: 'ชื่อรายการ/พื้นที่ Drive', toast: 'เพิ่ม Google Drive แล้ว', providerLabel: 'Google Drive' },
  WEB_LINK: { label: 'ลิงก์ภายนอก', nameLabel: 'ชื่อ', toast: 'เพิ่มลิงก์แล้ว', providerLabel: 'เว็บ' },
};

export function isExternalResourceType(type: ResourceDto['type']): type is ExternalResourceType {
  return EXTERNAL_RESOURCE_TYPES.includes(type as ExternalResourceType);
}

export function isExternalEntry(entry: DriveEntry): boolean {
  return isExternalResourceType(entry.resourceType);
}

export function externalResourceLabel(type: ResourceDto['type']): string | null {
  return isExternalResourceType(type) ? EXTERNAL_RESOURCE_META[type].label : null;
}

export function validateExternalUrl(type: ExternalResourceType, rawUrl: string): 'UNSAFE_URL_SCHEME' | 'INVALID_EXTERNAL_RESOURCE_URL' | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return 'INVALID_EXTERNAL_RESOURCE_URL';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return 'UNSAFE_URL_SCHEME';
  if (parsed.username || parsed.password) return 'INVALID_EXTERNAL_RESOURCE_URL';
  const host = parsed.hostname.toLocaleLowerCase();
  if (type === 'GOOGLE_SHEET' && !(host === 'docs.google.com' && /^\/spreadsheets(?:\/|$)/u.test(parsed.pathname))) return 'INVALID_EXTERNAL_RESOURCE_URL';
  if (type === 'GOOGLE_DOC' && !(host === 'docs.google.com' && /^\/document(?:\/|$)/u.test(parsed.pathname))) return 'INVALID_EXTERNAL_RESOURCE_URL';
  if (type === 'GOOGLE_DRIVE' && !(host === 'drive.google.com' && parsed.pathname !== '/')) return 'INVALID_EXTERNAL_RESOURCE_URL';
  return null;
}

export function openExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
    return true;
  } catch {
    return false;
  }
}
