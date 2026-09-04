import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, CloudUpload, Save, Trash2 } from 'lucide-react';
import { ApiError, backupApi } from '@/lib/api';
import { Panel, PanelBody, PanelHeader, Badge } from '@/components/ui/Panel';
import { ErrorState, TextSkeleton } from '@/components/ui/States';
import { useToast } from '@/hooks/useToast';
import { formatDateTime } from '@/lib/utils';
import {
  BACKUP_STATUS_LABEL,
  staleWarning,
  validateRetention,
  validateScheduleTime,
} from '@/lib/backup';

/**
 * ตารางเวลาและภาพรวมสุขภาพการสำรองข้อมูล
 *
 * แสดงเฉพาะข้อมูลจริงจากเซิร์ฟเวอร์ ไม่มีตัวเลขคาดเดาและไม่มีเปอร์เซ็นต์ปลอม
 * ไม่แสดงเส้นทางบนดิสก์ของชุดสำรองหรือของปลายทางนอกเครื่องเลย
 */
export function BackupSchedulePanel() {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [draft, setDraft] = useState<Record<string, string>>({});

  const schedule = useQuery({ queryKey: ['backup-schedule'], queryFn: backupApi.schedule, refetchInterval: 30_000 });
  const status = schedule.data?.data;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['backup-schedule'] });
    void queryClient.invalidateQueries({ queryKey: ['backups'] });
  };

  const onError = (error: unknown) =>
    notify({ tone: 'error', title: error instanceof ApiError ? error.message : 'บันทึกตารางเวลาไม่สำเร็จ' });

  const save = useMutation({
    mutationFn: (input: Record<string, number | boolean | string>) => backupApi.updateSchedule(input),
    onSuccess: () => {
      setDraft({});
      notify({ tone: 'success', title: 'บันทึกตารางเวลาแล้ว' });
      refresh();
    },
    onError,
  });

  const retention = useMutation({
    mutationFn: backupApi.runRetention,
    onSuccess: (response) => {
      const { deleted, keptForMinimum, failed } = response.data;
      notify({
        tone: failed > 0 ? 'error' : 'success',
        title: `ลบชุดสำรองเก่า ${deleted} ชุด`,
        description: `คงไว้ตามขั้นต่ำ ${keptForMinimum} · ล้มเหลว ${failed}`,
      });
      refresh();
    },
    onError,
  });

  if (schedule.isPending) {
    return (
      <Panel>
        <PanelHeader title="ตารางเวลา" description="สำรองข้อมูลอัตโนมัติ" />
        <PanelBody>
          <TextSkeleton lines={4} />
        </PanelBody>
      </Panel>
    );
  }

  if (schedule.isError || !status) {
    return (
      <Panel>
        <PanelHeader title="ตารางเวลา" description="สำรองข้อมูลอัตโนมัติ" />
        <PanelBody>
          <ErrorState message="อ่านตารางเวลาไม่สำเร็จ" onRetry={() => void schedule.refetch()} />
        </PanelBody>
      </Panel>
    );
  }

  const timeValue = draft.BACKUP_TIME ?? status.time;
  const daysValue = draft.BACKUP_RETENTION_DAYS ?? String(status.retentionDays);
  const keepValue = draft.BACKUP_MIN_KEEP_COUNT ?? String(status.minimumKeepCount);

  const timeError = validateScheduleTime(timeValue);
  const retentionError = validateRetention(Number(daysValue), Number(keepValue));
  const dirty = Object.keys(draft).length > 0;
  const warning = staleWarning(status);

  const submit = () => {
    if (timeError || retentionError) return;
    save.mutate({
      BACKUP_TIME: timeValue,
      BACKUP_RETENTION_DAYS: Number(daysValue),
      BACKUP_MIN_KEEP_COUNT: Number(keepValue),
    });
  };

  return (
    <Panel>
      <PanelHeader
        title="ตารางเวลา"
        description={`สำรองข้อมูลอัตโนมัติตามโซนเวลา ${status.timezone}`}
        action={
          <button
            type="button"
            className={status.enabled ? 's2-btn s2-btn-outline' : 's2-btn s2-btn-primary'}
            disabled={save.isPending}
            onClick={() => save.mutate({ BACKUP_ENABLED: !status.enabled })}
          >
            <CalendarClock className="h-4 w-4" aria-hidden />
            {status.enabled ? 'ปิดตารางเวลา' : 'เปิดตารางเวลา'}
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
              <Badge tone={status.enabled ? 'success' : 'neutral'}>
                {status.enabled ? 'เปิดใช้งาน' : 'ปิดอยู่'}
              </Badge>
            }
          />
          <Row label="Backup ถัดไป" value={status.nextRunAt ? formatDateTime(status.nextRunAt) : '—'} />
          <Row
            label="ล่าสุดสำรองข้อมูลเมื่อ"
            value={status.lastSuccessfulBackupAt ? formatDateTime(status.lastSuccessfulBackupAt) : 'ยังไม่เคย'}
          />
          <Row
            label="งานตามตารางล่าสุด"
            value={status.lastScheduledBackupStatus ? BACKUP_STATUS_LABEL[status.lastScheduledBackupStatus] : '—'}
          />
          <Row label="Backup ที่ตรวจสอบแล้ว" value={`${status.verifiedBackupCount} ชุด`} />
          <Row
            label="Backup นอกเครื่องล่าสุด"
            value={status.lastOffsiteVerifiedAt ? formatDateTime(status.lastOffsiteVerifiedAt) : '—'}
          />
        </dl>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Field
            id="backup-time"
            label="เวลาสำรองข้อมูล"
            hint="HH:mm 24 ชั่วโมง"
            error={draft.BACKUP_TIME === undefined ? null : timeError}
          >
            <input
              id="backup-time"
              type="time"
              value={timeValue}
              disabled={save.isPending}
              onChange={(event) => setDraft((current) => ({ ...current, BACKUP_TIME: event.target.value }))}
              className="s2-input h-9 w-full rounded-lg px-2.5 text-[13px]"
            />
          </Field>
          <Field
            id="backup-days"
            label="เก็บไว้ (วัน)"
            hint="ชุดที่เก่ากว่านี้จะถูกลบ"
            error={draft.BACKUP_RETENTION_DAYS === undefined ? null : retentionError}
          >
            <input
              id="backup-days"
              type="number"
              min={1}
              value={daysValue}
              disabled={save.isPending}
              onChange={(event) => setDraft((current) => ({ ...current, BACKUP_RETENTION_DAYS: event.target.value }))}
              className="s2-input h-9 w-full rounded-lg px-2.5 text-[13px]"
            />
          </Field>
          <Field id="backup-keep" label="เก็บอย่างน้อย (ชุด)" hint="ต้องเหลือไว้เสมอแม้เก่ากว่ากำหนด" error={null}>
            <input
              id="backup-keep"
              type="number"
              min={1}
              value={keepValue}
              disabled={save.isPending}
              onChange={(event) => setDraft((current) => ({ ...current, BACKUP_MIN_KEEP_COUNT: event.target.value }))}
              className="s2-input h-9 w-full rounded-lg px-2.5 text-[13px]"
            />
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="s2-btn s2-btn-primary"
            disabled={!dirty || timeError !== null || retentionError !== null || save.isPending}
            onClick={submit}
          >
            <Save className="h-4 w-4" aria-hidden />
            {save.isPending ? 'กำลังบันทึก…' : 'บันทึกตารางเวลา'}
          </button>
          <button
            type="button"
            className="s2-btn s2-btn-outline"
            disabled={retention.isPending}
            onClick={() => retention.mutate()}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            {retention.isPending ? 'กำลังเก็บกวาด…' : 'เก็บกวาดตามนโยบาย'}
          </button>
        </div>

        {/* ---------- สำเนานอกเครื่อง ---------- */}
        <div className="mt-5 border-t border-line pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-[12.5px] font-semibold text-navy-800">
              <CloudUpload className="h-4 w-4" aria-hidden />
              สำเนานอกเครื่อง
            </h3>
            <button
              type="button"
              className={status.offsiteEnabled ? 's2-btn s2-btn-outline' : 's2-btn s2-btn-primary'}
              disabled={save.isPending || !status.offsiteConfigured}
              title={status.offsiteConfigured ? undefined : 'ยังไม่ได้ตั้งค่าปลายทางนอกเครื่องที่เซิร์ฟเวอร์'}
              onClick={() => save.mutate({ OFFSITE_COPY_ENABLED: !status.offsiteEnabled })}
            >
              {status.offsiteEnabled ? 'ปิดสำเนานอกเครื่อง' : 'เปิดสำเนานอกเครื่อง'}
            </button>
          </div>

          <dl className="mt-2 divide-y divide-line text-[13px]">
            <Row
              label="ตั้งค่าปลายทางแล้ว"
              value={
                <Badge tone={status.offsiteConfigured ? 'success' : 'neutral'}>
                  {status.offsiteConfigured ? 'ใช่' : 'ยังไม่ได้ตั้งค่า'}
                </Badge>
              }
            />
            <Row
              label="เข้าถึงปลายทางได้"
              value={
                <Badge tone={status.offsiteReachable ? 'success' : 'danger'}>
                  {status.offsiteReachable ? 'ได้' : 'ไม่ได้'}
                </Badge>
              }
            />
          </dl>

          <p className="mt-2 text-[11px] leading-relaxed text-navy-400">
            ปลายทางนอกเครื่องตั้งค่าที่เซิร์ฟเวอร์ ไม่ใช่ที่หน้าจอนี้ และการลบสำเนาที่ปลายทางยังต้องทำด้วยตนเอง
          </p>
        </div>
      </PanelBody>
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
