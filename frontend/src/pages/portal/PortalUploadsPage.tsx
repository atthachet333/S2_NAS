import { useCallback, useEffect, useState } from 'react';
import { Download, Eye, FolderInput, Search, Upload } from 'lucide-react';
import { authorizedFetch, portalApi, type UploadHistoryItem } from '@/lib/api';
import { FileTypeIcon } from '@/components/files/FileTypeIcon';
import { uploadStateTone } from '@/lib/search-content';
import {
  canPreviewInBrowser,
  openPortalBlob,
  savePortalBlob,
  unsupportedPreviewMessage,
} from '@/lib/portal-files';
import { ListSkeleton } from '@/components/ui/States';
import { formatBytes, formatDateTime } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';

const TONE_CLASS = {
  success: 'bg-emerald-50 text-emerald-700',
  muted: 'bg-navy-50 text-navy-600',
  danger: 'bg-red-50 text-red-700',
} as const;

/**
 * ประวัติการอัปโหลดของลูกค้า
 *
 * ตอบสามคำถาม: ส่งอะไรไปแล้ว · เมื่อไร · ไว้ที่ไหน
 *
 * ประวัติไม่ใช่ช่องทางเข้าถึงที่สอง - ปุ่มเปิดดูและดาวน์โหลดปรากฏตามสิทธิ์ปัจจุบันเท่านั้น
 * ไฟล์ที่เจ้าหน้าที่ย้ายออกไปแล้วยังอยู่ในรายการว่าเคยส่ง แต่เปิดไม่ได้อีก
 * และเราไม่บอกว่ามันถูกย้ายไปที่ไหน
 */
export default function PortalUploadsPage() {
  const { notify } = useToast();
  const [items, setItems] = useState<UploadHistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [term, setTerm] = useState('');
  const [extension, setExtension] = useState('');
  const [types, setTypes] = useState<string[]>([]);

  const load = useCallback(
    (append: boolean, nextCursor?: string | null) => {
      if (append) setLoadingMore(true);
      else setLoading(true);

      portalApi
        .uploads({
          q: term.trim() || undefined,
          extension: extension || undefined,
          limit: 25,
          cursor: append ? nextCursor ?? undefined : undefined,
        })
        .then((response) => {
          setItems((current) => (append ? [...current, ...response.data.items] : response.data.items));
          setCursor(response.data.nextCursor);
          setTotal(response.data.total);
        })
        .catch(() => {
          if (!append) {
            setItems([]);
            setTotal(0);
            setCursor(null);
          }
        })
        .finally(() => {
          setLoading(false);
          setLoadingMore(false);
        });
    },
    [term, extension],
  );

  useEffect(() => {
    const timer = setTimeout(() => load(false), 250);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    portalApi
      .uploadTypes()
      .then((response) => setTypes(response.data))
      .catch(() => setTypes([]));
  }, []);

  const preview = async (item: UploadHistoryItem) => {
    if (!canPreviewInBrowser(item.name, item.mimeType)) {
      notify({ tone: 'info', title: unsupportedPreviewMessage(item.canDownload) });
      return;
    }
    try {
      await openPortalBlob(portalApi.contentUrl(item.id));
    } catch {
      notify({ tone: 'error', title: 'เปิดดูเอกสารไม่สำเร็จ' });
    }
  };

  const download = async (item: UploadHistoryItem) => {
    try {
      const response = await authorizedFetch(portalApi.downloadUrl(item.id));
      if (!response.ok) {
        notify({ tone: 'error', title: 'ดาวน์โหลดไม่สำเร็จ' });
        return;
      }
      savePortalBlob(await response.blob(), item.name);
    } catch {
      notify({ tone: 'error', title: 'ดาวน์โหลดไม่สำเร็จ' });
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-[19px] font-semibold text-navy-900">
          <Upload className="h-5 w-5 text-navy-400" aria-hidden />
          ประวัติการอัปโหลด
        </h1>
        <p className="mt-1 text-[12.5px] text-navy-400">
          เอกสารทั้งหมดที่คุณส่งเข้ามา พร้อมสถานะปัจจุบันของแต่ละรายการ
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="s2-surface flex min-w-[200px] flex-1 items-center gap-2 px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-navy-300" aria-hidden />
          <input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="ค้นหาชื่อไฟล์ที่เคยส่ง"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-navy-800 outline-none placeholder:text-navy-300"
          />
        </label>

        {types.length > 0 ? (
          <select
            value={extension}
            onChange={(event) => setExtension(event.target.value)}
            className="s2-input h-10 rounded-xl px-2 text-[12.5px]"
            aria-label="กรองตามประเภทไฟล์"
          >
            <option value="">ทุกประเภทไฟล์</option>
            {types.map((type) => (
              <option key={type} value={type}>
                .{type}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {loading ? (
        <ListSkeleton rows={4} />
      ) : items.length === 0 ? (
        <div className="s2-surface flex flex-col items-center gap-2 px-6 py-12 text-center">
          <Upload className="h-8 w-8 text-navy-200" aria-hidden />
          <p className="text-[13.5px] font-medium text-navy-800">คุณยังไม่เคยส่งเอกสารเข้ามา</p>
          <p className="max-w-[420px] text-[12px] text-navy-400">
            เมื่อคุณส่งไฟล์เข้าโฟลเดอร์ที่ได้รับสิทธิ์ รายการจะปรากฏที่นี่
          </p>
        </div>
      ) : (
        <>
          <p className="text-[11.5px] text-navy-400">ทั้งหมด {total} รายการ</p>

          <ul className="s2-surface divide-y divide-line overflow-hidden">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-3 py-2.5 sm:px-4 sm:py-3">
                <FileTypeIcon name={item.name} kind="file" mimeType={item.mimeType} size="md" />

                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-navy-800">{item.name}</p>

                  {/* ปลายทางแสดงเฉพาะเมื่อยังเข้าถึงได้ - ตำแหน่งภายในไม่ใช่ข้อมูลของลูกค้า */}
                  {item.destination && item.destination.length > 0 ? (
                    <p className="mt-0.5 flex items-center gap-1 truncate text-[10.5px] text-navy-400">
                      <FolderInput className="h-3 w-3 shrink-0" aria-hidden />
                      {item.destination.map((node) => node.name).join(' / ')}
                    </p>
                  ) : null}

                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-navy-400">
                    <span>{formatDateTime(item.uploadedAt)}</span>
                    <span aria-hidden>·</span>
                    <span>{formatBytes(item.size)}</span>
                    <span className={`rounded-md px-1.5 py-0.5 text-[10px] ${TONE_CLASS[uploadStateTone(item.state)]}`}>
                      {item.stateLabel}
                    </span>
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-0.5">
                  {item.canPreview ? (
                    <button
                      type="button"
                      onClick={() => void preview(item)}
                      className="s2-btn s2-btn-ghost h-8 gap-1.5 px-2 text-[12px]"
                    >
                      <Eye className="h-3.5 w-3.5" aria-hidden />
                      <span className="hidden sm:inline">เปิดดู</span>
                    </button>
                  ) : null}
                  {item.canDownload ? (
                    <button
                      type="button"
                      onClick={() => void download(item)}
                      className="s2-btn s2-btn-ghost h-8 gap-1.5 px-2 text-[12px]"
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden />
                      <span className="hidden sm:inline">ดาวน์โหลด</span>
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          {cursor ? (
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => load(true, cursor)}
              className="s2-btn s2-btn-outline h-9 w-full text-[12.5px] disabled:opacity-60"
            >
              {loadingMore ? 'กำลังโหลด…' : 'ดูรายการเพิ่มเติม'}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
