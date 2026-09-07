import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Link2, Loader2, Lock, ShieldAlert, Trash2 } from 'lucide-react';
import { PageTitle } from '@/components/ui/PageTitle';
import { EmptyState } from '@/components/ui/States';
import { OwnerIdentity } from '@/components/files/OwnerIdentity';
import { ApiError, publicShareApi, type AdminShareRow } from '@/lib/api';
import { SHARE_STATUS, shareExpiryText } from '@/lib/public-share';
import { formatDateTime } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';

/**
 * ภาพรวมลิงก์แชร์ภายนอกทั้งระบบ (F18)
 *
 * ตอบคำถามที่ไม่มีใครตอบได้ถ้าต้องไล่เปิดดูทีละเอกสาร:
 * ตอนนี้มีประตูกี่บานที่เปิดสู่ภายนอก บานไหนดาวน์โหลดไฟล์ได้ และบานไหนใกล้ปิดเอง
 *
 * **ไม่มีที่ใดในหน้านี้แสดงตัวลิงก์** เพราะเซิร์ฟเวอร์ไม่มีให้แสดง - เก็บแต่แฮชไว้
 * ผู้ดูแลระบบจึงเห็นว่าประตูเปิดอยู่ และปิดได้ แต่เดินเข้าไปเองไม่ได้
 */

const ERROR_TEXT: Record<string, string> = {
  PUBLIC_SHARE_ADMIN_DENIED: 'คุณไม่มีสิทธิ์ดูภาพรวมลิงก์แชร์ภายนอก',
  PUBLIC_SHARE_DENIED: 'คุณไม่มีสิทธิ์ยกเลิกลิงก์นี้',
};

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? (ERROR_TEXT[error.code] ?? error.message ?? fallback) : fallback;

const STATUS_FILTERS = [
  { value: '', label: 'ทั้งหมด' },
  { value: 'ACTIVE', label: 'ใช้งานอยู่' },
  { value: 'EXPIRING_SOON', label: 'หมดอายุภายใน 7 วัน' },
  { value: 'EXPIRED', label: 'หมดอายุแล้ว' },
  { value: 'REVOKED', label: 'ยกเลิกแล้ว' },
] as const;

export default function AdminPublicSharesPage() {
  const [params, setParams] = useSearchParams();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [pages, setPages] = useState<string[]>([]);

  const cursor = pages[pages.length - 1];
  const query = new URLSearchParams(params);
  query.set('limit', '50');
  if (cursor) query.set('cursor', cursor);

  const summary = useQuery({
    queryKey: ['admin-shares-summary'],
    queryFn: publicShareApi.adminSummary,
    retry: false,
  });

  const list = useQuery({
    queryKey: ['admin-shares', query.toString()],
    queryFn: () => publicShareApi.adminList(query),
    retry: false,
  });

  const revoke = useMutation({
    mutationFn: (id: string) => publicShareApi.revoke(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-shares'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-shares-summary'] });
      notify({ tone: 'success', title: 'ยกเลิกลิงก์แล้ว' });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'ยกเลิกลิงก์ไม่สำเร็จ') }),
  });

  const setFilter = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    setPages([]);
  };

  if (list.isError && list.error instanceof ApiError && list.error.status === 403) {
    return (
      <div className="space-y-4">
        <PageTitle title="ลิงก์แชร์ภายนอก" description="ภาพรวมลิงก์ที่เปิดให้คนนอกองค์กรเข้าถึงเอกสาร" />
        <EmptyState
          icon={<ShieldAlert className="h-6 w-6" aria-hidden />}
          title="คุณไม่มีสิทธิ์ดูภาพรวมลิงก์แชร์ภายนอก"
          description="รายการนี้ครอบคลุมทั้งองค์กร จึงจำกัดไว้เฉพาะผู้ดูแลระบบ"
        />
      </div>
    );
  }

  const rows = list.data?.data.items ?? [];
  const counts = summary.data?.data;

  return (
    <div className="space-y-4">
      <PageTitle
        title="ลิงก์แชร์ภายนอก"
        description="ภาพรวมลิงก์ที่เปิดให้คนนอกองค์กรเข้าถึงเอกสาร"
      />

      {/*
        ตัวเลขสรุปสั้น ๆ ไม่ใช่แดชบอร์ด - สิ่งที่ผู้ดูแลต้องเห็นทันทีคือ
        "เปิดอยู่กี่บาน" และ "กี่บานที่ดาวน์โหลดไฟล์ออกไปได้"
      */}
      {counts ? (
        <div className="flex flex-wrap gap-2 text-[12px]">
          <Stat label="ใช้งานอยู่" value={counts.active} />
          <Stat label="ดาวน์โหลดได้" value={counts.downloadable} tone="warning" />
          <Stat label="มีรหัสผ่าน" value={counts.passwordProtected} />
          <Stat label="หมดอายุใน 7 วัน" value={counts.expiringSoon} />
          <Stat label="หมดอายุแล้ว" value={counts.expired} />
          <Stat label="ยกเลิกแล้ว" value={counts.revoked} />
        </div>
      ) : null}

      {/* ---------- ตัวกรอง ---------- */}
      <div className="grid grid-cols-1 gap-2.5 rounded-xl border border-line bg-[var(--s2-surface-soft)] p-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-navy-500">สถานะ</span>
          <select
            value={params.get('status') ?? ''}
            onChange={(event) => setFilter('status', event.target.value || null)}
            className="s2-input h-8 text-[12px]"
          >
            {STATUS_FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-end gap-2 text-[12px] text-navy-600">
          <input
            type="checkbox"
            checked={params.get('allowDownload') === 'true'}
            onChange={(event) => setFilter('allowDownload', event.target.checked ? 'true' : null)}
            className="mb-2 h-3.5 w-3.5 rounded border-line"
          />
          <span className="mb-1.5">เฉพาะที่ดาวน์โหลดได้</span>
        </label>

        <label className="flex items-end gap-2 text-[12px] text-navy-600">
          <input
            type="checkbox"
            checked={params.get('passwordProtected') === 'true'}
            onChange={(event) =>
              setFilter('passwordProtected', event.target.checked ? 'true' : null)
            }
            className="mb-2 h-3.5 w-3.5 rounded border-line"
          />
          <span className="mb-1.5">เฉพาะที่มีรหัสผ่าน</span>
        </label>

        {params.toString() ? (
          <button
            type="button"
            onClick={() => {
              setParams(new URLSearchParams(), { replace: true });
              setPages([]);
            }}
            className="self-end text-left text-[11.5px] text-navy-400 underline-offset-2 hover:underline sm:text-center"
          >
            ล้างตัวกรอง
          </button>
        ) : null}
      </div>

      {/* ---------- รายการ ---------- */}
      {list.isPending ? (
        <div className="flex justify-center py-16 text-navy-400">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
        </div>
      ) : list.isError ? (
        <EmptyState
          icon={<ShieldAlert className="h-6 w-6" aria-hidden />}
          title={message(list.error, 'โหลดรายการไม่สำเร็จ')}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Link2 className="h-6 w-6" aria-hidden />}
          title="ไม่พบลิงก์แชร์ที่ตรงกับตัวกรองนี้"
          description="ลองล้างตัวกรอง หรือเลือกสถานะอื่น"
        />
      ) : (
        <>
          {/* จอแคบเป็นการ์ดเรียงลง จอกว้างเป็นตาราง - ไม่มีตารางที่ล้นออกนอกจอ */}
          <ul className="overflow-hidden rounded-xl border border-line">
            <li className="hidden gap-3 border-b border-line bg-[var(--s2-surface-soft)] px-3 py-2 text-[11px] font-medium text-navy-500 lg:grid lg:grid-cols-[minmax(0,1fr)_150px_120px_130px_110px_40px]">
              <span>เอกสาร</span>
              <span>ผู้สร้าง</span>
              <span>สิทธิ์</span>
              <span>หมดอายุ</span>
              <span>การใช้งาน</span>
              <span className="sr-only">จัดการ</span>
            </li>

            {rows.map((row) => (
              <li key={row.id} className="border-b border-line last:border-0">
                <ShareRow
                  row={row}
                  onRevoke={() => revoke.mutate(row.id)}
                  revoking={revoke.isPending && revoke.variables === row.id}
                />
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={pages.length === 0}
              onClick={() => setPages((list) => list.slice(0, -1))}
              className="s2-btn s2-btn-ghost h-8 text-[12px] disabled:opacity-40"
            >
              ก่อนหน้า
            </button>
            <span className="text-[11.5px] text-navy-400">แสดง {rows.length} ลิงก์</span>
            <button
              type="button"
              disabled={!list.data?.data.nextCursor}
              onClick={() => setPages((current) => [...current, list.data!.data.nextCursor!])}
              className="s2-btn s2-btn-ghost h-8 text-[12px] disabled:opacity-40"
            >
              ถัดไป
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'warning';
}) {
  return (
    <span
      className={`rounded-lg border px-2.5 py-1 ${
        tone === 'warning' && value > 0
          ? 'border-amber-200 bg-amber-50 text-[var(--s2-warning-ring)]'
          : 'border-line bg-[var(--s2-surface-soft)] text-navy-600'
      }`}
    >
      {label} <span className="font-semibold">{value}</span>
    </span>
  );
}

function ShareRow({
  row,
  onRevoke,
  revoking,
}: {
  row: AdminShareRow;
  onRevoke: () => void;
  revoking: boolean;
}) {
  const status = SHARE_STATUS[row.status];

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5 lg:grid lg:grid-cols-[minmax(0,1fr)_150px_120px_130px_110px_40px] lg:items-center lg:gap-3">
      <div className="min-w-0">
        <p className="truncate text-[12.5px] text-navy-800">{row.resourceName}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {/* ป้ายสถานะมีข้อความเสมอ ไม่พึ่งสีอย่างเดียว */}
          <span className={`rounded-md border px-1.5 py-0.5 text-[10.5px] ${status.className}`}>
            {status.label}
          </span>
          {row.label ? <span className="truncate text-[10.5px] text-navy-400">{row.label}</span> : null}
        </div>
      </div>

      <div className="min-w-0 text-[11.5px] text-navy-600">
        <OwnerIdentity owner={row.createdBy} caption={row.createdBy.email} size="sm" />
      </div>

      <div className="flex flex-wrap items-center gap-1 text-[11px] text-navy-500">
        {row.allowDownload ? (
          <span className="inline-flex items-center gap-1">
            <Download className="h-3 w-3" aria-hidden />
            ดาวน์โหลดได้
          </span>
        ) : (
          <span>ดูได้อย่างเดียว</span>
        )}
        {row.passwordProtected ? (
          <span className="inline-flex items-center gap-1">
            <Lock className="h-3 w-3" aria-hidden />
            รหัสผ่าน
          </span>
        ) : null}
      </div>

      <span className="text-[11.5px] text-navy-500" title={formatDateTime(row.createdAt)}>
        {shareExpiryText(row.expiresAt)}
      </span>

      <span className="text-[11px] text-navy-400">
        เปิด {row.viewCount}
        {row.maxViews === null ? '' : `/${row.maxViews}`} · โหลด {row.downloadCount}
        {row.maxDownloads === null ? '' : `/${row.maxDownloads}`}
      </span>

      <span className="lg:justify-self-end">
        {row.status !== 'REVOKED' ? (
          <button
            type="button"
            onClick={onRevoke}
            disabled={revoking}
            aria-label={`ยกเลิกลิงก์ของ ${row.resourceName}`}
            className="s2-btn s2-btn-ghost h-8 w-8 p-0 text-red-600 disabled:opacity-50"
          >
            {revoking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            )}
          </button>
        ) : null}
      </span>
    </div>
  );
}
