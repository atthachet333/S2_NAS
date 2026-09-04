import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, ExternalLink, Eye, History } from 'lucide-react';
import { authorizedFetch, portalApi, type PortalResourceDto } from '@/lib/api';
import { FileTypeIcon } from '@/components/files/FileTypeIcon';
import {
  canPreviewInBrowser,
  openPortalBlob,
  savePortalBlob,
  unsupportedPreviewMessage,
} from '@/lib/portal-files';
import { formatBytes, formatDateTime } from '@/lib/utils';
import { splitSnippet } from '@/lib/search-content';
import { useToast } from '@/hooks/useToast';
import { PortalVersionDialog } from './PortalVersionDialog';

/**
 * รายการเอกสารในพื้นที่ลูกค้า
 *
 * แสดงเฉพาะสิ่งที่ลูกค้าทำได้จริง ปุ่มดาวน์โหลดไม่ปรากฏเมื่อสิทธิ์ไม่อนุญาต
 * (เซิร์ฟเวอร์ปฏิเสธอยู่แล้ว การซ่อนปุ่มคือการไม่ชวนให้ผู้ใช้ไปชนกำแพงเปล่า ๆ)
 *
 * ไม่มีเมนูคลิกขวา ไม่มีการเลือกหลายรายการ ไม่มีการลากวาง
 * เพราะไม่มีการกระทำใดในพื้นที่นี้ที่ต้องใช้สิ่งเหล่านั้น
 */
export function PortalItemList({
  items,
  showPath = false,
  term = '',
}: {
  items: PortalResourceDto[];
  /** แสดงเส้นทางของแต่ละรายการ - ใช้ในผลการค้นหาซึ่งรายการมาจากหลายโฟลเดอร์ */
  showPath?: boolean;
  /** คำค้นปัจจุบัน ใช้เน้นคำในตัวอย่างข้อความ */
  term?: string;
}) {
  const navigate = useNavigate();
  const { notify } = useToast();
  const [versionTarget, setVersionTarget] = useState<PortalResourceDto | null>(null);

  const preview = async (item: PortalResourceDto) => {
    if (!canPreviewInBrowser(item.name, item.mimeType)) {
      notify({ tone: 'info', title: unsupportedPreviewMessage(item.capabilities.canDownload) });
      return;
    }
    try {
      await openPortalBlob(portalApi.contentUrl(item.id));
    } catch {
      notify({ tone: 'error', title: 'เปิดดูเอกสารไม่สำเร็จ' });
    }
  };

  const download = async (item: PortalResourceDto) => {
    try {
      const response = await authorizedFetch(portalApi.downloadUrl(item.id));
      if (!response.ok) {
        notify({
          tone: 'error',
          title: response.status === 403 ? 'เอกสารนี้ไม่อนุญาตให้ดาวน์โหลด' : 'ดาวน์โหลดไม่สำเร็จ',
        });
        return;
      }
      savePortalBlob(await response.blob(), item.name);
    } catch {
      notify({ tone: 'error', title: 'ดาวน์โหลดไม่สำเร็จ' });
    }
  };

  if (items.length === 0) {
    return (
      <p className="s2-surface px-4 py-8 text-center text-[12.5px] text-navy-400">
        โฟลเดอร์นี้ยังไม่มีเอกสาร
      </p>
    );
  }

  return (
    <>
      <ul className="s2-surface divide-y divide-line overflow-hidden">
        {items.map((item) => {
          const isFolder = item.type === 'FOLDER';
          const isLink = Boolean(item.externalUrl);
          // เส้นทางที่แสดงตัดชื่อของตัวเองออก เหลือเฉพาะโฟลเดอร์ที่มันอยู่ข้างใน
          const path = showPath ? (item.path ?? []).slice(0, -1) : [];

          return (
            <li key={item.id} className="flex items-center gap-3 px-3 py-2.5 sm:px-4 sm:py-3">
              {/* ใช้ระบบไอคอนเดียวกับฝั่งภายใน ชนิดไฟล์จึงอ่านได้แบบเดียวกันทั้งระบบ */}
              <FileTypeIcon
                name={item.name}
                kind={isFolder ? 'folder' : 'file'}
                mimeType={item.mimeType}
                size="md"
              />

              <div className="min-w-0 flex-1">
                {isFolder ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/portal/folders/${item.id}`)}
                    className="block max-w-full truncate text-left text-[13px] font-medium text-navy-800 hover:text-brand-700 hover:underline"
                  >
                    {item.name}
                  </button>
                ) : (
                  <span className="block truncate text-[13px] font-medium text-navy-800">{item.name}</span>
                )}

                {path.length > 0 ? (
                  <span className="mt-0.5 block truncate text-[10.5px] text-navy-400">
                    {path.map((node) => node.name).join(' / ')}
                  </span>
                ) : null}

                {/*
                  ตัวอย่างข้อความจากเนื้อในเอกสาร
                  วาดเป็นชิ้น ๆ ผ่านการผูกค่าของ React ไม่มีการแทรก HTML จากเอกสารของผู้ใช้
                */}
                {item.contentSnippet ? (
                  <span className="mt-1 block rounded-lg bg-[var(--s2-surface-soft)] px-2 py-1 text-[11px] leading-relaxed text-navy-500">
                    {splitSnippet(item.contentSnippet, term).map((part, index) =>
                      part.highlight ? (
                        <mark key={index} className="rounded bg-amber-100 px-0.5 text-navy-900">
                          {part.text}
                        </mark>
                      ) : (
                        <span key={index}>{part.text}</span>
                      ),
                    )}
                  </span>
                ) : null}

                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-navy-400">
                  {item.matchLabel ? (
                    <span className="rounded-md border border-line px-1.5 py-0.5 text-[10px] text-navy-500">
                      {item.matchLabel}
                    </span>
                  ) : null}
                  <span>{isFolder ? `${item.itemCount} รายการ` : formatBytes(item.size)}</span>
                  <span aria-hidden>·</span>
                  <span>{formatDateTime(item.uploadedAt)}</span>
                  {item.uploadedBy ? (
                    <>
                      <span aria-hidden>·</span>
                      <span className="truncate">{item.uploadedBy}</span>
                    </>
                  ) : null}
                  {/* ป้ายภาษาไทย ไม่ใช่ค่าดิบของ enum */}
                  {item.sourceLabel ? (
                    <span className="rounded-md border border-line px-1.5 py-0.5 text-[10px] text-navy-500">
                      {item.sourceLabel}
                    </span>
                  ) : null}
                </span>
              </div>

              <div className="flex shrink-0 items-center gap-0.5">
                {isLink && item.externalUrl ? (
                  <a
                    href={item.externalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="s2-btn s2-btn-ghost h-8 gap-1.5 px-2 text-[12px]"
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    <span className="hidden sm:inline">เปิดลิงก์</span>
                  </a>
                ) : null}

                {!isFolder && !isLink ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void preview(item)}
                      className="s2-btn s2-btn-ghost h-8 gap-1.5 px-2 text-[12px]"
                    >
                      <Eye className="h-3.5 w-3.5" aria-hidden />
                      <span className="hidden sm:inline">เปิดดู</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setVersionTarget(item)}
                      className="s2-btn s2-btn-ghost h-8 gap-1.5 px-2 text-[12px]"
                      aria-label={`ประวัติเวอร์ชันของ ${item.name}`}
                    >
                      <History className="h-3.5 w-3.5" aria-hidden />
                      <span className="hidden lg:inline">เวอร์ชัน</span>
                    </button>
                  </>
                ) : null}

                {item.capabilities.canDownload ? (
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
          );
        })}
      </ul>

      {versionTarget ? (
        <PortalVersionDialog resource={versionTarget} onClose={() => setVersionTarget(null)} />
      ) : null}
    </>
  );
}
