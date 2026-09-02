import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RotateCcw, Trash2 } from 'lucide-react';
import { ApiError, fileApi, type TrashEntryDto } from '@/lib/api';
import { toDriveEntry } from '@/lib/drive';
import { uploadErrorText } from '@/lib/error-text';
import { FileTypeIcon } from '@/components/files/FileTypeIcon';
import { FolderPicker } from '@/components/files/FolderPicker';
import { OwnerAvatar, ownerLabel } from '@/components/files/OwnerIdentity';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';
import { useToast } from '@/hooks/useToast';
import { formatBytes, formatDateTime, formatRelativeTime } from '@/lib/utils';

export default function TrashPage() {
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<TrashEntryDto | null>(null);
  const [restoreConflict, setRestoreConflict] = useState<{ item: TrashEntryDto; reason: 'NAME_CONFLICT' | 'PARENT_MISSING' } | null>(null);

  const { data, isPending, isError, refetch } = useQuery({ queryKey: ['trash'], queryFn: fileApi.trash });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['trash'] });
    void queryClient.invalidateQueries({ queryKey: ['drive'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    void queryClient.invalidateQueries({ queryKey: ['managed-storage'] });
  };

  const restore = useMutation({
    mutationFn: (input: { id: string; newName?: string; targetParentId?: string | null }) =>
      fileApi.restore(input.id, {
        ...(input.newName ? { newName: input.newName } : {}),
        ...(input.targetParentId !== undefined ? { targetParentId: input.targetParentId } : {}),
      }),
    onSuccess: () => {
      setRestoreConflict(null);
      notify({ tone: 'success', title: 'กู้คืนแล้ว' });
      refresh();
    },
    onError: (error: unknown, variables) => {
      if (!(error instanceof ApiError)) {
        notify({ tone: 'error', title: 'กู้คืนไม่สำเร็จ' });
        return;
      }

      // เซิร์ฟเวอร์บอกสาเหตุมาชัดเจน จึงเสนอทางออกที่ตรงกับปัญหา
      const reason = (error.details as { reason?: string } | undefined)?.reason;
      if (reason === 'NAME_CONFLICT') {
        const item = items.find((candidate) => candidate.id === variables.id);
        if (item) setRestoreConflict({ item, reason: 'NAME_CONFLICT' });
        return;
      }
      if (reason === 'PARENT_MISSING') {
        const item = items.find((candidate) => candidate.id === variables.id);
        if (item) setRestoreConflict({ item, reason: 'PARENT_MISSING' });
        return;
      }
      notify({ tone: 'error', title: uploadErrorText(error.code, error.message) });
    },
  });

  const purge = useMutation({
    mutationFn: (id: string) => fileApi.permanentDelete(id),
    onSuccess: () => {
      setConfirming(null);
      notify({ tone: 'success', title: 'ลบถาวรแล้ว' });
      refresh();
    },
    onError: (error: unknown) => {
      notify({
        tone: 'error',
        title: error instanceof ApiError ? uploadErrorText(error.code, error.message) : 'ลบถาวรไม่สำเร็จ',
      });
    },
  });

  const items = data?.data ?? [];

  return (
    <div className="space-y-6">
      <PageTitle
        title="ถังขยะ"
        description="รายการที่ถูกลบยังคงอยู่บนเซิร์ฟเวอร์จนกว่าจะลบถาวร"
      />

      <section>
        <div className="flex items-baseline justify-between gap-3 border-t border-line pt-4">
          <h2 className="text-[13px] font-semibold text-navy-800">รายการที่ลบแล้ว</h2>
          {!isPending && !isError ? (
            <span className="text-[11.5px] text-navy-400">{items.length} รายการ</span>
          ) : null}
        </div>

        <div className="mt-4">
          {isPending ? (
            <ListSkeleton rows={4} />
          ) : isError ? (
            <ErrorState message="โหลดถังขยะไม่สำเร็จ" onRetry={() => void refetch()} />
          ) : items.length === 0 ? (
            <div className="s2-resource-card mx-auto w-full max-w-lg">
              <EmptyState
                icon={<Trash2 className="h-6 w-6" aria-hidden />}
                title="ถังขยะว่างเปล่า"
                description="รายการที่ลบจะปรากฏที่นี่"
                className="py-8"
              />
            </div>
          ) : (
            <ul className="overflow-hidden rounded-2xl border border-[var(--s2-card-border)] bg-[var(--s2-layer-card)]">
              {items.map((item) => {
                const entry = toDriveEntry(item);
                return (
                  <li key={item.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-0">
                    <FileTypeIcon
                      name={item.name}
                      kind={item.type === 'FOLDER' ? 'folder' : 'file'}
                      size="sm"
                      mimeType={item.mimeType}
                    />

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-navy-900">{item.name}</p>
                      <p className="mt-0.5 truncate text-[10.5px] text-navy-400">
                        {item.type === 'FOLDER' ? 'โฟลเดอร์' : formatBytes(entry.sizeBytes)} · เดิมอยู่ใน{' '}
                        {item.originalLocation}
                      </p>
                    </div>

                    <div className="flex min-w-0 items-center gap-1.5">
                      {item.deletedBy ? <OwnerAvatar owner={item.deletedBy} size="xs" /> : null}
                      <span
                        className="truncate text-[10.5px] text-navy-400"
                        title={formatDateTime(item.deletedAt)}
                      >
                        {item.deletedBy ? `${ownerLabel(item.deletedBy)} · ` : ''}
                        {formatRelativeTime(item.deletedAt)}
                      </span>
                    </div>

                    <div className="flex shrink-0 gap-1.5">
                      <button
                        type="button"
                        disabled={restore.isPending}
                        onClick={() => restore.mutate({ id: item.id })}
                        className="inline-flex items-center gap-1 rounded-lg border border-line bg-[var(--s2-surface)] px-2 py-1 text-[11px] text-navy-600 transition-colors hover:bg-navy-50 disabled:opacity-50"
                      >
                        <RotateCcw className="h-3 w-3" aria-hidden />
                        กู้คืน
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirming(item)}
                        className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700 transition-colors hover:bg-red-100"
                      >
                        <Trash2 className="h-3 w-3" aria-hidden />
                        ลบถาวร
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {confirming ? (
        <PermanentDeleteDialog
          item={confirming}
          isPending={purge.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={() => purge.mutate(confirming.id)}
        />
      ) : null}
      {restoreConflict ? (
        <RestoreConflictDialog
          conflict={restoreConflict}
          isPending={restore.isPending}
          onCancel={() => setRestoreConflict(null)}
          onRestore={(input) => restore.mutate({ id: restoreConflict.item.id, ...input })}
        />
      ) : null}
    </div>
  );
}

function RestoreConflictDialog({
  conflict,
  isPending,
  onCancel,
  onRestore,
}: {
  conflict: { item: TrashEntryDto; reason: 'NAME_CONFLICT' | 'PARENT_MISSING' };
  isPending: boolean;
  onCancel: () => void;
  onRestore: (input: { newName?: string; targetParentId?: string | null }) => void;
}) {
  const [newName, setNewName] = useState(conflict.item.name);
  const [targetParentId, setTargetParentId] = useState<string | null>(null);
  const [locationChosen, setLocationChosen] = useState(false);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape') cancelRef.current(); };
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); previousFocus?.focus(); };
  }, []);
  const cleanedName = newName.trim().replace(/\s+/gu, ' ');
  const invalidName = !cleanedName || cleanedName === '.' || cleanedName === '..' || cleanedName.length > 191 || /[\\/\p{Cc}\p{Cf}]/u.test(cleanedName) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(cleanedName);
  const nameConflict = conflict.reason === 'NAME_CONFLICT';

  return (
    <div className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-4 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="restore-conflict-title" className="w-full max-w-lg rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop">
        <h2 id="restore-conflict-title" className="text-[16px] font-semibold text-navy-900">
          {nameConflict ? 'ไม่สามารถกู้คืนด้วยชื่อเดิมได้' : 'ตำแหน่งเดิมไม่พร้อมใช้งาน'}
        </h2>
        {nameConflict ? (
          <>
            <p className="mt-2 text-[12px] leading-relaxed text-navy-500">ไฟล์/โฟลเดอร์ชื่อ:<br /><strong className="text-navy-800">“{conflict.item.name}”</strong><br />มีอยู่ในตำแหน่งเดิมแล้ว</p>
            <label className="mt-4 block text-[12px] font-semibold text-navy-700">
              ชื่อใหม่
              <input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} className="s2-input mt-1.5 rounded-xl px-3 py-2.5 text-[13px]" aria-invalid={invalidName} />
            </label>
            {invalidName ? <p className="mt-1 text-[11px] text-red-600">กรุณาใช้ชื่อที่ถูกต้องและไม่มี / หรือ \\</p> : null}
          </>
        ) : (
          <>
            <p className="mt-2 text-[12px] leading-relaxed text-navy-500">เลือกโฟลเดอร์ปลายทางสำหรับกู้คืนรายการนี้</p>
            <div className="mt-4">
              <FolderPicker value={targetParentId} onChange={(id) => { setTargetParentId(id); setLocationChosen(true); }} excludeId={conflict.item.id} />
            </div>
          </>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="s2-btn s2-btn-ghost" onClick={onCancel} disabled={isPending}>ยกเลิก</button>
          <button
            type="button"
            className="s2-btn s2-btn-primary"
            disabled={isPending || (nameConflict ? invalidName || cleanedName === conflict.item.name : !locationChosen)}
            onClick={() => onRestore(nameConflict ? { newName: cleanedName } : { targetParentId })}
          >{isPending ? 'กำลังกู้คืน…' : 'กู้คืน'}</button>
        </div>
      </section>
    </div>
  );
}

/** ยืนยันการลบถาวร โดยแสดงจำนวนจริงจากเซิร์ฟเวอร์เท่านั้น */
function PermanentDeleteDialog({
  item,
  isPending,
  onCancel,
  onConfirm,
}: {
  item: TrashEntryDto;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { data } = useQuery({
    queryKey: ['permanent-delete-preview', item.id],
    queryFn: () => fileApi.permanentDeletePreview(item.id),
  });
  const preview = data?.data;

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="purge-title"
        className="w-full max-w-md rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600">
            <AlertTriangle className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id="purge-title" className="text-[15.5px] font-semibold text-navy-900">
              ลบถาวร
            </h2>
            <p className="mt-1 truncate text-[12px] text-navy-400">{item.name}</p>
          </div>
        </div>

        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-[12px] leading-relaxed text-red-700">
          {item.type === 'FOLDER'
            ? preview
              ? `โฟลเดอร์นี้และรายการภายในทั้งหมด ${preview.resourceCount} รายการ (ไฟล์ ${preview.fileCount} ไฟล์ · ${preview.versionCount} เวอร์ชัน) จะถูกลบอย่างถาวร`
              : 'กำลังตรวจสอบจำนวนรายการภายใน…'
            : preview
              ? `ไฟล์นี้และประวัติเวอร์ชันทั้งหมด ${preview.versionCount} เวอร์ชัน จะถูกลบอย่างถาวร`
              : 'ไฟล์นี้และประวัติเวอร์ชันทั้งหมดจะถูกลบอย่างถาวร'}
        </p>
        <p className="mt-2 text-[11px] text-navy-400">การกระทำนี้ย้อนกลับไม่ได้</p>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="s2-btn s2-btn-ghost">
            ยกเลิก
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending || !preview}
            className="s2-btn border border-red-200 bg-red-600 text-white disabled:opacity-60"
          >
            {isPending ? 'กำลังลบ…' : 'ลบถาวร'}
          </button>
        </div>
      </section>
    </div>
  );
}
