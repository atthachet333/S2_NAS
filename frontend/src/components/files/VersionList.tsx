import { useQuery } from '@tanstack/react-query';
import { Download, Eye, FileUp } from 'lucide-react';
import { authorizedFetch, fileApi } from '@/lib/api';
import { downloadResource } from '@/lib/download';
import { isPreviewable } from '@/lib/file-types';
import { useToast } from '@/hooks/useToast';
import { useUploadQueue } from '@/hooks/useUploadQueue';
import { OwnerAvatar, ownerLabel } from './OwnerIdentity';
import { ErrorState, TextSkeleton } from '@/components/ui/States';
import type { DriveEntry } from '@/lib/drive';
import { formatBytes, formatDateTime, formatRelativeTime } from '@/lib/utils';
import { useRef } from 'react';
import { VERSION_DOWNLOAD_LABEL } from '@/lib/interaction-policy';

/**
 * ประวัติเวอร์ชันของไฟล์
 *
 * ข้อมูลทั้งหมดมาจาก ResourceVersion จริง ไม่มีการเปรียบเทียบความต่างจำลอง
 * เวอร์ชันเก่ายังเปิดดูและดาวน์โหลดได้ตามสิทธิ์ที่เซิร์ฟเวอร์กำหนด
 */
export function VersionList({ entry }: { entry: DriveEntry }) {
  const { notify } = useToast();
  const { enqueueVersion } = useUploadQueue();
  const pickerRef = useRef<HTMLInputElement>(null);

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['versions', entry.id],
    queryFn: () => fileApi.versions(entry.id),
  });

  if (isPending) return <TextSkeleton lines={5} />;
  if (isError) return <ErrorState message="โหลดประวัติเวอร์ชันไม่สำเร็จ" onRetry={() => void refetch()} />;

  const versions = data.data;

  /** เปิดเวอร์ชันเก่าในแท็บใหม่ผ่าน blob ที่ดึงมาแบบมีสิทธิ์ */
  const openVersion = async (versionNumber: number) => {
    try {
      const response = await authorizedFetch(fileApi.contentPath(entry.id, versionNumber));
      if (!response.ok) throw new Error('preview failed');
      const url = URL.createObjectURL(await response.blob());
      window.open(url, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      notify({ tone: 'error', title: 'เปิดตัวอย่างเวอร์ชันนี้ไม่สำเร็จ' });
    }
  };

  const download = async (versionNumber: number) => {
    try {
      await downloadResource(entry.id, entry.name, versionNumber);
    } catch (error) {
      notify({ tone: 'error', title: error instanceof Error ? error.message : 'ดาวน์โหลดไม่สำเร็จ' });
    }
  };

  return (
    <div className="space-y-3">
      {entry.capabilities.canUploadVersion ? (
        <>
          <button
            type="button"
            className="s2-btn s2-btn-outline w-full"
            onClick={() => pickerRef.current?.click()}
          >
            <FileUp className="h-4 w-4" aria-hidden />
            อัปโหลดเวอร์ชันใหม่
          </button>
          <input
            ref={pickerRef}
            type="file"
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) enqueueVersion(file, { resourceId: entry.id, resourceName: entry.name });
              event.target.value = '';
            }}
          />
          <p className="text-[10.5px] leading-relaxed text-navy-400">
            กำลังอัปโหลดเวอร์ชันใหม่สำหรับ <span className="font-medium text-navy-600">{entry.name}</span>
          </p>
        </>
      ) : null}

      <ul className="space-y-2">
        {versions.map((version) => (
          <li
            key={version.id}
            className="rounded-xl border border-line bg-[var(--s2-surface-soft)] px-3 py-2.5"
          >
            <div className="flex items-center gap-2">
              <span className="text-[12.5px] font-semibold text-navy-900">v{version.versionNumber}</span>
              {version.isCurrent ? (
                <span className="rounded-md bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">
                  ปัจจุบัน
                </span>
              ) : null}
              <span className="ml-auto text-[10.5px] text-navy-400">{formatBytes(version.size)}</span>
            </div>

            <div className="mt-1.5 flex items-center gap-1.5">
              <OwnerAvatar owner={version.createdBy} size="xs" />
              <span className="min-w-0 truncate text-[10.5px] text-navy-400" title={formatDateTime(version.createdAt)}>
                {ownerLabel(version.createdBy)} · {formatRelativeTime(version.createdAt)}
              </span>
            </div>

            {version.remark ? (
              <p className="mt-1.5 text-[11px] leading-relaxed text-navy-500">{version.remark}</p>
            ) : null}

            <div className="mt-2 flex gap-1.5">
              {isPreviewable(entry.name, version.mimeType) ? (
                <button
                  type="button"
                  onClick={() => void openVersion(version.versionNumber)}
                  className="inline-flex items-center gap-1 rounded-lg border border-line bg-[var(--s2-surface)] px-2 py-1 text-[11px] text-navy-600 transition-colors hover:bg-navy-50"
                >
                  <Eye className="h-3 w-3" aria-hidden />
                  ดูตัวอย่าง
                </button>
              ) : null}

              {version.canDownload ? (
                <button
                  type="button"
                  onClick={() => void download(version.versionNumber)}
                  className="inline-flex items-center gap-1 rounded-lg border border-line bg-[var(--s2-surface)] px-2 py-1 text-[11px] text-navy-600 transition-colors hover:bg-navy-50"
                >
                  <Download className="h-3 w-3" aria-hidden />
                  {VERSION_DOWNLOAD_LABEL}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
