import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, KeyRound, Plus, Search, ShieldCheck, UserPlus } from 'lucide-react';
import { ApiError, usersApi, type PublicUser } from '@/lib/api';
import { accountTypeLabel } from '@/lib/portal';
import { PageTitle } from '@/components/ui/PageTitle';
import { ListSkeleton } from '@/components/ui/States';
import { UserActionDialog } from '@/components/admin/UserActionDialog';
import { ClientAccessDialog } from '@/components/admin/ClientAccessDialog';
import { formatDateTime } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';

const STATUS_LABEL: Record<string, string> = {
  INVITED: 'รอเปิดใช้งาน',
  ACTIVE: 'ใช้งานอยู่',
  SUSPENDED: 'ระงับชั่วคราว',
  DISABLED: 'ปิดใช้งาน',
};

const STATUS_TONE: Record<string, string> = {
  INVITED: 'bg-amber-50 text-amber-700',
  ACTIVE: 'bg-emerald-50 text-emerald-700',
  SUSPENDED: 'bg-amber-50 text-amber-700',
  DISABLED: 'bg-red-50 text-red-700',
};

/**
 * หน้าจัดการบัญชีลูกค้า
 *
 * แยกจากหน้าผู้ใช้งานภายในโดยตั้งใจ แม้จะใช้ API เดียวกัน
 * เพราะสองกลุ่มนี้ต่างกันทั้งวิธีให้สิทธิ์ ความหมายของบทบาท และสิ่งที่ผู้ดูแลต้องดูแล
 * การรวมไว้ในตารางเดียวทำให้ "ลูกค้าคนไหนเข้าถึงอะไรได้" กลายเป็นคำถามที่ตอบยาก
 *
 * ไม่มีการสมัครเอง บัญชีลูกค้าทุกใบเกิดจากผู้ดูแลสร้างที่หน้านี้เท่านั้น
 */
export default function AdminClientsPage() {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [term, setTerm] = useState('');
  const [creating, setCreating] = useState(false);
  const [target, setTarget] = useState<{ user: PublicUser; mode: 'activate' | 'reset-password' } | null>(null);
  const [inspecting, setInspecting] = useState<PublicUser | null>(null);

  const clients = useQuery({
    queryKey: ['clients', term],
    queryFn: () => usersApi.list({ type: 'EXTERNAL', q: term.trim() || undefined, limit: 100 }),
  });

  const rows = clients.data?.data.items ?? [];

  return (
    <div className="space-y-5">
      <PageTitle
        title="ลูกค้า / ผู้ใช้งานภายนอก"
        description="บัญชีที่เข้าถึงได้เฉพาะเอกสารที่แชร์ให้เท่านั้น ผ่านพื้นที่เอกสารสำหรับลูกค้า"
      />

      <div className="flex flex-wrap items-center gap-2">
        <label className="s2-surface flex min-w-[220px] flex-1 items-center gap-2 px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-navy-300" aria-hidden />
          <input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="ค้นหาชื่อหรืออีเมลของลูกค้า"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-navy-800 outline-none placeholder:text-navy-300"
          />
        </label>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="s2-btn s2-btn-primary h-10 gap-1.5 px-3 text-[12.5px]"
        >
          <Plus className="h-4 w-4" aria-hidden />
          เพิ่มลูกค้า
        </button>
      </div>

      {clients.isPending ? (
        <ListSkeleton rows={5} />
      ) : rows.length === 0 ? (
        <div className="s2-surface flex flex-col items-center gap-2 px-6 py-12 text-center">
          <UserPlus className="h-8 w-8 text-navy-200" aria-hidden />
          <p className="text-[13.5px] font-medium text-navy-800">ยังไม่มีบัญชีลูกค้า</p>
          <p className="max-w-[420px] text-[12px] text-navy-400">
            สร้างบัญชีให้ลูกค้าก่อน แล้วจึงแชร์โฟลเดอร์ให้จากหน้าจัดการสิทธิ์ของเอกสารนั้น
          </p>
        </div>
      ) : (
        <div className="s2-surface overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[12.5px]">
            <thead className="border-b border-line text-[11px] uppercase tracking-wide text-navy-400">
              <tr>
                <th className="px-4 py-2.5 font-medium">ชื่อ</th>
                <th className="px-4 py-2.5 font-medium">อีเมล</th>
                <th className="px-4 py-2.5 font-medium">บริษัท</th>
                <th className="px-4 py-2.5 font-medium">สถานะ</th>
                <th className="px-4 py-2.5 font-medium">เข้าใช้งานล่าสุด</th>
                <th className="px-4 py-2.5 font-medium">สร้างเมื่อ</th>
                <th className="px-4 py-2.5 font-medium">จัดการ</th>
                <th className="px-4 py-2.5 font-medium">สิทธิ์เข้าถึง</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-1.5">
                      <span className="font-medium text-navy-800">{row.displayName}</span>
                      {/* ป้ายกำกับติดตัวลูกค้าทุกที่ที่ปรากฏ */}
                      <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                        {accountTypeLabel(row.type)}
                      </span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-navy-500">{row.email}</td>
                  <td className="px-4 py-2.5 text-navy-500">
                    {row.organizationName ? (
                      <span className="inline-flex items-center gap-1">
                        <Building2 className="h-3.5 w-3.5 text-navy-300" aria-hidden />
                        {row.organizationName}
                      </span>
                    ) : (
                      <span className="text-navy-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-md px-1.5 py-0.5 text-[10.5px] ${STATUS_TONE[row.status] ?? ''}`}>
                      {STATUS_LABEL[row.status] ?? row.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-navy-500">
                    {row.lastLoginAt ? formatDateTime(row.lastLoginAt) : <span className="text-navy-300">ยังไม่เคยเข้าใช้งาน</span>}
                  </td>
                  <td className="px-4 py-2.5 text-navy-500">{formatDateTime(row.createdAt)}</td>
                  <td className="px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() => setTarget({ user: row, mode: row.status === 'INVITED' ? 'activate' : 'reset-password' })}
                      className="s2-btn s2-btn-ghost h-8 gap-1.5 px-2 text-[12px]"
                    >
                      <KeyRound className="h-3.5 w-3.5" aria-hidden />
                      {row.status === 'INVITED' ? 'เปิดใช้งาน' : 'ตั้งรหัสใหม่'}
                    </button>
                  </td>
                  <td className="px-4 py-2.5">
                    {/* "ลูกค้ารายนี้เข้าถึงอะไรได้บ้าง" ต้องตอบได้จากที่นี่ ไม่ต้องไล่เปิดทีละเอกสาร */}
                    <button
                      type="button"
                      onClick={() => setInspecting(row)}
                      className="s2-btn s2-btn-ghost h-8 gap-1.5 px-2 text-[12px]"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                      ดูสิทธิ์
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <CreateClientDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void queryClient.invalidateQueries({ queryKey: ['clients'] });
            notify({ tone: 'success', title: 'สร้างบัญชีลูกค้าแล้ว', description: 'ขั้นตอนถัดไปคือตั้งรหัสผ่านชั่วคราวเพื่อเปิดใช้งาน' });
          }}
        />
      ) : null}

      {inspecting ? (
        <ClientAccessDialog client={inspecting} onClose={() => setInspecting(null)} />
      ) : null}

      {target ? (
        <UserActionDialog
          user={target.user}
          mode={target.mode}
          onClose={() => {
            setTarget(null);
            void queryClient.invalidateQueries({ queryKey: ['clients'] });
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * สร้างบัญชีลูกค้า
 *
 * ไม่มีช่องเลือกบทบาท เพราะบัญชีลูกค้าไม่รับบทบาทภายในเลย
 * สิทธิ์ทั้งหมดมาจากการแชร์รายทรัพยากร ซึ่งทำที่หน้าเอกสารนั้น ๆ ไม่ใช่ที่นี่
 */
function CreateClientDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      usersApi.create({
        email: email.trim(),
        displayName: displayName.trim(),
        type: 'EXTERNAL',
        organizationName: organizationName.trim() || null,
        roleCodes: [],
      }),
    onSuccess: onCreated,
    onError: (reason) =>
      setError(reason instanceof ApiError ? reason.message : 'สร้างบัญชีไม่สำเร็จ'),
  });

  const ready = email.trim().length > 0 && displayName.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-3 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-client-title"
        className="w-full max-w-md rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop sm:p-6"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="create-client-title" className="text-[16px] font-semibold text-navy-900">
          เพิ่มลูกค้า
        </h2>
        <p className="mt-1 text-[11.5px] leading-relaxed text-navy-400">
          บัญชีจะถูกสร้างในสถานะรอเปิดใช้งาน ต้องตั้งรหัสผ่านชั่วคราวก่อนจึงเข้าใช้งานได้
          หากลูกค้าใช้บัญชี Google ที่ตรงกับอีเมลนี้ ก็เข้าสู่ระบบด้วย Google ได้ทันทีหลังเปิดใช้งาน
        </p>

        <div className="mt-4 space-y-3">
          <label className="block text-[11.5px] font-semibold text-navy-700">
            ชื่อที่แสดง
            <input
              className="s2-input mt-1 h-10 rounded-xl px-3 text-[13px]"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="เช่น คุณสมชาย ใจดี"
            />
          </label>

          <label className="block text-[11.5px] font-semibold text-navy-700">
            อีเมล
            <input
              type="email"
              className="s2-input mt-1 h-10 rounded-xl px-3 text-[13px]"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@company.co.th"
            />
          </label>

          <label className="block text-[11.5px] font-semibold text-navy-700">
            บริษัท <span className="font-normal text-navy-400">(ไม่บังคับ)</span>
            <input
              className="s2-input mt-1 h-10 rounded-xl px-3 text-[13px]"
              value={organizationName}
              onChange={(event) => setOrganizationName(event.target.value)}
              placeholder="ชื่อบริษัทของลูกค้า"
            />
          </label>
        </div>

        {error ? <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-[11.5px] text-red-700">{error}</p> : null}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="s2-btn s2-btn-ghost">
            ยกเลิก
          </button>
          <button
            type="button"
            disabled={!ready || create.isPending}
            onClick={() => create.mutate()}
            className="s2-btn s2-btn-primary disabled:opacity-60"
          >
            {create.isPending ? 'กำลังสร้าง…' : 'สร้างบัญชี'}
          </button>
        </div>
      </section>
    </div>
  );
}
