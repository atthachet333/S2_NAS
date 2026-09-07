import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Copy,
  Link2,
  Loader2,
  Lock,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import {
  ApiError,
  publicShareApi,
  type CreateShareInput,
  type CreatedShareDto,
  type PublicShareLinkDto,
} from '@/lib/api';
import { useToast } from '@/hooks/useToast';
import { SHARE_STATUS, shareExpiryText } from '@/lib/public-share';

/**
 * จัดการลิงก์แชร์ภายนอกของทรัพยากรหนึ่งชิ้น (F18)
 *
 * มีสองโหมดในกล่องเดียว: รายการลิงก์ที่มีอยู่ และแบบฟอร์มสร้างลิงก์ใหม่
 *
 * เหตุที่รวมไว้ที่เดียว: ก่อนจะสร้างลิงก์ใหม่ คนควรเห็นก่อนว่ามีลิงก์เดิมเปิดค้างอยู่กี่อัน
 * ถ้าแยกหน้ากัน คนจะสร้างลิงก์ซ้ำไปเรื่อย ๆ จนไม่มีใครรู้ว่าใครถืออะไรอยู่บ้าง
 */

const EXPIRY_CHOICES = [
  { value: '1', label: '1 วัน' },
  { value: '7', label: '7 วัน' },
  { value: '30', label: '30 วัน' },
  { value: 'custom', label: 'กำหนดเอง' },
  { value: 'never', label: 'ไม่หมดอายุ' },
] as const;

const ERROR_TEXT: Record<string, string> = {
  PUBLIC_SHARE_DENIED: 'คุณไม่มีสิทธิ์จัดการลิงก์แชร์ภายนอกของทรัพยากรนี้',
  SHARE_RESOURCE_TRASHED: 'ทรัพยากรอยู่ในถังขยะ จึงสร้างลิงก์ไม่ได้',
  SHARE_RESOURCE_ARCHIVED: 'ทรัพยากรถูกเก็บเข้าคลัง ต้องนำออกจากคลังก่อน',
  SHARE_TOO_MANY_LINKS: 'ทรัพยากรนี้มีลิงก์ที่ยังใช้งานได้ครบจำนวนแล้ว กรุณายกเลิกลิงก์เก่าก่อน',
  SHARE_INVALID_EXPIRY: 'วันหมดอายุไม่ถูกต้อง',
  SHARE_NO_PERMISSION: 'ลิงก์ต้องอนุญาตอย่างน้อยการดูตัวอย่างหรือการดาวน์โหลด',
};

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? (ERROR_TEXT[error.code] ?? error.message ?? fallback) : fallback;

export function PublicShareDialog({
  resourceId,
  resourceName,
  onClose,
}: {
  resourceId: string;
  resourceName: string;
  onClose: () => void;
}) {
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedShareDto | null>(null);

  const links = useQuery({
    queryKey: ['public-shares', resourceId],
    queryFn: () => publicShareApi.list(resourceId),
    retry: false,
  });

  const revoke = useMutation({
    mutationFn: (id: string) => publicShareApi.revoke(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['public-shares', resourceId] });
      notify({ tone: 'success', title: 'ยกเลิกลิงก์แล้ว' });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'ยกเลิกลิงก์ไม่สำเร็จ') }),
  });

  const rows = links.data?.data ?? [];
  const active = rows.filter((row) => row.status === 'ACTIVE');

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-3 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="public-share-title"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop"
        onMouseDown={(mouse) => mouse.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="public-share-title" className="text-sm font-semibold text-navy-800">
              แชร์ภายนอก
            </h2>
            <p className="mt-0.5 truncate text-[12px] text-navy-400">{resourceName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="s2-btn s2-btn-ghost h-8 w-8 shrink-0 p-0"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {/*
          ลิงก์ที่เพิ่งสร้าง - โทเคนปรากฏที่นี่ครั้งเดียวเท่านั้น
          ไม่มีเส้นทางใดในระบบที่อ่านกลับมาได้อีก เพราะฐานข้อมูลเก็บแค่แฮช
        */}
        {created ? (
          <CreatedLink created={created} onDone={() => setCreated(null)} />
        ) : null}

        {/* ---------- ลิงก์ที่มีอยู่ ---------- */}
        {links.isPending ? (
          <div className="flex justify-center py-8 text-navy-400">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          </div>
        ) : links.isError ? (
          <p className="py-8 text-center text-[12.5px] text-navy-400">
            {message(links.error, 'โหลดรายการลิงก์ไม่สำเร็จ')}
          </p>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-[12.5px] text-navy-400">
            ยังไม่มีลิงก์แชร์ภายนอกสำหรับทรัพยากรนี้
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {rows.map((row) => (
              <li key={row.id}>
                <ShareRow
                  row={row}
                  onRevoke={() => revoke.mutate(row.id)}
                  revoking={revoke.isPending && revoke.variables === row.id}
                />
              </li>
            ))}
          </ul>
        )}

        {/* ---------- สร้างใหม่ ---------- */}
        {creating ? (
          <CreateForm
            resourceId={resourceId}
            onCancel={() => setCreating(false)}
            onCreated={(result) => {
              setCreating(false);
              setCreated(result);
              void queryClient.invalidateQueries({ queryKey: ['public-shares', resourceId] });
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="s2-btn s2-btn-outline mt-4 h-9 w-full gap-1.5 text-[12.5px]"
          >
            <Plus className="h-4 w-4" aria-hidden />
            สร้างลิงก์ใหม่
          </button>
        )}

        {active.length > 0 ? (
          <p className="mt-3 text-center text-[11.5px] text-navy-400">
            {active.length} ลิงก์กำลังใช้งาน
          </p>
        ) : null}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ลิงก์ที่เพิ่งสร้าง                                                     */
/* ------------------------------------------------------------------ */

function CreatedLink({ created, onDone }: { created: CreatedShareDto; onDone: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /**
       * คลิปบอร์ดถูกปฏิเสธได้ในบางบริบท (ไม่ใช่ HTTPS, ผู้ใช้ไม่อนุญาต)
       * ลิงก์ยังแสดงเป็นข้อความที่เลือกคัดลอกเองได้ จึงไม่ใช่ทางตัน
       */
      setCopied(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-brand-200 bg-brand-50 p-3">
      <p className="text-[11.5px] font-medium text-brand-700">ลิงก์พร้อมใช้งานแล้ว</p>

      <div className="mt-2 flex items-center gap-1.5">
        {/* readOnly + เลือกทั้งหมดเมื่อคลิก - คัดลอกด้วยมือได้เสมอแม้คลิปบอร์ดถูกปฏิเสธ */}
        <input
          readOnly
          value={created.url}
          onFocus={(event) => event.currentTarget.select()}
          aria-label="ลิงก์ที่สร้าง"
          className="s2-input h-8 flex-1 font-mono text-[11px]"
        />
        <button
          type="button"
          onClick={() => void copy()}
          className="s2-btn s2-btn-primary h-8 shrink-0 gap-1.5 px-2.5 text-[12px]"
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          {copied ? 'คัดลอกแล้ว' : 'คัดลอกลิงก์'}
        </button>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-brand-700">
        คัดลอกเก็บไว้ตอนนี้ - ระบบเก็บเฉพาะค่าที่เข้ารหัสแล้ว จึงไม่สามารถแสดงลิงก์นี้ซ้ำได้อีก
        {created.link.passwordProtected ? ' อย่าลืมส่งรหัสผ่านให้ผู้รับแยกจากลิงก์' : ''}
      </p>

      <button
        type="button"
        onClick={onDone}
        className="s2-btn s2-btn-ghost mt-2 h-7 text-[11.5px] text-brand-700"
      >
        คัดลอกเรียบร้อยแล้ว
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* แถวของลิงก์                                                          */
/* ------------------------------------------------------------------ */

function ShareRow({
  row,
  onRevoke,
  revoking,
}: {
  row: PublicShareLinkDto;
  onRevoke: () => void;
  revoking: boolean;
}) {
  const status = SHARE_STATUS[row.status];

  return (
    <div className="rounded-xl border border-line p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Link2 className="h-3.5 w-3.5 shrink-0 text-navy-400" aria-hidden />
            {/* สถานะบอกด้วยข้อความ ไม่ใช่สีอย่างเดียว - คนที่แยกสีไม่ได้ต้องอ่านออก */}
            <span className={`rounded-md border px-1.5 py-0.5 text-[10.5px] ${status.className}`}>
              {status.label}
            </span>
            {row.passwordProtected ? (
              <span className="inline-flex items-center gap-1 text-[10.5px] text-navy-500">
                <Lock className="h-3 w-3" aria-hidden />
                มีรหัสผ่าน
              </span>
            ) : null}
          </div>

          <p className="mt-1 text-[11.5px] text-navy-500">
            {row.allowDownload ? 'ดูและดาวน์โหลดได้' : 'ดูได้อย่างเดียว'}
            {' • '}
            {shareExpiryText(row.expiresAt)}
          </p>

          <p className="mt-0.5 text-[11px] text-navy-400">
            เปิดแล้ว {row.viewCount}
            {row.maxViews === null ? '' : `/${row.maxViews}`} ครั้ง · ดาวน์โหลด {row.downloadCount}
            {row.maxDownloads === null ? '' : `/${row.maxDownloads}`} ครั้ง
          </p>
          {row.label ? <p className="mt-0.5 truncate text-[11px] text-navy-400">{row.label}</p> : null}
        </div>

        {row.status !== 'REVOKED' ? (
          <button
            type="button"
            onClick={onRevoke}
            disabled={revoking}
            aria-label="ยกเลิกลิงก์"
            className="s2-btn s2-btn-ghost h-8 w-8 shrink-0 p-0 text-red-600 disabled:opacity-50"
          >
            {revoking ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* แบบฟอร์มสร้างลิงก์                                                    */
/* ------------------------------------------------------------------ */

function CreateForm({
  resourceId,
  onCancel,
  onCreated,
}: {
  resourceId: string;
  onCancel: () => void;
  onCreated: (created: CreatedShareDto) => void;
}) {
  const { notify } = useToast();

  /** ค่าเริ่มต้นที่ปลอดภัย - ดูได้ ดาวน์โหลดไม่ได้ หมดอายุ 7 วัน ไม่มีรหัสผ่าน ไม่จำกัดจำนวน */
  const [allowPreview, setAllowPreview] = useState(true);
  const [allowDownload, setAllowDownload] = useState(false);
  const [expiry, setExpiry] = useState<string>('7');
  const [customExpiry, setCustomExpiry] = useState('');
  const [password, setPassword] = useState('');
  const [maxViews, setMaxViews] = useState('');
  const [maxDownloads, setMaxDownloads] = useState('');
  const [label, setLabel] = useState('');

  const create = useMutation({
    mutationFn: (input: CreateShareInput) => publicShareApi.create(resourceId, input),
    onSuccess: (result) => onCreated(result.data),
    onError: (error) => notify({ tone: 'error', title: message(error, 'สร้างลิงก์ไม่สำเร็จ') }),
  });

  const resolveExpiry = (): string | null | undefined => {
    if (expiry === 'never') return null;
    if (expiry === 'custom') return customExpiry ? new Date(customExpiry).toISOString() : undefined;
    const days = Number(expiry);
    return new Date(Date.now() + days * 86_400_000).toISOString();
  };

  const toLimit = (value: string): number | null => {
    const parsed = Number(value);
    return value.trim() && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  };

  /** การรวมกันที่เสี่ยงที่สุด: ลิงก์ที่ดาวน์โหลดได้และไม่มีวันหมดอายุ */
  const risky = expiry === 'never' && allowDownload;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    create.mutate({
      allowPreview,
      allowDownload,
      expiresAt: resolveExpiry(),
      password: password.trim() ? password : null,
      maxViews: toLimit(maxViews),
      maxDownloads: toLimit(maxDownloads),
      label: label.trim() || null,
    });
  };

  return (
    <form onSubmit={submit} className="mt-4 space-y-3 rounded-xl border border-line p-3">
      <fieldset>
        <legend className="text-[11.5px] font-medium text-navy-600">สิทธิ์</legend>
        <div className="mt-1.5 space-y-1.5">
          <label className="flex items-center gap-2 text-[12.5px] text-navy-700">
            <input
              type="checkbox"
              checked={allowPreview}
              onChange={(event) => setAllowPreview(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-line"
            />
            ดูตัวอย่าง
          </label>
          <label className="flex items-center gap-2 text-[12.5px] text-navy-700">
            <input
              type="checkbox"
              checked={allowDownload}
              onChange={(event) => setAllowDownload(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-line"
            />
            ดาวน์โหลด
          </label>
        </div>
      </fieldset>

      <label className="block">
        <span className="text-[11.5px] font-medium text-navy-600">หมดอายุ</span>
        <select
          value={expiry}
          onChange={(event) => setExpiry(event.target.value)}
          className="s2-input mt-1 h-8 text-[12.5px]"
        >
          {EXPIRY_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>

      {expiry === 'custom' ? (
        <label className="block">
          <span className="text-[11.5px] font-medium text-navy-600">วันและเวลาที่หมดอายุ</span>
          <input
            type="datetime-local"
            value={customExpiry}
            onChange={(event) => setCustomExpiry(event.target.value)}
            className="s2-input mt-1 h-8 text-[12.5px]"
          />
        </label>
      ) : null}

      {/*
        เตือนแต่ไม่ห้าม - บางงานต้องการลิงก์ถาวรจริง
        การห้ามจะทำให้คนไปหาวิธีอื่นที่ไม่มีใครมองเห็นแทน
      */}
      {risky ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11.5px] text-[var(--s2-warning-ring)]"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            ลิงก์นี้จะดาวน์โหลดไฟล์ได้ตลอดไปจนกว่าจะมีคนกดยกเลิก
            ใครก็ตามที่ได้รับลิงก์ต่อจะเข้าถึงเอกสารได้ด้วย
          </span>
        </p>
      ) : null}

      <label className="block">
        <span className="text-[11.5px] font-medium text-navy-600">รหัสผ่าน (ไม่บังคับ)</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="อย่างน้อย 6 ตัวอักษร"
          minLength={6}
          className="s2-input mt-1 h-8 text-[12.5px]"
        />
      </label>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="text-[11.5px] font-medium text-navy-600">จำกัดการเปิด</span>
          <input
            type="number"
            min={1}
            value={maxViews}
            onChange={(event) => setMaxViews(event.target.value)}
            placeholder="ไม่จำกัด"
            className="s2-input mt-1 h-8 text-[12.5px]"
          />
        </label>
        <label className="block">
          <span className="text-[11.5px] font-medium text-navy-600">จำกัดการดาวน์โหลด</span>
          <input
            type="number"
            min={1}
            value={maxDownloads}
            onChange={(event) => setMaxDownloads(event.target.value)}
            placeholder="ไม่จำกัด"
            className="s2-input mt-1 h-8 text-[12.5px]"
          />
        </label>
      </div>

      <label className="block">
        <span className="text-[11.5px] font-medium text-navy-600">ชื่อกำกับ (เห็นเฉพาะภายใน)</span>
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="เช่น ส่งให้ลูกค้า ก"
          maxLength={191}
          className="s2-input mt-1 h-8 text-[12.5px]"
        />
      </label>

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="s2-btn s2-btn-ghost h-8 text-[12.5px]">
          ยกเลิก
        </button>
        <button
          type="submit"
          disabled={create.isPending || (!allowPreview && !allowDownload)}
          className="s2-btn s2-btn-primary h-8 gap-1.5 text-[12.5px] disabled:opacity-60"
        >
          {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          สร้างลิงก์
        </button>
      </div>
    </form>
  );
}
