import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** แปลง byte เป็นหน่วยอ่านง่าย เช่น 1.48 TB */
export function formatBytes(bytes: number | null | undefined, decimals = 2): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '-';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : decimals)} ${units[i]}`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return new Intl.NumberFormat('th-TH').format(value);
}

/** แปลงวินาทีเป็นข้อความ uptime ภาษาไทย */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d} วัน ${h} ชม.`;
  if (h > 0) return `${h} ชม. ${m} นาที`;
  if (m > 0) return `${m} นาที ${s} วินาที`;
  return `${s} วินาที`;
}

/** วันที่และเวลาแบบไทย */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/**
 * เวลาแบบสัมพัทธ์ภาษาไทย เช่น "12 นาทีที่แล้ว"
 * ใช้กับ "แก้ไขล่าสุด" เพราะผู้ใช้สนใจว่าเพิ่งแก้ไปนานแค่ไหน มากกว่าวันที่เต็ม
 */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';

  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return 'เมื่อสักครู่';

  const units: Array<{ limit: number; divisor: number; label: string }> = [
    { limit: 3600, divisor: 60, label: 'นาที' },
    { limit: 86400, divisor: 3600, label: 'ชั่วโมง' },
    { limit: 604800, divisor: 86400, label: 'วัน' },
    { limit: 2592000, divisor: 604800, label: 'สัปดาห์' },
    { limit: 31536000, divisor: 2592000, label: 'เดือน' },
  ];

  for (const unit of units) {
    if (seconds < unit.limit) return `${Math.floor(seconds / unit.divisor)} ${unit.label}ที่แล้ว`;
  }
  return `${Math.floor(seconds / 31536000)} ปีที่แล้ว`;
}
