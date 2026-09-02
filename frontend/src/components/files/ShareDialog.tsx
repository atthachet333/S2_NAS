import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, DownloadCloud, Search, Share2, ShieldCheck, Trash2, X } from 'lucide-react';
import { ApiError, workspaceApi, type AccessGrantDto } from '@/lib/api';
import type { DriveEntry } from '@/lib/drive';
import { OwnerIdentity } from './OwnerIdentity';
import { TextSkeleton } from '@/components/ui/States';
import { useToast } from '@/hooks/useToast';

const ERROR_TEXT: Record<string, string> = {
  SHARE_DENIED: 'คุณไม่มีสิทธิ์จัดการสิทธิ์ของทรัพยากรนี้',
  SHARE_TARGET_INACTIVE: 'แชร์ได้เฉพาะผู้ใช้ที่เปิดใช้งานอยู่',
  SHARE_INVALID_TARGET: 'ผู้ดูแลหลักมีสิทธิ์เต็มอยู่แล้ว',
  ACCESS_NOT_FOUND: 'สิทธิ์นี้ถูกยกเลิกไปแล้ว',
  RESOURCE_NOT_FOUND: 'ไม่พบทรัพยากรนี้แล้ว',
};

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? ERROR_TEXT[error.code] ?? error.message : fallback;

/**
 * แผงจัดการสิทธิ์เข้าถึงภายในองค์กร
 *
 * ไม่มีลิงก์สาธารณะและไม่มีการแชร์ออกนอกองค์กร ทุกสิทธิ์ผูกกับบัญชีผู้ใช้จริงเสมอ
 * ระดับสิทธิ์ให้ได้แค่ "แก้ไข" กับ "เปิดดู" ส่วนความเป็นผู้ดูแลหลักต้องโอนผ่านขั้นตอนโอนผู้ดูแล
 */
export function ShareDialog({ entry, onClose }: { entry: DriveEntry; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [term, setTerm] = useState('');
  const [level, setLevel] = useState<'EDITOR' | 'VIEWER'>('VIEWER');
  const [allowDownload, setAllowDownload] = useState(true);
  const [picked, setPicked] = useState<{ id: string; displayName: string; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  const access = useQuery({
    queryKey: ['access', entry.id],
    queryFn: () => workspaceApi.access(entry.id),
  });

  // ค้นหาเฉพาะเมื่อพิมพ์แล้ว เพื่อไม่ให้เปิดกล่องแล้วดึงรายชื่อพนักงานทั้งบริษัทมาทันที
  const trimmed = term.trim();
  const targets = useQuery({
    queryKey: ['share-targets', trimmed],
    queryFn: () => workspaceApi.shareTargets(trimmed),
    enabled: trimmed.length > 0 && !picked,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['access', entry.id] });
    void queryClient.invalidateQueries({ queryKey: ['drive'] });
    void queryClient.invalidateQueries({ queryKey: ['shared'] });
  };

  const grant = useMutation({
    mutationFn: () =>
      workspaceApi.grantAccess(entry.id, { userId: picked!.id, accessLevel: level, allowDownload }),
    onSuccess: () => {
      invalidate();
      notify({ tone: 'success', title: `ให้สิทธิ์ ${picked!.displayName} แล้ว` });
      setPicked(null);
      setTerm('');
      setError(null);
    },
    onError: (reason) => setError(errorText(reason, 'ให้สิทธิ์ไม่สำเร็จ')),
  });

  const revoke = useMutation({
    mutationFn: (userId: string) => workspaceApi.revokeAccess(entry.id, userId),
    onSuccess: () => {
      invalidate();
      notify({ tone: 'success', title: 'ยกเลิกสิทธิ์แล้ว' });
    },
    onError: (reason) => setError(errorText(reason, 'ยกเลิกสิทธิ์ไม่สำเร็จ')),
  });

  const data = access.data?.data;
  const grants = data?.grants ?? [];
  const canManage = data?.canManage ?? false;

  const results = useMemo(
    () => (targets.data?.data ?? []).filter((user) => !grants.some((row) => row.userId === user.id)),
    [targets.data, grants],
  );

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-3 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop sm:p-6"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
            <Share2 className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="share-dialog-title" className="text-[16px] font-semibold text-navy-900">
              จัดการสิทธิ์เข้าถึง
            </h2>
            <p className="mt-1 truncate text-[11px] text-navy-400">{entry.name}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="ปิด" className="rounded-lg p-1.5 text-navy-400 hover:bg-navy-50">
            <X className="h-4 w-4" />
          </button>
        </div>

        {access.isPending ? (
          <div className="mt-5"><TextSkeleton lines={4} /></div>
        ) : (
          <div className="mt-5 space-y-4">
            {/* ผู้ดูแลหลัก */}
            <div>
              <p className="s2-section-title">ผู้ดูแลหลัก</p>
              <div className="mt-2 rounded-xl border border-line bg-[var(--s2-surface-soft)] px-3 py-2.5">
                <OwnerIdentity
                  owner={{ displayName: entry.ownerName, email: entry.ownerEmail }}
                  caption={entry.ownerEmail}
                  size="md"
                />
              </div>
            </div>

            {/* การมองเห็นระดับองค์กร */}
            <div className="flex items-start gap-2.5 rounded-xl border border-line bg-[var(--s2-surface-soft)] px-3 py-2.5">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-navy-400" aria-hidden />
              <p className="text-[11.5px] leading-relaxed text-navy-500">
                {data?.visibility === 'RESTRICTED'
                  ? 'จำกัดเฉพาะผู้ที่ได้รับสิทธิ์ ผู้ดูแลหลัก และผู้ดูแลระบบเท่านั้น'
                  : 'ผู้ใช้ที่เปิดใช้งานในองค์กรเปิดดูได้ตามค่าเริ่มต้น การให้สิทธิ์รายบุคคลด้านล่างจะมีน้ำหนักเหนือค่านี้'}
              </p>
            </div>

            {/* เพิ่มคน */}
            {canManage ? (
              <div>
                <p className="s2-section-title">เพิ่มผู้เข้าถึง</p>
                {picked ? (
                  <div className="mt-2 space-y-3 rounded-xl border border-line px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <OwnerIdentity owner={picked} caption={picked.email} size="sm" />
                      <button
                        type="button"
                        onClick={() => setPicked(null)}
                        className="rounded-lg p-1.5 text-navy-400 hover:bg-navy-50"
                        aria-label="เลือกคนอื่น"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <label className="text-[11.5px] font-semibold text-navy-700">
                        ระดับสิทธิ์
                        <select
                          className="s2-input mt-1 h-9 rounded-lg px-2 text-[12.5px]"
                          value={level}
                          onChange={(event) => setLevel(event.target.value as 'EDITOR' | 'VIEWER')}
                        >
                          <option value="VIEWER">เปิดดูได้</option>
                          <option value="EDITOR">แก้ไขได้</option>
                        </select>
                      </label>

                      <label className="mt-5 inline-flex items-center gap-2 text-[11.5px] text-navy-600">
                        <input
                          type="checkbox"
                          checked={allowDownload}
                          onChange={(event) => setAllowDownload(event.target.checked)}
                        />
                        อนุญาตให้ดาวน์โหลด
                      </label>
                    </div>

                    <button
                      type="button"
                      className="s2-btn s2-btn-primary w-full"
                      disabled={grant.isPending}
                      onClick={() => grant.mutate()}
                    >
                      {grant.isPending ? 'กำลังให้สิทธิ์…' : 'ให้สิทธิ์'}
                    </button>
                  </div>
                ) : (
                  <div className="mt-2">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy-300" aria-hidden />
                      <input
                        ref={searchRef}
                        className="s2-input h-11 rounded-xl pl-9 pr-3 text-[13px]"
                        placeholder="ค้นหาชื่อหรืออีเมลของเพื่อนร่วมงาน"
                        value={term}
                        onChange={(event) => setTerm(event.target.value)}
                        aria-label="ค้นหาผู้ใช้เพื่อให้สิทธิ์"
                      />
                    </div>

                    {trimmed ? (
                      <div className="mt-2 max-h-44 overflow-y-auto rounded-xl border border-line">
                        {targets.isPending ? (
                          <p className="px-3 py-3 text-[11.5px] text-navy-400">กำลังค้นหา…</p>
                        ) : results.length === 0 ? (
                          <p className="px-3 py-3 text-[11.5px] text-navy-400">
                            ไม่พบผู้ใช้ที่เปิดใช้งานตรงกับคำค้นนี้
                          </p>
                        ) : (
                          results.map((user) => (
                            <button
                              key={user.id}
                              type="button"
                              onClick={() => setPicked(user)}
                              className="flex w-full items-center gap-2 border-b border-line px-3 py-2.5 text-left last:border-b-0 hover:bg-navy-50"
                            >
                              <OwnerIdentity owner={user} caption={user.email} size="sm" />
                            </button>
                          ))
                        )}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}

            {/* คนที่มีสิทธิ์อยู่แล้ว */}
            <div>
              <p className="s2-section-title">ผู้ที่ได้รับสิทธิ์ ({grants.length})</p>
              {grants.length === 0 ? (
                <p className="mt-2 rounded-xl border border-dashed border-line px-3 py-3 text-[11.5px] leading-relaxed text-navy-400">
                  ยังไม่มีการให้สิทธิ์รายบุคคล
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
                  {grants.map((row) => (
                    <GrantRow
                      key={row.userId}
                      grant={row}
                      canManage={canManage}
                      pending={revoke.isPending}
                      onRevoke={() => revoke.mutate(row.userId)}
                    />
                  ))}
                </ul>
              )}
            </div>

            {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-[11.5px] text-red-700">{error}</p> : null}
          </div>
        )}

        <div className="flex justify-end pt-4">
          <button type="button" onClick={onClose} className="s2-btn s2-btn-ghost">ปิด</button>
        </div>
      </section>
    </div>
  );
}

function GrantRow({
  grant,
  canManage,
  pending,
  onRevoke,
}: {
  grant: AccessGrantDto;
  canManage: boolean;
  pending: boolean;
  onRevoke: () => void;
}) {
  return (
    <li className="flex items-center gap-2 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <OwnerIdentity owner={grant.user} caption={grant.user.email} size="sm" />
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <span className="rounded-md border border-line bg-[var(--s2-surface-soft)] px-1.5 py-0.5 text-[10.5px] text-navy-500">
          {grant.accessLevel === 'EDITOR' ? 'แก้ไขได้' : 'เปิดดูได้'}
        </span>
        <span
          className="text-navy-300"
          title={grant.allowDownload ? 'ดาวน์โหลดได้' : 'เปิดดูได้อย่างเดียว ดาวน์โหลดไม่ได้'}
        >
          {grant.allowDownload ? (
            <DownloadCloud className="h-3.5 w-3.5" aria-label="ดาวน์โหลดได้" />
          ) : (
            <Download className="h-3.5 w-3.5 opacity-30" aria-label="ดาวน์โหลดไม่ได้" />
          )}
        </span>
        {/* บัญชีที่ถูกปิดยังค้างสิทธิ์อยู่ ต้องเห็นชัดเพื่อให้ตามเก็บกวาดได้ */}
        {grant.userStatus !== 'ACTIVE' ? (
          <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">ปิดใช้งาน</span>
        ) : null}
        {canManage ? (
          <button
            type="button"
            onClick={onRevoke}
            disabled={pending}
            className="rounded-lg p-1.5 text-navy-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
            aria-label={`ยกเลิกสิทธิ์ของ ${grant.user.displayName}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </li>
  );
}
