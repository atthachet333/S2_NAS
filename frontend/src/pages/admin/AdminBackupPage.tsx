import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Database, Loader2, Play, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { ApiError, backupApi } from '@/lib/api';
import { Panel, PanelBody, PanelHeader, Badge } from '@/components/ui/Panel';
import { EmptyState, ErrorState, TextSkeleton } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';
import { useAuth } from '@/hooks/useAuth';
import { BackupSchedulePanel } from '@/components/admin/BackupSchedulePanel';
import { RestoreRehearsalPanel } from '@/components/admin/RestoreRehearsalPanel';
import { useToast } from '@/hooks/useToast';
import { formatDateTime, formatRelativeTime } from '@/lib/utils';
import {
  BACKUP_STATUS_LABEL,
  BACKUP_STATUS_TONE,
  OFFSITE_STATE_LABEL,
  OFFSITE_STATE_TONE,
  TRIGGER_LABEL,
  RESTORE_CONFIRM_PHRASE,
  RESTORE_STEPS,
  backupBlockedReason,
  formatBackupBytes,
  formatDuration,
  type BackupDto,
  type RestoreStageResult,
  type VerificationResult,
} from '@/lib/backup';

const MANAGE_PERMISSION = 'system:backup:manage';

export default function AdminBackupPage() {
  const { user } = useAuth();
  const canManage = Boolean(user?.permissions.includes(MANAGE_PERMISSION));

  return (
    <div className="space-y-4">
      <PageTitle title="Backup" description="การสำรองฐานข้อมูลและไฟล์บนเซิร์ฟเวอร์" />
      {canManage ? <BackupManager /> : <NoPermission />}
    </div>
  );
}

function NoPermission() {
  return (
    <Panel>
      <PanelHeader title="ประวัติการสำรองข้อมูล" description="ครอบคลุมทั้ง database และ file storage" action={<Badge tone="neutral">ไม่มีสิทธิ์</Badge>} />
      <PanelBody>
        <p className="text-[12.5px] leading-relaxed text-navy-400">
          การสำรองและกู้คืนข้อมูลสงวนไว้สำหรับผู้ที่ได้รับสิทธิ์ สำรองและกู้คืนข้อมูลของระบบ
        </p>
      </PanelBody>
    </Panel>
  );
}

function BackupManager() {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [confirmDelete, setConfirmDelete] = useState<BackupDto | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupDto | null>(null);
  const [verification, setVerification] = useState<{ id: string; result: VerificationResult } | null>(null);

  const readiness = useQuery({ queryKey: ['backup-readiness'], queryFn: backupApi.readiness, refetchInterval: 15_000 });
  const backups = useQuery({ queryKey: ['backups'], queryFn: backupApi.list });

  const rows = backups.data?.data ?? [];
  const latest = rows[0];
  const blocked = backupBlockedReason(readiness.data?.data);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['backups'] });
    void queryClient.invalidateQueries({ queryKey: ['backup-readiness'] });
  };

  const onError = (error: unknown) =>
    notify({ tone: 'error', title: error instanceof ApiError ? error.message : 'ดำเนินการไม่สำเร็จ' });

  const create = useMutation({
    mutationFn: backupApi.create,
    onSuccess: () => { notify({ tone: 'success', title: 'สำรองข้อมูลเรียบร้อยแล้ว' }); refresh(); },
    onError,
  });

  const verify = useMutation({
    mutationFn: (id: string) => backupApi.verify(id),
    onSuccess: (response, id) => {
      setVerification({ id, result: response.data });
      notify({
        tone: response.data.valid ? 'success' : 'error',
        title: response.data.valid ? 'ชุดสำรองผ่านการตรวจสอบ' : 'ชุดสำรองไม่ผ่านการตรวจสอบ',
      });
    },
    onError,
  });

  const offsiteRetry = useMutation({
    mutationFn: (id: string) => backupApi.offsiteRetry(id),
    onSuccess: (response) => {
      notify({
        tone: response.data.ok ? 'success' : 'error',
        title: response.data.ok ? 'คัดลอกออกนอกเครื่องแล้ว' : 'คัดลอกออกนอกเครื่องไม่สำเร็จ',
      });
      refresh();
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => backupApi.remove(id),
    onSuccess: () => { notify({ tone: 'success', title: 'ลบชุดสำรองแล้ว' }); setConfirmDelete(null); refresh(); },
    onError,
  });

  return (
    <>
      <BackupSchedulePanel />
      <RestoreRehearsalPanel />

      <Panel>
        <PanelHeader
          title="สำรองข้อมูลล่าสุด"
          description="ครอบคลุมฐานข้อมูลและไฟล์ที่ S2 NAS ดูแล"
          action={
            <button
              type="button"
              className="s2-btn s2-btn-primary"
              disabled={create.isPending || blocked !== null}
              title={blocked ?? undefined}
              onClick={() => create.mutate()}
            >
              {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
              {create.isPending ? 'กำลังสำรองข้อมูล…' : 'สร้าง Backup'}
            </button>
          }
        />
        <PanelBody>
          {blocked ? (
            <p className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {blocked}
            </p>
          ) : null}

          {backups.isPending ? (
            <TextSkeleton lines={4} />
          ) : backups.isError ? (
            <ErrorState message="อ่านประวัติการสำรองข้อมูลไม่สำเร็จ" onRetry={() => void backups.refetch()} />
          ) : !latest ? (
            <EmptyState
              icon={<Database className="h-6 w-6" aria-hidden />}
              title="ยังไม่มีการสำรองข้อมูล"
              description="กด สร้าง Backup เพื่อสำรองฐานข้อมูลและไฟล์ทั้งหมด"
              className="py-8"
            />
          ) : (
            <dl className="divide-y divide-line text-[13px]">
              <Row label="สถานะ" value={<Badge tone={BACKUP_STATUS_TONE[latest.status]}>{BACKUP_STATUS_LABEL[latest.status]}</Badge>} />
              <Row label="ขนาดรวม" value={formatBackupBytes(latest.totalBytes)} />
              <Row label="ฐานข้อมูล" value={formatBackupBytes(latest.databaseBytes)} />
              <Row label="ไฟล์" value={formatBackupBytes(latest.storageBytes)} />
              <Row label="จำนวนไฟล์" value={latest.fileCount === null ? '—' : `${latest.fileCount} รายการ`} />
              <Row label="เริ่มเมื่อ" value={formatDateTime(latest.startedAt)} />
              <Row label="เสร็จเมื่อ" value={latest.completedAt ? formatDateTime(latest.completedAt) : '—'} />
              <Row label="ใช้เวลา" value={formatDuration(latest.durationMs)} />
              <Row label="สร้างโดย" value={latest.createdBy?.displayName ?? '—'} />
            </dl>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="ประวัติการสำรองข้อมูล" description={`${rows.length} ชุด`} />
        <PanelBody className="p-0">
          {rows.length === 0 ? null : (
            <ul className="divide-y divide-line">
              {rows.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={BACKUP_STATUS_TONE[row.status]}>{BACKUP_STATUS_LABEL[row.status]}</Badge>
                      <span className="text-[12.5px] font-medium text-navy-800">{formatDateTime(row.startedAt)}</span>
                      <span className="text-[11px] text-navy-400">{formatRelativeTime(row.startedAt)}</span>
                      <Badge tone="neutral">{TRIGGER_LABEL[row.trigger]}</Badge>
                      {row.offsiteState !== 'NOT_CONFIGURED' ? (
                        <Badge tone={OFFSITE_STATE_TONE[row.offsiteState]}>
                          นอกเครื่อง: {OFFSITE_STATE_LABEL[row.offsiteState]}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-[11px] text-navy-400">
                      {formatBackupBytes(row.totalBytes)} · {row.fileCount ?? 0} ไฟล์
                      {row.createdBy ? ` · ${row.createdBy.displayName}` : ''}
                    </p>
                    {row.errorMessage ? (
                      <p className="mt-1.5 rounded-lg bg-red-50 px-2 py-1.5 text-[11px] text-red-700">{row.errorMessage}</p>
                    ) : null}
                    {row.offsiteError ? (
                      <p className="mt-1.5 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700">
                        สำเนานอกเครื่อง: {row.offsiteError}
                      </p>
                    ) : null}
                    {verification?.id === row.id ? (
                      <p
                        className={`mt-1.5 rounded-lg px-2 py-1.5 text-[11px] ${verification.result.valid ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}
                      >
                        {verification.result.summary}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <button
                      type="button"
                      className="s2-btn s2-btn-outline"
                      disabled={row.status !== 'COMPLETED' || verify.isPending}
                      onClick={() => verify.mutate(row.id)}
                    >
                      <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                      ตรวจสอบ
                    </button>
                    <button
                      type="button"
                      className="s2-btn s2-btn-outline"
                      disabled={row.status !== 'COMPLETED'}
                      onClick={() => setRestoreTarget(row)}
                    >
                      <Database className="h-3.5 w-3.5" aria-hidden />
                      เตรียม Restore
                    </button>
                    {row.status === 'COMPLETED' && row.offsiteState === 'FAILED' ? (
                      <button
                        type="button"
                        className="s2-btn s2-btn-outline"
                        disabled={offsiteRetry.isPending}
                        onClick={() => offsiteRetry.mutate(row.id)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                        ลองคัดลอกใหม่
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="s2-btn border border-red-200 bg-red-50 text-red-700"
                      disabled={row.status === 'RUNNING' || row.status === 'PENDING'}
                      onClick={() => setConfirmDelete(row)}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      ลบ
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>

      {confirmDelete ? (
        <Dialog
          title="ลบชุดสำรองข้อมูล"
          body={`ชุดสำรองของวันที่ ${formatDateTime(confirmDelete.startedAt)} จะถูกลบทั้งไฟล์และประวัติ การลบนี้ย้อนกลับไม่ได้`}
          confirmLabel={remove.isPending ? 'กำลังลบ…' : 'ลบชุดสำรอง'}
          danger
          isPending={remove.isPending}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => remove.mutate(confirmDelete.id)}
        />
      ) : null}

      {restoreTarget ? (
        <RestoreWizard backup={restoreTarget} onClose={() => { setRestoreTarget(null); refresh(); }} />
      ) : null}
    </>
  );
}

/**
 * ตัวช่วยเตรียมกู้คืนแบบหลายขั้น
 *
 * ทุกขั้นตอนทำงานในพื้นที่พักเท่านั้น ระบบที่ใช้งานจริงไม่ถูกแตะต้อง
 * การ cutover จริงเป็นขั้นตอนที่ผู้ดูแลลงมือเองนอกหน้าจอนี้ ตาม docs/RESTORE.md
 */
function RestoreWizard({ backup, onClose }: { backup: BackupDto; onClose: () => void }) {
  const { notify } = useToast();
  const [phrase, setPhrase] = useState('');
  const [result, setResult] = useState<RestoreStageResult | null>(null);

  const precheck = useMutation({
    mutationFn: () => backupApi.restorePrecheck(backup.id),
    onError: (error: unknown) => notify({ tone: 'error', title: error instanceof ApiError ? error.message : 'ตรวจสอบไม่สำเร็จ' }),
  });

  const stage = useMutation({
    mutationFn: () => backupApi.restoreStage(backup.id),
    onSuccess: (response) => {
      setResult(response.data);
      notify({
        tone: response.data.ok ? 'success' : 'error',
        title: response.data.ok ? 'พื้นที่กู้คืนพร้อมแล้ว' : 'เตรียมกู้คืนไม่ผ่านการตรวจสอบ',
      });
    },
    onError: (error: unknown) => notify({ tone: 'error', title: error instanceof ApiError ? error.message : 'เตรียมกู้คืนไม่สำเร็จ' }),
  });

  const precheckResult = precheck.data?.data;
  const canStage = precheckResult?.ok === true && phrase.trim().toUpperCase() === RESTORE_CONFIRM_PHRASE;

  return (
    <div className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-4 backdrop-blur-sm" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="restore-title"
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop"
      >
        <h2 id="restore-title" className="text-[16px] font-semibold text-navy-900">เตรียมกู้คืนข้อมูล</h2>
        <p className="mt-1 text-[11.5px] text-navy-400">ชุดสำรองวันที่ {formatDateTime(backup.startedAt)}</p>

        <ol className="mt-4 space-y-1.5">
          {RESTORE_STEPS.map((step, index) => {
            const done =
              (index <= 1 && precheckResult?.ok === true) || (index === 2 && result !== null) || (index === 3 && result?.ok === true);
            return (
              <li key={step.key} className="flex items-center gap-2 text-[12px] text-navy-600">
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ${done ? 'bg-emerald-100 text-emerald-700' : 'bg-navy-50 text-navy-400'}`}>
                  {done ? <Check className="h-3 w-3" aria-hidden /> : index + 1}
                </span>
                {step.label}
              </li>
            );
          })}
        </ol>

        <p className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[11.5px] leading-relaxed text-amber-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          ขั้นตอนนี้กู้คืนลงพื้นที่พักเท่านั้น ระบบที่ใช้งานอยู่จะไม่ถูกเปลี่ยนแปลง
          การนำข้อมูลขึ้นใช้งานจริงเป็นขั้นตอนที่ผู้ดูแลต้องทำเองตามคู่มือ
        </p>

        {precheckResult ? (
          <div className={`mt-3 rounded-xl px-3 py-2.5 text-[11.5px] ${precheckResult.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
            {precheckResult.ok
              ? `ตรวจผ่าน: ไฟล์ ${precheckResult.objectCount} รายการพร้อมกู้คืน`
              : precheckResult.problems.join(' · ')}
          </div>
        ) : null}

        {result ? (
          <div className="mt-3 rounded-xl border border-line bg-[var(--s2-surface-soft)] px-3 py-2.5 text-[11.5px] text-navy-600">
            <p>ไฟล์ที่ตรวจผ่าน: {result.verifiedObjects}/{result.restoredObjects}</p>
            <p>ข้อมูลที่กู้คืน: {result.reconciliation.resourceRows} ทรัพยากร · {result.reconciliation.versionRows} เวอร์ชัน</p>
            <p>ไฟล์หาย {result.reconciliation.missingFiles.length} · ไฟล์ส่วนเกิน {result.reconciliation.orphanFiles.length}</p>
            {result.problems.map((problem) => <p key={problem} className="mt-1 text-red-600">{problem}</p>)}
          </div>
        ) : null}

        {precheckResult?.ok && !result ? (
          <label className="mt-4 block text-[11.5px] font-semibold text-navy-700">
            พิมพ์ {RESTORE_CONFIRM_PHRASE} เพื่อยืนยัน
            <input
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
              className="s2-input mt-1.5 h-10 rounded-xl px-3 text-[13px]"
              placeholder={RESTORE_CONFIRM_PHRASE}
              autoComplete="off"
            />
          </label>
        ) : null}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="s2-btn s2-btn-ghost" onClick={onClose} disabled={stage.isPending}>ปิด</button>
          {!precheckResult ? (
            <button type="button" className="s2-btn s2-btn-primary" disabled={precheck.isPending} onClick={() => precheck.mutate()}>
              {precheck.isPending ? 'กำลังตรวจสอบ…' : 'ตรวจสอบ Backup'}
            </button>
          ) : null}
          {precheckResult?.ok && !result ? (
            <button type="button" className="s2-btn s2-btn-primary" disabled={!canStage || stage.isPending} onClick={() => stage.mutate()}>
              {stage.isPending ? 'กำลังเตรียม…' : 'เตรียมพื้นที่ Restore'}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function Dialog({
  title, body, confirmLabel, danger, isPending, onCancel, onConfirm,
}: {
  title: string; body: string; confirmLabel: string; danger?: boolean; isPending: boolean;
  onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-4 backdrop-blur-sm" role="presentation">
      <section role="alertdialog" aria-modal="true" aria-labelledby="backup-dialog-title" className="w-full max-w-md rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop">
        <h2 id="backup-dialog-title" className="text-[16px] font-semibold text-navy-900">{title}</h2>
        <p className="mt-2 text-[12px] leading-relaxed text-navy-500">{body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="s2-btn s2-btn-ghost" onClick={onCancel} disabled={isPending}>ยกเลิก</button>
          <button
            type="button"
            className={danger ? 's2-btn border border-red-200 bg-red-600 text-white' : 's2-btn s2-btn-primary'}
            onClick={onConfirm}
            disabled={isPending}
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-navy-400">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-navy-800">{value}</dd>
    </div>
  );
}
