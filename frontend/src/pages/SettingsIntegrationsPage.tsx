import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Link2, Loader2, Plug, RefreshCw, Unlink } from 'lucide-react';
import { PageTitle } from '@/components/ui/PageTitle';
import { ApiError, googleDriveApi } from '@/lib/api';
import { CALLBACK_REASON, CALLBACK_TEXT, CONNECTION_STATUS } from '@/lib/google-drive';
import { formatDateTime } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';
import { DriveImportDialog } from '@/components/integrations/DriveImportDialog';

/**
 * การเชื่อมต่อภายนอกของผู้ใช้เอง (F19)
 *
 * อยู่ในพื้นที่ตั้งค่าของผู้ใช้ ไม่ใช่พื้นที่ผู้ดูแลระบบ - พนักงานเชื่อมต่อ
 * Google Drive ของตัวเองได้โดยไม่ต้องขอสิทธิ์ผู้ดูแล เพราะเป็นบัญชีของเขาเอง
 */

const ERROR_TEXT: Record<string, string> = {
  GOOGLE_DRIVE_CONNECT_DENIED: 'บัญชีของคุณเชื่อมต่อ Google Drive ไม่ได้',
  GOOGLE_DRIVE_NOT_CONFIGURED: 'ผู้ดูแลระบบยังไม่ได้ตั้งค่าการเชื่อมต่อ Google Drive',
  INTEGRATION_ENCRYPTION_UNAVAILABLE: 'ผู้ดูแลระบบยังไม่ได้ตั้งค่ากุญแจเข้ารหัสข้อมูลรับรอง',
  GOOGLE_DRIVE_CONNECTION_NOT_FOUND: 'ไม่พบการเชื่อมต่อนี้',
};

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? (ERROR_TEXT[error.code] ?? error.message ?? fallback) : fallback;

export default function SettingsIntegrationsPage() {
  const [params, setParams] = useSearchParams();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [importing, setImporting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const status = useQuery({
    queryKey: ['drive-status'],
    queryFn: googleDriveApi.status,
    retry: false,
  });

  /**
   * ผลของขั้นตอน OAuth กลับมาทาง URL
   *
   * แสดงเป็นข้อความแล้วล้างพารามิเตอร์ทิ้งทันที - ค่าเหล่านี้ไม่ควรค้างอยู่ใน
   * ประวัติเบราว์เซอร์ และไม่ควรแสดงซ้ำเมื่อผู้ใช้กดรีเฟรช
   */
  useEffect(() => {
    const result = params.get('googleDrive');
    if (!result) return;

    const reason = params.get('reason');
    notify({
      tone: result === 'connected' ? 'success' : result === 'cancelled' ? 'info' : 'error',
      title: CALLBACK_TEXT[result] ?? 'ดำเนินการเสร็จสิ้น',
      ...(reason && CALLBACK_REASON[reason] ? { description: CALLBACK_REASON[reason] } : {}),
    });

    const next = new URLSearchParams(params);
    next.delete('googleDrive');
    next.delete('reason');
    setParams(next, { replace: true });
    void queryClient.invalidateQueries({ queryKey: ['drive-status'] });
  }, [params, setParams, notify, queryClient]);

  const connect = useMutation({
    mutationFn: (forceConsent?: boolean) => googleDriveApi.connect(forceConsent),
    onSuccess: (result) => {
      /**
       * พาผู้ใช้ไปที่ Google ด้วยการเปลี่ยนหน้าเต็ม ไม่ใช่แท็บใหม่
       *
       * ขั้นตอนยินยอมของ Google จบด้วยการ redirect กลับมาที่ระบบเรา
       * ถ้าเปิดในแท็บใหม่ ผู้ใช้จะจบลงที่สองแท็บที่สถานะไม่ตรงกัน
       */
      window.location.href = result.data.url;
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'เริ่มการเชื่อมต่อไม่สำเร็จ') }),
  });

  const disconnect = useMutation({
    mutationFn: (connectionId: string) => googleDriveApi.disconnect(connectionId),
    onSuccess: (result) => {
      setConfirmDisconnect(false);
      void queryClient.invalidateQueries({ queryKey: ['drive-status'] });
      notify({
        tone: 'success',
        title: 'ยกเลิกการเชื่อมต่อแล้ว',
        description: `ไฟล์ ${result.data.preservedResources} รายการที่นำเข้ามาแล้วยังอยู่ครบใน S2 NAS`,
      });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'ยกเลิกการเชื่อมต่อไม่สำเร็จ') }),
  });

  const data = status.data?.data;
  const connection = data?.connection ?? null;
  const style = CONNECTION_STATUS[connection?.state ?? 'DISCONNECTED'];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
      <PageTitle
        title="การเชื่อมต่อภายนอก"
        description="เชื่อมบัญชีของคุณกับบริการภายนอกเพื่อนำเอกสารเข้าสู่ S2 NAS"
      />

      {status.isPending ? (
        <div className="flex justify-center py-16 text-navy-400">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
        </div>
      ) : (
        <section className="s2-surface p-5 shadow-subtle">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line bg-[var(--s2-surface-soft)] text-navy-500">
                <Plug className="h-5 w-5" aria-hidden />
              </span>
              <div className="min-w-0">
                <h2 className="text-[14px] font-semibold text-navy-900">Google Drive</h2>
                <p className="mt-0.5 text-[12.5px] text-navy-400">
                  นำเอกสารจาก Google Drive เข้ามาเก็บใน S2 NAS และเลือกได้ว่าจะซิงก์ต่อเนื่องหรือไม่
                </p>
              </div>
            </div>

            {/* ป้ายสถานะมีข้อความเสมอ ไม่พึ่งสีอย่างเดียว */}
            <span className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] ${style.className}`}>
              {style.label}
            </span>
          </div>

          {status.isError ? (
            <p className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-[12px] text-[var(--s2-danger-ring)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{message(status.error, 'โหลดสถานะการเชื่อมต่อไม่สำเร็จ')}</span>
            </p>
          ) : !data?.configured || !data.encryptionReady ? (
            <div className="mt-4">
              <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[12px] text-[var(--s2-warning-ring)]">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>
                  {!data?.configured
                    ? 'ผู้ดูแลระบบยังไม่ได้ตั้งค่า OAuth ของ Google Drive'
                    : 'ผู้ดูแลระบบยังไม่ได้ตั้งค่ากุญแจเข้ารหัสข้อมูลรับรอง จึงยังเชื่อมต่อไม่ได้'}
                </span>
              </p>
              <button
                type="button"
                disabled
                title="ผู้ดูแลระบบต้องตั้งค่า Google Drive ให้พร้อมก่อน"
                className="s2-btn s2-btn-primary mt-3 h-9 gap-1.5 text-[12.5px] opacity-50"
              >
                <Plug className="h-4 w-4" aria-hidden />
                เชื่อมต่อ Google Drive
              </button>
            </div>
          ) : connection ? (
            <>
              <dl className="mt-4 space-y-1.5 text-[12.5px]">
                <Row label="บัญชี Google" value={connection.googleAccountEmail} />
                <Row label="เชื่อมต่อเมื่อ" value={formatDateTime(connection.connectedAt)} />
                <Row
                  label="ซิงก์ล่าสุด"
                  value={
                    connection.lastSuccessfulSyncAt
                      ? formatDateTime(connection.lastSuccessfulSyncAt)
                      : 'ยังไม่เคยซิงก์'
                  }
                />
                <Row label="ไฟล์ที่ผูกไว้" value={`${connection.syncCount} รายการ`} />
              </dl>

              {/*
                การเชื่อมต่อที่ไม่มี refresh token ใช้ได้แค่ชั่วโมงเดียว
                ผู้ใช้ควรรู้ก่อนที่จะพบว่าไฟล์ไม่อัปเดตแล้วไม่รู้สาเหตุ
              */}
              {!connection.syncCapable ? (
                <p className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[12px] text-[var(--s2-warning-ring)]">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    การเชื่อมต่อนี้ยังซิงก์ต่อเนื่องไม่ได้ - กด "เชื่อมต่อใหม่"
                    แล้วอนุญาตอีกครั้งเพื่อให้ระบบเข้าถึงได้ต่อเนื่อง
                  </span>
                </p>
              ) : null}

              {style.needsAction ? (
                <p className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[12px] text-[var(--s2-warning-ring)]">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    การเชื่อมต่อใช้งานไม่ได้ในขณะนี้ - ไฟล์ที่นำเข้ามาแล้วยังอยู่ครบ
                    เพียงแต่จะไม่อัปเดตจนกว่าจะเชื่อมต่อใหม่
                  </span>
                </p>
              ) : null}

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setImporting(true)}
                  disabled={connection.state !== 'ACTIVE'}
                  className="s2-btn s2-btn-primary h-9 gap-1.5 text-[12.5px] disabled:opacity-50"
                >
                  <Link2 className="h-4 w-4" aria-hidden />
                  นำเข้าจาก Google Drive
                </button>

                <button
                  type="button"
                  onClick={() => connect.mutate(true)}
                  disabled={connect.isPending}
                  className="s2-btn s2-btn-outline h-9 gap-1.5 text-[12.5px]"
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  เชื่อมต่อใหม่
                </button>

                <button
                  type="button"
                  onClick={() => setConfirmDisconnect(true)}
                  className="s2-btn s2-btn-ghost h-9 gap-1.5 text-[12.5px] text-red-600"
                >
                  <Unlink className="h-4 w-4" aria-hidden />
                  ยกเลิกการเชื่อมต่อ
                </button>
              </div>
            </>
          ) : (
            <div className="mt-4">
              <p className="text-[12.5px] leading-relaxed text-navy-500">
                หลังเชื่อมต่อ คุณจะเลือกไฟล์และโฟลเดอร์จาก Google Drive
                มาเก็บใน S2 NAS ได้ ระบบขอสิทธิ์<strong>อ่านอย่างเดียว</strong> และ
                จะไม่แก้ไขหรือลบสิ่งใดใน Google Drive ของคุณ
              </p>
              <button
                type="button"
                onClick={() => connect.mutate(undefined)}
                disabled={connect.isPending}
                className="s2-btn s2-btn-primary mt-4 h-9 gap-1.5 text-[12.5px] disabled:opacity-60"
              >
                {connect.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Plug className="h-4 w-4" aria-hidden />
                )}
                เชื่อมต่อ Google Drive
              </button>
            </div>
          )}
        </section>
      )}

      {/* ---------- ยืนยันการตัดการเชื่อมต่อ ---------- */}
      {confirmDisconnect && connection ? (
        <div
          className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-3 backdrop-blur-sm"
          onMouseDown={() => setConfirmDisconnect(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="drive-disconnect-title"
            className="w-full max-w-md rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop"
            onMouseDown={(mouse) => mouse.stopPropagation()}
          >
            <h2 id="drive-disconnect-title" className="text-sm font-semibold text-navy-800">
              ยกเลิกการเชื่อมต่อ Google Drive
            </h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-navy-500">
              ไฟล์ {connection.syncCount} รายการที่นำเข้ามาแล้ว
              <strong> จะยังอยู่ครบใน S2 NAS พร้อมประวัติเวอร์ชันทั้งหมด</strong> เพียงแต่
              จะหยุดอัปเดตจากต้นทาง และระบบจะลบข้อมูลรับรองของบัญชี{' '}
              {connection.googleAccountEmail} ทิ้ง
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDisconnect(false)}
                className="s2-btn s2-btn-ghost h-9 text-[12.5px]"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={() => disconnect.mutate(connection.id)}
                disabled={disconnect.isPending}
                className="s2-btn h-9 gap-1.5 bg-red-600 text-[12.5px] text-white hover:bg-red-700 disabled:opacity-60"
              >
                {disconnect.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : null}
                ยกเลิกการเชื่อมต่อ
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {importing && connection ? (
        <DriveImportDialog syncCapable={connection.syncCapable} onClose={() => setImporting(false)} />
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-navy-400">{label}</dt>
      <dd className="min-w-0 break-words text-right text-navy-700">{value}</dd>
    </div>
  );
}
