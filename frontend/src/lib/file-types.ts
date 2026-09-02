import {
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  FileVideo,
  Presentation,
  File as FileIcon,
  type LucideIcon,
} from 'lucide-react';

export type FileKind =
  | 'PDF'
  | 'WORD'
  | 'EXCEL'
  | 'POWERPOINT'
  | 'IMAGE'
  | 'ARCHIVE'
  | 'TEXT'
  | 'VIDEO'
  | 'AUDIO'
  | 'CODE'
  | 'OTHER';

export interface FileTypeStyle {
  kind: FileKind;
  label: string;
  icon: LucideIcon;
  /** สีเฉพาะที่ไอคอน เพื่อให้จำชนิดได้เร็วโดยไม่ทำให้หน้าจอฉูดฉาด */
  fg: string;
  bg: string;
}

const STYLES: Record<FileKind, FileTypeStyle> = {
  PDF: { kind: 'PDF', label: 'PDF', icon: FileText, fg: 'text-red-600', bg: 'bg-red-50' },
  WORD: { kind: 'WORD', label: 'Word', icon: FileType2, fg: 'text-blue-600', bg: 'bg-blue-50' },
  EXCEL: { kind: 'EXCEL', label: 'Excel', icon: FileSpreadsheet, fg: 'text-emerald-600', bg: 'bg-emerald-50' },
  POWERPOINT: { kind: 'POWERPOINT', label: 'PowerPoint', icon: Presentation, fg: 'text-orange-600', bg: 'bg-amber-50' },
  IMAGE: { kind: 'IMAGE', label: 'รูปภาพ', icon: FileImage, fg: 'text-violet-600', bg: 'bg-violet-50' },
  ARCHIVE: { kind: 'ARCHIVE', label: 'ไฟล์บีบอัด', icon: FileArchive, fg: 'text-amber-600', bg: 'bg-amber-50' },
  TEXT: { kind: 'TEXT', label: 'ข้อความ', icon: FileText, fg: 'text-navy-500', bg: 'bg-navy-50' },
  VIDEO: { kind: 'VIDEO', label: 'วิดีโอ', icon: FileVideo, fg: 'text-sky-600', bg: 'bg-sky-50' },
  AUDIO: { kind: 'AUDIO', label: 'เสียง', icon: FileAudio, fg: 'text-teal-600', bg: 'bg-teal-50' },
  CODE: { kind: 'CODE', label: 'โค้ด', icon: FileCode2, fg: 'text-indigo-600', bg: 'bg-indigo-50' },
  OTHER: { kind: 'OTHER', label: 'ไฟล์', icon: FileIcon, fg: 'text-navy-500', bg: 'bg-navy-50' },
};

/** จับคู่จาก MIME ก่อนเสมอ เพราะเซิร์ฟเวอร์ตรวจจากลายเซ็นไฟล์จริง */
function kindFromMime(mimeType: string): FileKind | null {
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType.startsWith('image/')) return 'IMAGE';
  if (mimeType.startsWith('video/')) return 'VIDEO';
  if (mimeType.startsWith('audio/')) return 'AUDIO';

  if (mimeType.includes('wordprocessingml') || mimeType === 'application/msword') return 'WORD';
  if (mimeType.includes('spreadsheetml') || mimeType === 'application/vnd.ms-excel') return 'EXCEL';
  if (mimeType.includes('presentationml') || mimeType === 'application/vnd.ms-powerpoint') return 'POWERPOINT';

  if (
    mimeType === 'application/zip' ||
    mimeType === 'application/x-rar-compressed' ||
    mimeType === 'application/x-7z-compressed' ||
    mimeType === 'application/gzip'
  ) {
    return 'ARCHIVE';
  }

  if (mimeType === 'application/json' || mimeType === 'application/xml') return 'CODE';
  if (mimeType.startsWith('text/')) return 'TEXT';

  return null;
}

const EXTENSION_KIND: Record<string, FileKind> = {
  pdf: 'PDF',
  doc: 'WORD', docx: 'WORD', rtf: 'WORD',
  xls: 'EXCEL', xlsx: 'EXCEL', csv: 'EXCEL',
  ppt: 'POWERPOINT', pptx: 'POWERPOINT',
  png: 'IMAGE', jpg: 'IMAGE', jpeg: 'IMAGE', gif: 'IMAGE', webp: 'IMAGE', svg: 'IMAGE', bmp: 'IMAGE',
  zip: 'ARCHIVE', rar: 'ARCHIVE', '7z': 'ARCHIVE', gz: 'ARCHIVE', tar: 'ARCHIVE',
  txt: 'TEXT', log: 'TEXT', md: 'TEXT',
  mp4: 'VIDEO', webm: 'VIDEO', mov: 'VIDEO', avi: 'VIDEO', mkv: 'VIDEO',
  mp3: 'AUDIO', wav: 'AUDIO', ogg: 'AUDIO', m4a: 'AUDIO', flac: 'AUDIO',
  json: 'CODE', xml: 'CODE', ts: 'CODE', tsx: 'CODE', js: 'CODE', jsx: 'CODE',
  html: 'CODE', css: 'CODE', sql: 'CODE', yml: 'CODE', yaml: 'CODE', sh: 'CODE', py: 'CODE',
};

export function getExtension(name: string): string {
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) return '';
  return name.slice(index + 1).toLowerCase();
}

/**
 * ชนิดไฟล์สำหรับแสดงผล
 * ใช้ MIME ที่เซิร์ฟเวอร์ตรวจแล้วเป็นหลัก และใช้นามสกุลเป็นตัวสำรองเท่านั้น
 */
export function getFileTypeStyle(name: string, mimeType?: string | null): FileTypeStyle {
  if (mimeType) {
    const byMime = kindFromMime(mimeType);
    // octet-stream แปลว่าเซิร์ฟเวอร์ไม่ยืนยันชนิด จึงยอมให้นามสกุลช่วยจัดกลุ่มการแสดงผล
    if (byMime && mimeType !== 'application/octet-stream') return STYLES[byMime];
  }
  const byExtension = EXTENSION_KIND[getExtension(name)];
  return STYLES[byExtension ?? 'OTHER'];
}

/** ชนิดที่เปิดดูได้ในเบราว์เซอร์ผ่าน endpoint เนื้อหาที่ปลอดภัย */
const PREVIEWABLE_MIME = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'text/plain', 'text/csv', 'text/markdown',
  'application/json', 'application/xml',
  'audio/mpeg', 'audio/wav', 'video/mp4', 'video/webm',
]);

const PREVIEWABLE_EXTENSION = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp',
  'txt', 'csv', 'log', 'md', 'json', 'xml',
  'mp3', 'wav', 'mp4', 'webm',
]);

export type PreviewMode = 'PDF' | 'IMAGE' | 'TEXT' | 'AUDIO' | 'VIDEO' | 'NONE';

/**
 * โหมดการแสดงตัวอย่าง
 * HTML และ SVG ถูกกันออกโดยตั้งใจ เพราะอาจมีสคริปต์ฝังอยู่
 * ไฟล์เหล่านั้นให้ดาวน์โหลดแทน
 */
export function getPreviewMode(name: string, mimeType?: string | null): PreviewMode {
  const extension = getExtension(name);
  if (extension === 'svg' || extension === 'html' || extension === 'htm') return 'NONE';

  const mime = mimeType && PREVIEWABLE_MIME.has(mimeType) ? mimeType : null;
  const usable = mime ?? (PREVIEWABLE_EXTENSION.has(extension) ? extension : null);
  if (!usable) return 'NONE';

  if (usable === 'application/pdf' || extension === 'pdf') return 'PDF';
  if (usable.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) return 'IMAGE';
  if (usable.startsWith('audio/') || ['mp3', 'wav'].includes(extension)) return 'AUDIO';
  if (usable.startsWith('video/') || ['mp4', 'webm'].includes(extension)) return 'VIDEO';
  return 'TEXT';
}

export function isPreviewable(name: string, mimeType?: string | null): boolean {
  return getPreviewMode(name, mimeType) !== 'NONE';
}

export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_KIND);
