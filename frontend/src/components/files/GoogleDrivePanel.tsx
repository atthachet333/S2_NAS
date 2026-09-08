import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, RefreshCw, Unlink } from 'lucide-react';
import { ApiError, googleDriveApi } from '@/lib/api';
import { safeGoogleDriveUrl, SYNC_STATUS } from '@/lib/google-drive';
import { formatDateTime } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';

/**
 * แผงต้นทาง Google Drive ของทรัพยากรหนึ่งชิ้น (F19)
 *
 * แสดงเฉพาะเมื่อทรัพยากรนั้นผูกกับ Google จริง - ทรัพยากรทั่วไปไม่เห็นอะไรเลย
 * แผงที่ว่างเปล่าแต่ยังกินพื้นที่ทำให้แผงรายละเอียดยาวขึ้นโดยไม่ให้อะไรกลับมา
 */

const ERROR_TEXT: Record<string, string> = {
  GOOGLE_DRIVE_SYNC_NOT_FOUND: 'ทรัพยากรนี้ไม่ได้เชื่อมกับ Google Drive',
  GOOGLE_DRIVE_DETACH_DENIED: 'ไม่มีสิทธิ์หยุดซิงก์ทรัพยากรนี้',
  GOOGLE_DRIVE_REAUTH_REQUIRED: 'ต้องเชื่อมต่อ Google Drive ใหม่',
};

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? (ERROR_TEXT[error.code] ?? error.message ?? fallback) : fallback;

export function GoogleDrivePanel({ resourceId }: { resourceId: string }) {
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [confirmDetach, setConfirmDetach] = useState(false);

  const sync = useQuery({
    queryKey: ['drive-sync', resourceId],
    queryFn: () => googleDriveApi.resourceSync(resourceId),
    retry: false,
  });

  const check = useMutation({
    mutationFn: () => googleDriveApi.checkSync(resourceId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['drive-sync', resourceId] });
      // เวอร์ชันใหม่ทำให้รายการไฟล์และประวัติเวอร์ชันเปลี่ยน
      if (result.data.outcome === 'VERSION_CREATED') {
        void queryClient.invalidateQueries({ queryKey: ['drive'] });
        void queryClient.invalidateQueries({ queryKey: ['versions', resourceId] });
      }
      notify({
        tone: result.data.outcome === 'VERSION_CREATED' ? 'success' : 'info',
        title: result.data.message,
      });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'ตรวจสอบไม่สำเร็จ') }),
  });

  const detach = useMutation({
    mutationFn: () => googleDriveApi.detach(resourceId),
    onSuccess: () => {
      setConfirmDetach(false);
      void queryClient.invalidateQueries({ queryKey: ['drive-sync', resourceId] });
      notify({
        tone: 'success',
        title: 'หยุดซิงก์แล้ว',
        description: 'ไฟล์และประวัติเวอร์ชันทั้งหมดยังอยู่ครบใน S2 NAS',
      });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'หยุดซิงก์ไม่สำเร็จ') }),
  });

  // ทรัพยากรที่ไม่ได้มาจาก Google ไม่ต้องเห็นแผงนี้เลย
  if (sync.isPending || sync.isError) return null;
  const info = sync.data?.data;
  if (!info) return null;

  const style = SYNC_STATUS[info.status];
  const detached = info.status === 'DETACHED';
  const remoteUrl = safeGoogleDriveUrl(info.remoteWebUrl);

  return (
    <div>
      <p className="s2-section-title">Google Drive</p>

      <div className="mt-2 rounded-xl border border-line bg-[var(--s2-surface-soft)] px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* ป้ายสถานะมีข้อความเสมอ ไม่พึ่งสีอย่างเดียว */}
          <span className={`rounded-md border px-1.5 py-0.5 text-[10.5px] ${style.className}`}>
            {style.label}
          </span>
          <span className="text-[11px] text-navy-400">{info.googleAccountEmail}</span>
        </div>

        {info.remoteName ? (
          <p className="mt-1.5 truncate text-[11.5px] text-navy-600">ต้นทาง: {info.remoteName}</p>
        ) : null}

        {info.lastSyncedAt ? (
          <p className="mt-0.5 text-[11px] text-navy-400">
            ซิงก์ล่าสุด: {formatDateTime(info.lastSyncedAt)}
          </p>
        ) : null}

        {/*
          ข้อความอธิบายว่าทำไมถึงไม่อัปเดต - ผู้ใช้ที่เห็นไฟล์ไม่เปลี่ยนต้องรู้สาเหตุ
          ไม่ใช่เดาเอาว่าระบบพัง
        */}
        {info.message ? (
          <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--s2-warning-ring)]">
            {info.message}
          </p>
        ) : null}

        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {!detached ? (
            <button
              type="button"
              onClick={() => check.mutate()}
              disabled={check.isPending}
              className="s2-btn s2-btn-outline h-7 gap-1 px-2 text-[11.5px] disabled:opacity-60"
            >
              {check.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-3 w-3" aria-hidden />
              )}
              ตรวจสอบตอนนี้
            </button>
          ) : null}

          {/*
            ลิงก์ไป Google เห็นเฉพาะบุคลากรภายในที่เปิดแผงนี้ได้
            ไม่ปรากฏในพื้นที่ลูกค้าหรือหน้าของแขก
          */}
          {remoteUrl ? (
            <a
              href={remoteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="s2-btn s2-btn-ghost h-7 gap-1 px-2 text-[11.5px]"
            >
              <ExternalLink className="h-3 w-3" aria-hidden />
              เปิดใน Google Drive
            </a>
          ) : null}

          {!detached && !confirmDetach ? (
            <button
              type="button"
              onClick={() => setConfirmDetach(true)}
              disabled={detach.isPending}
              className="s2-btn s2-btn-ghost h-7 gap-1 px-2 text-[11.5px] text-red-600 disabled:opacity-60"
            >
              <Unlink className="h-3 w-3" aria-hidden />
              หยุดซิงก์
            </button>
          ) : null}
        </div>

        {confirmDetach ? (
          <div className="mt-2.5 rounded-lg border border-red-200 bg-red-50 p-2.5 text-[11px] leading-relaxed text-[var(--s2-danger-ring)]">
            <p>หยุดซิงก์ถาวรหรือไม่? ไฟล์และทุกเวอร์ชันใน S2 NAS จะยังอยู่ครบ</p>
            <div className="mt-2 flex flex-wrap justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setConfirmDetach(false)}
                disabled={detach.isPending}
                className="s2-btn s2-btn-ghost h-7 px-2 text-[11.5px]"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={() => detach.mutate()}
                disabled={detach.isPending}
                className="s2-btn h-7 gap-1 border border-red-200 bg-red-50 px-2 text-[11.5px] text-red-700 disabled:opacity-60"
              >
                {detach.isPending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
                ยืนยันหยุดซิงก์
              </button>
            </div>
          </div>
        ) : null}

        {detached ? (
          <p className="mt-2 text-[11px] leading-relaxed text-navy-400">
            ทรัพยากรนี้เป็นเอกสารของ S2 NAS แล้ว การเปลี่ยนแปลงฝั่ง Google ไม่มีผลอีกต่อไป
          </p>
        ) : null}
      </div>
    </div>
  );
}
