import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FlaskConical, Save, ShieldCheck } from 'lucide-react';
import { ApiError, backupApi } from '@/lib/api';
import { Panel, PanelBody, PanelHeader, Badge } from '@/components/ui/Panel';
import { ErrorState, TextSkeleton } from '@/components/ui/States';
import { useToast } from '@/hooks/useToast';
import { formatDateTime } from '@/lib/utils';
import {
  REHEARSAL_STATUS_LABEL,
  REHEARSAL_STATUS_TONE,
  WEEKDAY_LABEL,
  rehearsalStaleWarning,
  validateRehearsalDay,
  validateScheduleTime,
} from '@/lib/backup';

/**
 * การทดสอบกู้คืน
 *
 * ชุดสำรองที่ไม่เคยกู้คืนสำเร็จ ยังพิสูจน์ไม่ได้ว่าใช้ได้จริง หน้านี้จึงแสดงผลการซ้อมจริงเท่านั้น
 * ทุกการทดสอบทำในพื้นที่พัก และไม่มีปุ่มใดที่นำข้อมูลขึ้นใช้งานจริง
 */
export function RestoreRehearsalPanel() {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);

  const schedule = useQuery({ queryKey: ['rehearsal-schedule'], queryFn: backupApi.rehearsal, refetchInterval: 30_000 });
  const history = useQuery({ queryKey: ['rehearsals'], queryFn: backupApi.rehearsals });
  const status = schedule.data?.data;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['rehearsal-schedule'] });
    void queryClient.invalidateQueries({ queryKey: ['rehearsals'] });
  };

  const onError = (error: unknown) =>
    notify({ tone: 'error', title: error instanceof ApiError ? error.message : 'ดำเนินการไม่สำเร็จ' });

  const save = useMutation({
    mutationFn: (input: Record<string, number | boolean | string>) => backupApi.updateRehearsal(input),
    onSuccess: () => {
      setDraft({});
      notify({ tone: 'success', title: 'บันทึกตารางทดสอบกู้คืนแล้ว' });
      refresh();
    },
    onError,
  });

  const run = useMutation({
    mutationFn: backupApi.runRehearsal,
    onSuccess: (response) => {
      setConfirming(false);
      const result = response.data;
      if (!result) {
        notify({ tone: 'info', title: 'ไม่มีชุดสำรองที่ต้องทดสอบในรอบนี้' });
      } else {
        notify({
          tone: result.status === 'PASSED' ? 'success' : 'error',
          title: result.status === 'PASSED' ? 'ทดสอบกู้คืนผ่าน' : 'ทดสอบกู้คืนไม่ผ่าน',
          description: result.errorMessage ?? undefined,
        });
      }
      refresh();
    },
    onError: (error: unknown) => {
      setConfirming(false);
      onError(error);
    },
  });

  if (schedule.isPending) {
    return (
      <Panel>
        <PanelHeader title="การทดสอบกู้คืน" description="พิสูจน์ว่าชุดสำรองยังกู้คืนได้จริง" />
        <PanelBody>
          <TextSkeleton lines={4} />
        </PanelBody>
      </Panel>
    );
  }

  if (schedule.isError || !status) {
    return (
      <Panel>
        <PanelHeader title="การทดสอบกู้คืน" description="พิสูจน์ว่าชุดสำรองยังกู้คืนได้จริง" />
        <PanelBody>
          <ErrorState message="อ่านสถานะการทดสอบกู้คืนไม่สำเร็จ" onRetry={() => void schedule.refetch()} />
        </PanelBody>
      </Panel>
    );
  }

  const timeValue = draft.RESTORE_REHEARSAL_TIME ?? status.time;
  const dayValue = draft.RESTORE_REHEARSAL_DAY ?? String(status.dayOfWeek);

  const timeError = validateScheduleTime(timeValue);
  const dayError = validateRehearsalDay(Number(dayValue));
  const dirty = Object.keys(draft).length > 0;
  const warning = rehearsalStaleWarning(status);
  const rows = history.data?.data ?? [];

  return (
    <Panel>
      <PanelHeader
        title="การทดสอบกู้คืน"
        description="กู้คืนลงพื้นที่พักเพื่อพิสูจน์ว่าชุดสำรองยังใช้ได้ ไม่แตะระบบที่ใช้งานอยู่"
        action={
          <button
            type="button"
            className={status.enabled ? 's2-btn s2-btn-outline' : 's2-btn s2-btn-primary'}
            disabled={save.isPending}
            onClick={() => save.mutate({ RESTORE_REHEARSAL_ENABLED: !status.enabled })}
          >
            <FlaskConical className="h-4 w-4" aria-hidden />
            {status.enabled ? 'ปิดการทดสอบอัตโนมัติ' : 'เปิดการทดสอบอัตโนมัติ'}
          </button>
        }
      />
      <PanelBody>
        {warning ? (
          <p
            role="status"
            className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-700"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {warning}
          </p>
        ) : null}

        <dl className="divide-y divide-line text-[13px]">
          <Row
            label="สถานะ"
            value={
              <Badge tone={status.enabled ? 'success' : 'neutral'}>{status.enabled ? 'เปิดใช้งาน' : 'ปิดอยู่'}</Badge>
            }
          />
          <Row label="ทดสอบทุกวัน" value={`${WEEKDAY_LABEL[status.dayOfWeek] ?? '—'} ${status.time} (${status.timezone})`} />
          <Row label="ครั้งถัดไป" value={status.nextRunAt ? formatDateTime(status.nextRunAt) : '—'} />
          <Row label="ครั้งล่าสุด" value={status.lastRehearsalAt ? formatDateTime(status.lastRehearsalAt) : 'ยังไม่เคย'} />
          <Row
            label="ผลล่าสุด"
            value={
              status.lastRehearsalStatus ? (
                <Badge tone={REHEARSAL_STATUS_TONE[status.lastRehearsalStatus]}>
                  {REHEARSAL_STATUS_LABEL[status.lastRehearsalStatus]}
                </Badge>
              ) : (
                '—'
              )
            }
          />
          <Row label="ทดสอบสำเร็จล่าสุด" value={status.lastPassedAt ? formatDateTime(status.lastPassedAt) : 'ยังไม่เคย'} />
        </dl>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field id="rehearsal-day" label="วันที่ทดสอบ" hint="เลือกวันในสัปดาห์" error={draft.RESTORE_REHEARSAL_DAY === undefined ? null : dayError}>
            <select
              id="rehearsal-day"
              value={dayValue}
              disabled={save.isPending}
              onChange={(event) => setDraft((current) => ({ ...current, RESTORE_REHEARSAL_DAY: event.target.value }))}
              className="s2-input h-9 w-full rounded-lg px-2.5 text-[13px]"
            >
              {WEEKDAY_LABEL.map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            id="rehearsal-time"
            label="เวลาที่ทดสอบ"
            hint="ควรห่างจากเวลาสำรองข้อมูล"
            error={draft.RESTORE_REHEARSAL_TIME === undefined ? null : timeError}
          >
            <input
              id="rehearsal-time"
              type="time"
              value={timeValue}
              disabled={save.isPending}
              onChange={(event) => setDraft((current) => ({ ...current, RESTORE_REHEARSAL_TIME: event.target.value }))}
              className="s2-input h-9 w-full rounded-lg px-2.5 text-[13px]"
            />
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="s2-btn s2-btn-primary"
            disabled={!dirty || timeError !== null || dayError !== null || save.isPending}
            onClick={() =>
              save.mutate({ RESTORE_REHEARSAL_TIME: timeValue, RESTORE_REHEARSAL_DAY: Number(dayValue) })
            }
          >
            <Save className="h-4 w-4" aria-hidden />
            {save.isPending ? 'กำลังบันทึก…' : 'บันทึกตารางทดสอบ'}
          </button>
          <button
            type="button"
            className="s2-btn s2-btn-outline"
            disabled={run.isPending}
            onClick={() => setConfirming(true)}
          >
            <ShieldCheck className="h-4 w-4" aria-hidden />
            {run.isPending ? 'กำลังทดสอบ…' : 'ทดสอบการกู้คืนตอนนี้'}
          </button>
        </div>

        {rows.length > 0 ? (
          <div className="mt-5 border-t border-line pt-4">
            <h3 className="text-[12.5px] font-semibold text-navy-800">ผลการทดสอบล่าสุด</h3>
            <ul className="mt-2 space-y-1.5">
              {rows.slice(0, 5).map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-2 text-[11.5px] text-navy-500">
                  <Badge tone={REHEARSAL_STATUS_TONE[row.status]}>{REHEARSAL_STATUS_LABEL[row.status]}</Badge>
                  <span>
                    ทรัพยากร {row.resourceCount ?? '—'} · เวอร์ชัน {row.versionCount ?? '—'} · ไฟล์หาย{' '}
                    {row.missingCount ?? '—'} · checksum ไม่ตรง {row.checksumFailures ?? '—'}
                  </span>
                  {row.cleanupFailed ? <span className="text-amber-700">ไม่สามารถล้างพื้นที่ staging ได้</span> : null}
                  {row.errorMessage ? <span className="text-red-600">{row.errorMessage}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </PanelBody>

      {confirming ? (
        <div
          className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-4 backdrop-blur-sm"
          role="presentation"
        >
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="rehearsal-confirm-title"
            className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop"
          >
            <h2 id="rehearsal-confirm-title" className="text-[16px] font-semibold text-navy-900">
              ทดสอบการกู้คืนตอนนี้
            </h2>
            <p className="mt-2 text-[12px] leading-relaxed text-navy-500">
              ระบบจะกู้คืนชุดสำรองล่าสุดลงฐานข้อมูลและโฟลเดอร์ชั่วคราวเพื่อตรวจสอบ
              แล้วล้างทิ้งเมื่อเสร็จ ระบบที่ใช้งานอยู่จะไม่ถูกเปลี่ยนแปลง
              การทดสอบใช้ทรัพยากรมากและจะไม่ทำงานพร้อมกับการสำรองข้อมูล
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="s2-btn s2-btn-ghost"
                disabled={run.isPending}
                onClick={() => setConfirming(false)}
              >
                ยกเลิก
              </button>
              <button type="button" className="s2-btn s2-btn-primary" disabled={run.isPending} onClick={() => run.mutate()}>
                {run.isPending ? 'กำลังทดสอบ…' : 'เริ่มทดสอบ'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </Panel>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="text-[11.5px] font-semibold text-navy-700">
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {error ? (
        <p role="alert" className="mt-1 text-[11px] text-red-600">
          {error}
        </p>
      ) : (
        <p className="mt-1 text-[10.5px] text-navy-400">{hint}</p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-navy-400">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-navy-800">{value}</dd>
    </div>
  );
}
