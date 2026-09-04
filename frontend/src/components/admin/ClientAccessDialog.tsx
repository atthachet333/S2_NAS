import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, FileText, Folder, ShieldCheck, Trash2, X } from 'lucide-react';
import { usersApi, workspaceApi, type PublicUser } from '@/lib/api';
import { expiryLabel, isExpired } from '@/lib/portal';
import { TextSkeleton } from '@/components/ui/States';
import { formatDateTime } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';

/**
 * "ลูกค้ารายนี้เข้าถึงอะไรได้บ้าง"
 *
 * คำถามที่ต้องตอบได้ในหน้าจอเดียวเวลามีคนถามว่าเอกสารอะไรถูกเปิดให้คนนอก
 * รวมสิทธิ์ที่หมดอายุแล้วไว้ด้วย เพราะการเห็นว่าเคยให้ไว้เป็นข้อมูลที่ต้องใช้ตอนตรวจสอบ
 * แต่แยกให้ชัดว่าไม่มีผลแล้ว
 *
 * ไม่ใช่ระบบจัดการลูกค้า - มีแค่การดูและการเพิกถอน การมอบสิทธิ์ยังทำที่หน้าเอกสารนั้น ๆ
 */
export function ClientAccessDialog({ client, onClose }: { client: PublicUser; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();

  const access = useQuery({
    queryKey: ['client-access', client.id],
    queryFn: () => usersApi.clientPortalAccess(client.id),
  });

  const revoke = useMutation({
    mutationFn: (resourceId: string) => workspaceApi.revokeAccess(resourceId, client.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['client-access', client.id] });
      notify({ tone: 'success', title: 'เพิกถอนสิทธิ์แล้ว', description: 'มีผลทันที ลูกค้าไม่ต้องออกจากระบบ' });
    },
    onError: () => notify({ tone: 'error', title: 'เพิกถอนสิทธิ์ไม่สำเร็จ' }),
  });

  const summary = access.data?.data;

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-3 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="client-access-title"
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop sm:p-6"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
            <Building2 className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="client-access-title" className="flex items-center gap-1.5 text-[16px] font-semibold text-navy-900">
              <span className="truncate">{client.displayName}</span>
              <span className="shrink-0 rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                ภายนอก
              </span>
            </h2>
            <p className="mt-0.5 truncate text-[11px] text-navy-400">{client.email}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="ปิด" className="rounded-lg p-1.5 text-navy-400 hover:bg-navy-50">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* สรุปสั้น ๆ ที่ผู้ดูแลต้องรู้ก่อนตัดสินใจอะไร */}
        <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Fact label="บริษัท" value={client.organizationName ?? '—'} />
          <Fact label="สถานะ" value={client.status === 'ACTIVE' ? 'ใช้งานอยู่' : 'ยังไม่พร้อมใช้งาน'} />
          <Fact
            label="เชื่อม Google"
            value={summary ? (summary.googleLinked ? 'เชื่อมแล้ว' : 'ยังไม่เชื่อม') : '…'}
          />
          <Fact
            label="เข้าใช้งานล่าสุด"
            value={client.lastLoginAt ? formatDateTime(client.lastLoginAt) : 'ยังไม่เคย'}
          />
        </dl>

        <div className="mt-5">
          <p className="s2-section-title flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-navy-400" aria-hidden />
            รายการที่แชร์ให้ลูกค้ารายนี้
            {summary ? <span className="font-normal text-navy-400">({summary.activeGrants} รายการที่ยังมีผล)</span> : null}
          </p>

          {access.isPending ? (
            <div className="mt-2"><TextSkeleton lines={3} /></div>
          ) : !summary || summary.grants.length === 0 ? (
            <p className="mt-2 rounded-xl border border-dashed border-line px-3 py-4 text-center text-[11.5px] text-navy-400">
              ยังไม่มีเอกสารที่แชร์ให้ลูกค้ารายนี้
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
              {summary.grants.map((grant) => (
                <li key={grant.resourceId} className="flex items-center gap-2 px-3 py-2.5">
                  <span className="shrink-0 text-navy-300" aria-hidden>
                    {grant.resourceType === 'FOLDER' ? <Folder className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] font-medium text-navy-800">{grant.resourceName}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px] text-navy-400">
                      <span>{grant.role === 'CONTRIBUTOR' ? 'อัปโหลดได้' : 'ดูอย่างเดียว'}</span>
                      <span aria-hidden>·</span>
                      <span>{grant.allowDownload ? 'ดาวน์โหลดได้' : 'ดาวน์โหลดไม่ได้'}</span>
                      <span aria-hidden>·</span>
                      <span>แชร์เมื่อ {formatDateTime(grant.sharedAt)}</span>
                    </p>
                  </div>

                  <span
                    className={
                      grant.isExpired || isExpired(grant.expiresAt)
                        ? 'shrink-0 rounded-md bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700'
                        : 'shrink-0 rounded-md border border-line px-1.5 py-0.5 text-[10px] text-navy-500'
                    }
                  >
                    {expiryLabel(grant.expiresAt)}
                  </span>

                  <button
                    type="button"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(grant.resourceId)}
                    className="shrink-0 rounded-lg p-1.5 text-navy-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                    aria-label={`เพิกถอนสิทธิ์ของ ${grant.resourceName}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-2 text-[11px] leading-relaxed text-navy-400">
            การมอบสิทธิ์ใหม่ทำที่หน้าจัดการสิทธิ์ของเอกสารนั้น ๆ เพื่อให้การตัดสินใจเกิดขึ้นตรงที่เอกสารอยู่
          </p>
        </div>

        <div className="flex justify-end pt-4">
          <button type="button" onClick={onClose} className="s2-btn s2-btn-ghost">ปิด</button>
        </div>
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-[var(--s2-surface-soft)] px-3 py-2">
      <dt className="text-[10px] uppercase tracking-wide text-navy-400">{label}</dt>
      <dd className="mt-0.5 truncate text-[12px] font-medium text-navy-800">{value}</dd>
    </div>
  );
}
