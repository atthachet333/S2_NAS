import { useEffect, useState } from 'react';
import { Download, Eye, History, X } from 'lucide-react';
import { authorizedFetch, portalApi, type PortalResourceDto, type PortalVersionDto } from '@/lib/api';
import { formatBytes, formatDateTime } from '@/lib/utils';
import { TextSkeleton } from '@/components/ui/States';
import { useToast } from '@/hooks/useToast';
import { openPortalBlob, savePortalBlob } from '@/lib/portal-files';

/**
 * ประวัติเวอร์ชันที่ลูกค้าเห็น
 *
 * อ่านอย่างเดียวทั้งหมด - ไม่มีกู้คืน ไม่มีลบ ไม่มีอัปโหลดทับ
 * ไม่ใช่เพราะปุ่มถูกซ่อน แต่เพราะไม่มี API ให้ทำสิ่งเหล่านั้นตั้งแต่แรก
 *
 * เวอร์ชันถูกอ้างถึงด้วยเลขลำดับภายในไฟล์ ไม่ใช่รหัสของแถวเวอร์ชัน
 * ที่อยู่ของเวอร์ชันจึงมีความหมายก็ต่อเมื่อมาคู่กับไฟล์ที่ผ่านการตรวจสิทธิ์แล้วเท่านั้น
 */
export function PortalVersionDialog({
  resource,
  onClose,
}: {
  resource: PortalResourceDto;
  onClose: () => void;
}) {
  const { notify } = useToast();
  const [versions, setVersions] = useState<PortalVersionDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    portalApi
      .versions(resource.id)
      .then((response) => {
        if (active) setVersions(response.data);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [resource.id]);

  const preview = async (versionNumber: number) => {
    setBusy(versionNumber);
    try {
      await openPortalBlob(portalApi.versionContentUrl(resource.id, versionNumber));
    } catch {
      notify({ tone: 'error', title: 'เปิดดูเวอร์ชันนี้ไม่สำเร็จ' });
    } finally {
      setBusy(null);
    }
  };

  const download = async (versionNumber: number) => {
    setBusy(versionNumber);
    try {
      const response = await authorizedFetch(portalApi.versionDownloadUrl(resource.id, versionNumber));
      if (!response.ok) {
        notify({
          tone: 'error',
          title: response.status === 403 ? 'เอกสารนี้ไม่อนุญาตให้ดาวน์โหลด' : 'ดาวน์โหลดไม่สำเร็จ',
        });
        return;
      }
      savePortalBlob(await response.blob(), `${versionNumber} - ${resource.name}`);
    } catch {
      notify({ tone: 'error', title: 'ดาวน์โหลดไม่สำเร็จ' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-3 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="portal-version-title"
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
            <History className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="portal-version-title" className="text-[15.5px] font-semibold text-navy-900">
              เวอร์ชัน
            </h2>
            <p className="mt-0.5 truncate text-[11px] text-navy-400">{resource.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="rounded-lg p-1.5 text-navy-400 hover:bg-navy-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4">
          {failed ? (
            <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[12px] text-navy-400">
              ไม่สามารถแสดงประวัติเวอร์ชันได้ในขณะนี้
            </p>
          ) : versions === null ? (
            <TextSkeleton lines={3} />
          ) : versions.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[12px] text-navy-400">
              เอกสารนี้ยังไม่มีประวัติเวอร์ชัน
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {versions.map((version) => (
                <li key={version.versionNumber} className="flex items-center gap-2 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-navy-800">
                      {version.isCurrent ? 'เวอร์ชันปัจจุบัน' : `เวอร์ชันที่ ${version.versionNumber}`}
                      {version.isCurrent ? (
                        <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                          ล่าสุด
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 truncate text-[10.5px] text-navy-400">
                      {formatDateTime(version.createdAt)}
                      {version.uploadedBy ? ` · อัปโหลดโดย ${version.uploadedBy}` : ''}
                      {` · ${formatBytes(version.size)}`}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      disabled={busy === version.versionNumber}
                      onClick={() => void preview(version.versionNumber)}
                      className="s2-btn s2-btn-ghost h-8 px-2 text-[12px] disabled:opacity-50"
                      aria-label={`เปิดดูเวอร์ชันที่ ${version.versionNumber}`}
                    >
                      <Eye className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    {/* สิทธิ์ดาวน์โหลดของเวอร์ชันเก่าเท่ากับของเวอร์ชันปัจจุบันเสมอ */}
                    {version.canDownload ? (
                      <button
                        type="button"
                        disabled={busy === version.versionNumber}
                        onClick={() => void download(version.versionNumber)}
                        className="s2-btn s2-btn-ghost h-8 px-2 text-[12px] disabled:opacity-50"
                        aria-label={`ดาวน์โหลดเวอร์ชันที่ ${version.versionNumber}`}
                      >
                        <Download className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-end pt-4">
          <button type="button" onClick={onClose} className="s2-btn s2-btn-ghost">
            ปิด
          </button>
        </div>
      </section>
    </div>
  );
}
