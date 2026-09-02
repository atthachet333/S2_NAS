import { useEffect, useState } from 'react';
import { Folder } from 'lucide-react';
import { getFileTypeStyle } from '@/lib/file-types';
import { authorizedFetch, fileApi } from '@/lib/api';
import { cn } from '@/lib/utils';

const BOX = {
  sm: 'h-7 w-7 rounded-lg',
  md: 'h-9 w-9 rounded-[10px]',
  lg: 'h-11 w-11 rounded-xl',
} as const;

const GLYPH = {
  sm: 'h-3.5 w-3.5',
  md: 'h-[18px] w-[18px]',
  lg: 'h-5 w-5',
} as const;

/**
 * ไอคอนตามชนิดไฟล์
 *
 * ใช้ MIME ที่เซิร์ฟเวอร์ตรวจจากลายเซ็นไฟล์เป็นหลัก นามสกุลเป็นเพียงตัวสำรอง
 * สำหรับรูปภาพ สามารถโหลดภาพย่อผ่าน endpoint เนื้อหาที่ตรวจสิทธิ์แล้วเท่านั้น
 * ไม่มีการเปิดเผยเส้นทางไฟล์จริงบนเซิร์ฟเวอร์
 */
export function FileTypeIcon({
  name,
  kind,
  size = 'md',
  mimeType,
  /** เปิดภาพย่อของไฟล์รูปภาพ ต้องส่ง resourceId มาด้วย */
  resourceId,
  showThumbnail = false,
  sizeBytes,
}: {
  name: string;
  kind: 'file' | 'folder';
  size?: keyof typeof BOX;
  mimeType?: string | null;
  resourceId?: string;
  showThumbnail?: boolean;
  sizeBytes?: number;
}) {
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const style = getFileTypeStyle(name, mimeType);
  const safeImageMime = mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType === 'image/webp' || mimeType === 'image/gif';
  const wantsThumbnail = showThumbnail && kind === 'file' && safeImageMime && Boolean(resourceId) && (sizeBytes ?? 0) <= 10 * 1024 * 1024;

  useEffect(() => {
    if (!wantsThumbnail || !resourceId) return;
    let objectUrl: string | null = null;
    let active = true;

    // ดึงผ่าน fetch เพื่อให้ cookie/สิทธิ์ถูกตรวจตามปกติ แล้วแปลงเป็น blob URL ชั่วคราว
    void authorizedFetch(fileApi.contentPath(resourceId))
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (!active || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setThumbnail(objectUrl);
      })
      .catch(() => undefined);

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [wantsThumbnail, resourceId]);

  if (kind === 'folder') {
    return (
      <span className={cn('flex shrink-0 items-center justify-center bg-brand-50 text-brand-600', BOX[size])}>
        <Folder className={GLYPH[size]} aria-hidden />
      </span>
    );
  }

  if (thumbnail) {
    return (
      <span className={cn('flex shrink-0 items-center justify-center overflow-hidden border border-line', BOX[size])}>
        <img
          src={thumbnail}
          alt={`ภาพย่อ ${name}`}
          loading="lazy"
          decoding="async"
          onError={(event) => {
            URL.revokeObjectURL(event.currentTarget.src);
            setThumbnail(null);
          }}
          className="h-full w-full object-cover"
        />
      </span>
    );
  }

  const Icon = style.icon;
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center', style.bg, style.fg, BOX[size])}
      title={style.label}
    >
      <Icon className={GLYPH[size]} aria-hidden />
    </span>
  );
}
