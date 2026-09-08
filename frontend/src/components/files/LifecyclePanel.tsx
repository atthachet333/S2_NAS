import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { ApiError, archiveApi, legalHoldApi, retentionApi } from '@/lib/api';
import { lifecycleInvalidationKeys } from '@/lib/lifecycle-invalidation';
import type { DriveEntry } from '@/lib/drive';
import { LIFECYCLE_LABELS, retentionBadge, thaiDate } from '@/lib/lifecycle';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/useToast';

/**
 * แผงวงจรชีวิตเอกสารในแผงรายละเอียด
 *
 * ตั้งใจให้กะทัดรัด - แผงรายละเอียดมีเรื่องต้องบอกอยู่แล้วหลายอย่าง
 * ส่วนนี้จึงแสดงเฉพาะสิ่งที่เปลี่ยนการตัดสินใจของผู้ใช้: เอกสารนี้ลบได้ไหม
 * และเก็บถึงเมื่อไร
 */

const ERROR_TEXT: Record<string, string> = {
  RETENTION_DENIED: 'คุณไม่มีสิทธิ์จัดการนโยบายการเก็บรักษา',
  LEGAL_HOLD_DENIED: 'คุณไม่มีสิทธิ์จัดการการระงับการลบ',
  LEGAL_HOLD_ALREADY_ACTIVE: 'เอกสารนี้ถูกระงับการลบอยู่แล้ว',
  LEGAL_HOLD_REASON_REQUIRED: 'กรุณาระบุเหตุผลของการระงับ',
  RESOURCE_ALREADY_ARCHIVED: 'เอกสารนี้อยู่ในคลังอยู่แล้ว',
  RESOURCE_NOT_ARCHIVED: 'เอกสารนี้ไม่ได้อยู่ในคลัง',
  RESOURCE_ACCESS_DENIED: 'คุณไม่มีสิทธิ์ดำเนินการนี้',
  RETENTION_POLICY_INACTIVE: 'นโยบายนี้ถูกปิดการใช้งานอยู่',
};

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? (ERROR_TEXT[error.code] ?? error.message ?? fallback) : fallback;

const TONE_CLASS: Record<string, string> = {
  hold: 'border-rose-200 bg-rose-50 text-rose-700',
  forever: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  active: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  expired: 'border-amber-200 bg-amber-50 text-amber-800',
};

export function LifecyclePanel({ entry }: { entry: DriveEntry }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const { user } = useAuth();
  const [holdOpen, setHoldOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [caseRef, setCaseRef] = useState('');

  /** ผู้ที่จัดการการกำกับดูแลได้ - ผู้แก้ไขเอกสารทั่วไปทำไม่ได้ */
  const canGovern =
    user?.roles.includes('SUPER_ADMIN') ||
    user?.roles.includes('ADMIN') ||
    user?.permissions.includes('system:retention:manage') ||
    false;

  const policies = useQuery({
    queryKey: ['retention-policies'],
    queryFn: () => retentionApi.list(),
    staleTime: 5 * 60_000,
  });

  const holds = useQuery({
    queryKey: ['legal-holds', entry.id],
    queryFn: () => legalHoldApi.forResource(entry.id),
    enabled: entry.onLegalHold === true || canGovern,
  });

  const activeHold = holds.data?.data.find((hold) => hold.isActive) ?? null;

  const refresh = () => {
    for (const queryKey of lifecycleInvalidationKeys(entry.id)) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };

  const assign = useMutation({
    mutationFn: (policyId: string | null) => retentionApi.assign(entry.id, { policyId }),
    onSuccess: () => {
      refresh();
      notify({ tone: 'success', title: 'บันทึกนโยบายการเก็บรักษาแล้ว' });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'บันทึกไม่สำเร็จ') }),
  });

  const archive = useMutation({
    mutationFn: () =>
      entry.lifecycleState === 'ARCHIVED' ? archiveApi.unarchive(entry.id) : archiveApi.archive(entry.id),
    onSuccess: () => {
      refresh();
      notify({
        tone: 'success',
        title: entry.lifecycleState === 'ARCHIVED' ? 'นำออกจากคลังแล้ว' : 'เก็บเข้าคลังแล้ว',
      });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'ดำเนินการไม่สำเร็จ') }),
  });

  const placeHold = useMutation({
    mutationFn: () =>
      legalHoldApi.place(entry.id, { reason: reason.trim(), caseReference: caseRef.trim() || null }),
    onSuccess: () => {
      setHoldOpen(false);
      setReason('');
      setCaseRef('');
      refresh();
      notify({ tone: 'success', title: 'ระงับการลบเอกสารนี้แล้ว' });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'ระงับไม่สำเร็จ') }),
  });

  const releaseHold = useMutation({
    mutationFn: () => legalHoldApi.release(activeHold!.id),
    onSuccess: () => {
      refresh();
      notify({ tone: 'success', title: 'ยกเลิกการระงับแล้ว' });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'ยกเลิกไม่สำเร็จ') }),
  });

  const badge = retentionBadge({
    retentionUntil: entry.retentionUntil,
    retentionForever: entry.retentionForever,
    onLegalHold: entry.onLegalHold,
  });

  return (
    <div className="rounded-xl border border-line bg-[var(--s2-surface-soft)] px-3 py-2.5">
      <p className="text-[11.5px] font-semibold text-navy-700">สถานะเอกสาร</p>

      <dl className="mt-1.5 space-y-1 text-[11.5px]">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-navy-400">วงจรชีวิต</dt>
          <dd className="text-navy-700">
            {LIFECYCLE_LABELS[entry.lifecycleState ?? 'ACTIVE'] ?? 'ใช้งานอยู่'}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-navy-400">นโยบายการเก็บรักษา</dt>
          <dd className="truncate text-navy-700">{entry.retentionPolicy?.name ?? 'ยังไม่กำหนด'}</dd>
        </div>
        {entry.retentionUntil && !entry.retentionForever ? (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-navy-400">เก็บถึง</dt>
            <dd className="text-navy-700">{thaiDate(entry.retentionUntil)}</dd>
          </div>
        ) : null}
      </dl>

      {/*
        * ป้ายสถานะใช้ทั้งสีและข้อความ ไม่พึ่งสีอย่างเดียว
        * ผู้ใช้ที่แยกสีไม่ได้ต้องรู้ว่าเอกสารถูกระงับการลบอยู่เช่นกัน
        */}
      {badge ? (
        <p
          className={`mt-2 inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium ${
            TONE_CLASS[badge.tone]
          }`}
        >
          {badge.tone === 'hold' ? (
            <ShieldAlert className="h-3 w-3" aria-hidden />
          ) : (
            <ShieldCheck className="h-3 w-3" aria-hidden />
          )}
          {badge.label}
        </p>
      ) : null}

      {/* ---- กำหนดนโยบาย ---- */}
      {entry.capabilities?.canEdit ? (
        <label className="mt-2.5 block">
          <span className="text-[10.5px] text-navy-400">นโยบายการเก็บรักษา</span>
          <select
            value={entry.retentionPolicy?.id ?? ''}
            onChange={(event) => assign.mutate(event.target.value || null)}
            disabled={assign.isPending}
            className="s2-input mt-0.5 h-8 w-full text-[12px]"
          >
            <option value="">— ไม่กำหนด —</option>
            {(policies.data?.data ?? []).map((policy) => (
              <option key={policy.id} value={policy.id}>
                {policy.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {/* ---- การกระทำ ---- */}
      <div className="mt-2 flex flex-col gap-1.5">
        {entry.capabilities?.canEdit ? (
          <button
            type="button"
            onClick={() => archive.mutate()}
            disabled={archive.isPending}
            className="s2-btn s2-btn-outline h-8 w-full gap-1.5 text-[12px] disabled:opacity-60"
          >
            {archive.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : entry.lifecycleState === 'ARCHIVED' ? (
              <ArchiveRestore className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Archive className="h-3.5 w-3.5" aria-hidden />
            )}
            {entry.lifecycleState === 'ARCHIVED' ? 'นำออกจากคลัง' : 'เก็บเข้าคลัง'}
          </button>
        ) : null}

        {canGovern ? (
          activeHold ? (
            <button
              type="button"
              onClick={() => releaseHold.mutate()}
              disabled={releaseHold.isPending}
              className="s2-btn s2-btn-outline h-8 w-full gap-1.5 text-[12px] disabled:opacity-60"
            >
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
              ยกเลิก Legal Hold
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setHoldOpen((open) => !open)}
              aria-expanded={holdOpen}
              className="s2-btn s2-btn-outline h-8 w-full gap-1.5 text-[12px]"
            >
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
              วาง Legal Hold
            </button>
          )
        ) : null}
      </div>

      {/* เหตุผลของการระงับที่ยังมีผล - เห็นเฉพาะผู้ที่จัดการได้ */}
      {activeHold?.reason ? (
        <p className="mt-2 rounded-lg bg-rose-50 px-2 py-1 text-[10.5px] leading-relaxed text-rose-800">
          เหตุผล: {activeHold.reason}
          {activeHold.caseReference ? ` · อ้างอิง ${activeHold.caseReference}` : ''}
        </p>
      ) : null}

      {holdOpen && canGovern ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim()) placeHold.mutate();
          }}
          className="mt-2 space-y-1.5 rounded-lg border border-line bg-surface p-2"
        >
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="เหตุผล เช่น ตรวจสอบภาษีปี 2569"
            maxLength={500}
            aria-label="เหตุผลของการระงับการลบ"
            className="s2-input h-8 w-full text-[12px]"
          />
          <input
            value={caseRef}
            onChange={(event) => setCaseRef(event.target.value)}
            placeholder="เลขอ้างอิง (ถ้ามี)"
            maxLength={191}
            aria-label="เลขอ้างอิง"
            className="s2-input h-8 w-full text-[12px]"
          />
          <button
            type="submit"
            disabled={!reason.trim() || placeHold.isPending}
            className="s2-btn s2-btn-primary h-8 w-full text-[12px] disabled:opacity-60"
          >
            ยืนยันการระงับ
          </button>
        </form>
      ) : null}
    </div>
  );
}
