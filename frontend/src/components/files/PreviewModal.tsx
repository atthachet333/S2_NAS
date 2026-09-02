import { useEffect, useRef, useState } from 'react';
import { Download, FileQuestion, Info, Loader2, X } from 'lucide-react';
import { authorizedFetch, fileApi } from '@/lib/api';
import { getFileTypeStyle, getPreviewMode } from '@/lib/file-types';
import { downloadResource } from '@/lib/download';
import { FileTypeIcon } from './FileTypeIcon';
import { useToast } from '@/hooks/useToast';
import type { DriveEntry } from '@/lib/drive';
import { formatBytes } from '@/lib/utils';
import { ORIGINAL_DOWNLOAD_LABEL } from '@/lib/interaction-policy';

/**
 * หน้าต่างแสดงตัวอย่างไฟล์
 *
 * เนื้อหาถูกดึงผ่าน endpoint ที่ตรวจสิทธิ์แล้วเสมอ และแปลงเป็น blob URL ชั่วคราว
 * ไม่มีการเปิดเส้นทางไฟล์จริงบนเซิร์ฟเวอร์
 *
 * ข้อความถูกแสดงเป็นข้อความล้วนเท่านั้น ไม่มีการฝัง HTML ที่ผู้ใช้อัปโหลด
 * ไฟล์ HTML/SVG จึงไม่เปิดตัวอย่างและให้ดาวน์โหลดแทน
 */
export function PreviewModal({
  entry,
  onClose,
  onShowDetails,
}: {
  entry: DriveEntry;
  onClose: () => void;
  onShowDetails?: () => void;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<'LOADING' | 'READY' | 'ERROR'>('LOADING');
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const { notify } = useToast();

  const mode = getPreviewMode(entry.name, entry.mimeType);
  const style = getFileTypeStyle(entry.name, entry.mimeType);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (mode === 'NONE') {
      setState('READY');
      return;
    }

    let active = true;
    let created: string | null = null;

    void authorizedFetch(fileApi.contentPath(entry.id))
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        if (mode === 'TEXT') {
          const body = await response.text();
          if (!active) return;
          // ตัดความยาวเพื่อไม่ให้ไฟล์ log ขนาดใหญ่ทำให้หน้าค้าง
          setText(body.slice(0, 200_000));
          setState('READY');
          return;
        }
        const blob = await response.blob();
        if (!active) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
        setState('READY');
      })
      .catch(() => {
        if (active) setState('ERROR');
      });

    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [entry.id, mode]);

  const download = async () => {
    try {
      await downloadResource(entry.id, entry.name);
    } catch (error) {
      notify({ tone: 'error', title: error instanceof Error ? error.message : 'ดาวน์โหลดไม่สำเร็จ' });
    }
  };

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex flex-col bg-[var(--s2-overlay)] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`ตัวอย่างไฟล์ ${entry.name}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-line bg-[var(--s2-surface)] px-4 py-3">
        <FileTypeIcon name={entry.name} kind="file" size="sm" mimeType={entry.mimeType} />

        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold text-navy-900">{entry.name}</p>
          <p className="truncate text-[10.5px] text-navy-400">
            {style.label} · {formatBytes(entry.sizeBytes)}
            {entry.currentVersion ? ` · เวอร์ชัน ${entry.currentVersion}` : ''}
          </p>
        </div>

        {entry.capabilities.canDownload ? (
          <button type="button" onClick={download} className="s2-btn s2-btn-outline">
            <Download className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">{ORIGINAL_DOWNLOAD_LABEL}</span>
          </button>
        ) : null}

        {onShowDetails ? (
          <button type="button" onClick={onShowDetails} className="s2-btn s2-btn-ghost">
            <Info className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">รายละเอียด</span>
          </button>
        ) : null}

        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="ปิดตัวอย่าง"
          className="rounded-lg p-2 text-navy-400 hover:bg-navy-50 hover:text-navy-700"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3 sm:p-6">
        {state === 'LOADING' ? (
          <div className="flex flex-col items-center gap-2 text-navy-200">
            <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
            <p className="text-[12px]">กำลังโหลดตัวอย่าง…</p>
          </div>
        ) : state === 'ERROR' ? (
          <Fallback entry={entry} onDownload={download} message="เปิดตัวอย่างไฟล์นี้ไม่สำเร็จ" />
        ) : mode === 'NONE' ? (
          <Fallback entry={entry} onDownload={download} message="ไม่รองรับการแสดงตัวอย่างไฟล์ประเภทนี้ในขณะนี้" />
        ) : mode === 'PDF' && objectUrl ? (
          <iframe src={objectUrl} title={entry.name} className="h-full w-full rounded-xl bg-white" />
        ) : mode === 'IMAGE' && objectUrl ? (
          <img src={objectUrl} alt={entry.name} className="max-h-full max-w-full rounded-xl object-contain" />
        ) : mode === 'VIDEO' && objectUrl ? (
          <video src={objectUrl} controls className="max-h-full max-w-full rounded-xl" />
        ) : mode === 'AUDIO' && objectUrl ? (
          <audio src={objectUrl} controls className="w-full max-w-lg" />
        ) : mode === 'TEXT' && text !== null ? (
          <pre className="h-full w-full max-w-4xl overflow-auto rounded-xl border border-line bg-[var(--s2-surface)] p-4 text-[12px] leading-relaxed text-navy-800">
            {text}
          </pre>
        ) : (
          <Fallback entry={entry} onDownload={download} message="ไม่รองรับการแสดงตัวอย่างไฟล์ประเภทนี้ในขณะนี้" />
        )}
      </div>
    </div>
  );
}

function Fallback({
  entry,
  onDownload,
  message,
}: {
  entry: DriveEntry;
  onDownload: () => void;
  message: string;
}) {
  return (
    <div className="s2-resource-card mx-auto flex w-full max-w-sm flex-col items-center gap-2 px-6 py-8 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-navy-50 text-navy-300">
        <FileQuestion className="h-5 w-5" aria-hidden />
      </span>
      <p className="mt-1 truncate text-[13.5px] font-semibold text-navy-900">{entry.name}</p>
      <p className="text-[11px] text-navy-400">{formatBytes(entry.sizeBytes)}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-navy-400">{message}</p>

      {entry.capabilities.canDownload ? (
        <button type="button" onClick={onDownload} className="s2-btn s2-btn-primary mt-3">
          <Download className="h-4 w-4" aria-hidden />
          {ORIGINAL_DOWNLOAD_LABEL}
        </button>
      ) : (
        <p className="mt-3 text-[11px] text-navy-400">คุณไม่มีสิทธิ์ดาวน์โหลดไฟล์นี้</p>
      )}
    </div>
  );
}
