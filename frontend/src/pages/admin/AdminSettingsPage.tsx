import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RotateCcw, Save } from 'lucide-react';
import { ApiError, api, systemSettingsApi } from '@/lib/api';
import { Panel, PanelBody, PanelHeader, Badge } from '@/components/ui/Panel';
import { ErrorState, TextSkeleton } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';
import { formatUptime } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/useToast';
import {
  SECTION_ORDER,
  SECTION_TITLE,
  SOURCE_LABEL,
  UNIT_LABEL,
  changedEntries,
  retentionWarning,
  validateSettingValue,
  type SettingView,
} from '@/lib/system-settings';

const MANAGE_PERMISSION = 'system:settings:manage';

/** ข้อมูลระบบจริงจาก backend พร้อมค่าตั้งค่าการทำงานที่แก้ได้ */
export default function AdminSettingsPage() {
  const { user } = useAuth();
  const canManage = Boolean(user?.permissions.includes(MANAGE_PERMISSION));

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['system-info'],
    queryFn: api.systemInfo,
    refetchInterval: 30_000,
    retry: 1,
  });

  const info = data?.data;

  return (
    <div className="space-y-4">
      <PageTitle title="ตั้งค่า" description="ข้อมูลระบบและค่าตั้งค่าของ S2 NAS" />

      <Panel>
        <PanelHeader
          title="ข้อมูลระบบ"
          description="สถานะปัจจุบันของเซิร์ฟเวอร์"
          action={<Badge tone="info">อ่านอย่างเดียว</Badge>}
        />
        <PanelBody>
          {isPending ? (
            <TextSkeleton lines={5} />
          ) : isError || !info ? (
            <ErrorState message="อ่านข้อมูลระบบไม่สำเร็จ" onRetry={() => void refetch()} />
          ) : (
            <dl className="divide-y divide-line text-[13px]">
              <Row label="ระบบ" value={`${info.service} · ${info.subtitle}`} />
              <Row label="เวอร์ชัน" value={info.version} />
              <Row label="Environment" value={info.environment} />
              <Row label="ฐานข้อมูล" value={info.database} />
              <Row label="ขนาดอัปโหลดสูงสุด" value={`${info.maxUploadSizeMb} MB`} />
              <Row label="Uptime" value={formatUptime(info.uptime)} />
            </dl>
          )}
        </PanelBody>
      </Panel>

      {canManage ? <OperationalSettings /> : <NoPermissionPanel />}
    </div>
  );
}

function NoPermissionPanel() {
  return (
    <Panel>
      <PanelHeader
        title="ค่าตั้งค่าระบบ"
        description="ปรับค่าการทำงานของ S2 NAS"
        action={<Badge tone="neutral">ไม่มีสิทธิ์</Badge>}
      />
      <PanelBody>
        <p className="text-[12.5px] leading-relaxed text-navy-400">
          การแก้ไขค่าตั้งค่าสงวนไว้สำหรับผู้ที่ได้รับสิทธิ์ จัดการค่าตั้งค่าการทำงานของระบบ
        </p>
      </PanelBody>
    </Panel>
  );
}

function OperationalSettings() {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<{ message: string; apply: () => void } | null>(null);

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['system-settings'],
    queryFn: systemSettingsApi.list,
  });

  const settings = data?.data ?? [];

  const afterWrite = (message: string) => {
    setDrafts({});
    setConfirming(null);
    notify({ tone: 'success', title: message });
    void queryClient.invalidateQueries({ queryKey: ['system-settings'] });
    void queryClient.invalidateQueries({ queryKey: ['system-info'] });
    void queryClient.invalidateQueries({ queryKey: ['managed-storage'] });
    void queryClient.invalidateQueries({ queryKey: ['trash'] });
  };

  const onError = (error: unknown) =>
    notify({
      tone: 'error',
      title: error instanceof ApiError ? error.message : 'บันทึกค่าตั้งค่าไม่สำเร็จ',
    });

  const save = useMutation({
    mutationFn: (values: Record<string, number>) => systemSettingsApi.update(values),
    onSuccess: () => afterWrite('บันทึกค่าตั้งค่าแล้ว'),
    onError,
  });

  const reset = useMutation({
    mutationFn: (key: string) => systemSettingsApi.reset(key),
    onSuccess: () => afterWrite('กลับไปใช้ค่าเริ่มต้นของระบบแล้ว'),
    onError,
  });

  const draftOf = (setting: SettingView) => drafts[setting.key] ?? String(setting.value);
  const errorOf = (setting: SettingView) =>
    drafts[setting.key] === undefined ? null : validateSettingValue(setting.key, drafts[setting.key]!);

  const pending = changedEntries(settings, drafts);
  const hasError = settings.some((setting) => errorOf(setting) !== null);

  const submit = () => {
    if (pending.length === 0 || hasError) return;
    const values = Object.fromEntries(pending.map((entry) => [entry.key, entry.value]));

    // ลดจำนวนวันของถังขยะทำให้เกิดการลบถาวรเร็วขึ้น ต้องยืนยันก่อนเสมอ
    const retention = settings.find((setting) => setting.key === 'TRASH_RETENTION_DAYS');
    const next = values.TRASH_RETENTION_DAYS;
    const warning = retention && typeof next === 'number' ? retentionWarning(retention.value, next) : null;

    if (warning) {
      setConfirming({ message: warning, apply: () => save.mutate(values) });
      return;
    }
    save.mutate(values);
  };

  return (
    <Panel>
      <PanelHeader
        title="ค่าตั้งค่าระบบ"
        description="ค่าเหล่านี้มีผลกับการทำงานจริงของเซิร์ฟเวอร์"
        action={
          <button
            type="button"
            className="s2-btn s2-btn-primary"
            disabled={pending.length === 0 || hasError || save.isPending}
            onClick={submit}
          >
            <Save className="h-4 w-4" aria-hidden />
            {save.isPending ? 'กำลังบันทึก…' : `บันทึก${pending.length > 0 ? ` (${pending.length})` : ''}`}
          </button>
        }
      />
      <PanelBody>
        {isPending ? (
          <TextSkeleton lines={6} />
        ) : isError ? (
          <ErrorState message="อ่านค่าตั้งค่าไม่สำเร็จ" onRetry={() => void refetch()} />
        ) : (
          <div className="space-y-6">
            {SECTION_ORDER.map((section) => {
              const rows = settings.filter((setting) => setting.section === section);
              if (rows.length === 0) return null;
              return (
                <section key={section}>
                  <h3 className="text-[12.5px] font-semibold text-navy-800">{SECTION_TITLE[section]}</h3>
                  <div className="mt-2 space-y-3">
                    {rows.map((setting) => (
                      <SettingRow
                        key={setting.key}
                        setting={setting}
                        draft={draftOf(setting)}
                        error={errorOf(setting)}
                        busy={save.isPending || reset.isPending}
                        onChange={(value) => setDrafts((current) => ({ ...current, [setting.key]: value }))}
                        onReset={() => reset.mutate(setting.key)}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </PanelBody>

      {confirming ? (
        <ConfirmDialog
          message={confirming.message}
          isPending={save.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={confirming.apply}
        />
      ) : null}
    </Panel>
  );
}

function SettingRow({
  setting,
  draft,
  error,
  busy,
  onChange,
  onReset,
}: {
  setting: SettingView;
  draft: string;
  error: string | null;
  busy: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  const inputId = `setting-${setting.key}`;
  const describedBy = `${inputId}-help`;

  return (
    <div className="rounded-xl border border-line bg-[var(--s2-surface-soft)] p-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={inputId} className="text-[12.5px] font-medium text-navy-800">
            {setting.label}
          </label>
          <p id={describedBy} className="mt-0.5 text-[11px] leading-relaxed text-navy-400">
            {setting.description}
          </p>
        </div>

        <Badge tone={setting.source === 'DATABASE' ? 'info' : 'neutral'}>{SOURCE_LABEL[setting.source]}</Badge>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          value={draft}
          disabled={busy}
          aria-describedby={describedBy}
          aria-invalid={error !== null}
          onChange={(event) => onChange(event.target.value)}
          className="s2-input h-9 w-40 rounded-lg px-2.5 text-[13px]"
        />
        <span className="text-[11.5px] text-navy-400">{UNIT_LABEL[setting.unit]}</span>

        {setting.source === 'DATABASE' ? (
          <button
            type="button"
            className="s2-btn s2-btn-outline ml-auto"
            disabled={busy}
            onClick={onReset}
            title={`กลับไปใช้ค่าจาก ${setting.envKey}`}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            ใช้ค่าเริ่มต้นของระบบ
          </button>
        ) : (
          <span className="ml-auto text-[11px] text-navy-400">
            ค่าเริ่มต้น {setting.defaultValue.toLocaleString('th-TH')} {UNIT_LABEL[setting.unit]}
          </span>
        )}
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-[11px] text-red-600">
          {error}
        </p>
      ) : null}

      {setting.restartNote ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          {setting.restartNote}
        </p>
      ) : null}
    </div>
  );
}

function ConfirmDialog({
  message,
  isPending,
  onCancel,
  onConfirm,
}: {
  message: string;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isPending) onCancel();
      }}
    >
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="setting-confirm-title"
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop"
      >
        <h2 id="setting-confirm-title" className="text-[16px] font-semibold text-navy-900">
          ยืนยันการเปลี่ยนค่าตั้งค่า
        </h2>
        <p className="mt-2 text-[12px] leading-relaxed text-navy-500">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="s2-btn s2-btn-ghost" disabled={isPending} onClick={onCancel}>
            ยกเลิก
          </button>
          <button type="button" className="s2-btn s2-btn-primary" disabled={isPending} onClick={onConfirm}>
            {isPending ? 'กำลังบันทึก…' : 'ยืนยันและบันทึก'}
          </button>
        </div>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-navy-400">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-navy-800">{value}</dd>
    </div>
  );
}
