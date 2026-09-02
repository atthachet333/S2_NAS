import { useEffect, useRef, useState } from 'react';
import { FileText, Globe2, Link2, Sheet, X } from 'lucide-react';
import { ApiError, resourceApi } from '@/lib/api';
import type { DriveEntry } from '@/lib/drive';
import { EXTERNAL_RESOURCE_META, validateExternalUrl, type ExternalResourceType } from '@/lib/external-resources';

const ICONS = { GOOGLE_SHEET: Sheet, GOOGLE_DOC: FileText, GOOGLE_DRIVE: Globe2, WEB_LINK: Link2 } as const;
const ERRORS = {
  INVALID_EXTERNAL_RESOURCE_URL: 'ลิงก์ไม่ถูกต้องสำหรับประเภททรัพยากรนี้',
  UNSAFE_URL_SCHEME: 'ไม่รองรับลิงก์ประเภทนี้',
  RESOURCE_ACCESS_DENIED: 'คุณไม่มีสิทธิ์เพิ่มทรัพยากรในตำแหน่งนี้',
} as const;

export function ExternalResourceDialog({ type, parentId, entry, destinationName, onClose, onSuccess }: {
  type: ExternalResourceType; parentId: string | null; entry?: DriveEntry | null; destinationName: string;
  onClose: () => void; onSuccess: (message: string) => void;
}) {
  const meta = EXTERNAL_RESOURCE_META[type];
  const Icon = ICONS[type];
  const [name, setName] = useState(entry?.name ?? '');
  const [url, setUrl] = useState(entry?.externalUrl ?? '');
  const [remark, setRemark] = useState(entry?.remark ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => { firstRef.current?.focus(); }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const validation = validateExternalUrl(type, url);
    if (validation) { setError(ERRORS[validation]); return; }
    setError(null); setSubmitting(true);
    try {
      if (entry) await resourceApi.update(entry.id, { name, externalUrl: url, remark: remark.trim() || null });
      else await resourceApi.createExternal({ type, name, parentId, url, remark: remark.trim() || null });
      onSuccess(entry ? 'แก้ไขลิงก์แล้ว' : meta.toast);
    } catch (reason) {
      setError(reason instanceof ApiError ? ERRORS[reason.code as keyof typeof ERRORS] ?? reason.message : 'ดำเนินการไม่สำเร็จ');
    } finally { setSubmitting(false); }
  };

  return <div className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-3 backdrop-blur-sm" onMouseDown={onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="external-dialog-title" className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop sm:p-6" onMouseDown={(event) => event.stopPropagation()}>
      <div className="flex items-start gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><Icon className="h-5 w-5" /></span><div className="min-w-0 flex-1"><h2 id="external-dialog-title" className="text-[16px] font-semibold text-navy-900">{entry ? `แก้ไข ${meta.label}` : `เพิ่ม ${meta.label}`}</h2><p className="mt-1 truncate text-[11px] text-navy-400">ตำแหน่ง: {destinationName}</p></div><button type="button" onClick={onClose} aria-label="ปิด" className="rounded-lg p-1.5 text-navy-400 hover:bg-navy-50"><X className="h-4 w-4" /></button></div>
      <form onSubmit={submit} className="mt-5 space-y-4">
        <label className="block text-[11.5px] font-semibold text-navy-700">ประเภท<input className="s2-input mt-1.5 h-11 rounded-xl px-3 text-[13px]" value={meta.label} disabled /></label>
        <label className="block text-[11.5px] font-semibold text-navy-700">{meta.nameLabel}<input ref={firstRef} className="s2-input mt-1.5 h-11 rounded-xl px-3 text-[13px]" value={name} onChange={(event) => setName(event.target.value)} maxLength={191} required /></label>
        <label className="block text-[11.5px] font-semibold text-navy-700">URL<input type="url" inputMode="url" className="s2-input mt-1.5 h-11 rounded-xl px-3 text-[13px]" value={url} onChange={(event) => setUrl(event.target.value)} maxLength={2048} placeholder="https://" required /></label>
        <label className="block text-[11.5px] font-semibold text-navy-700">หมายเหตุ <span className="font-normal text-navy-400">(ไม่บังคับ)</span><textarea className="s2-input mt-1.5 min-h-24 rounded-xl px-3 py-2 text-[13px]" value={remark} onChange={(event) => setRemark(event.target.value)} maxLength={1000} /></label>
        {type !== 'WEB_LINK' ? <p className="rounded-xl border border-line bg-[var(--s2-surface-soft)] px-3 py-2 text-[11px] leading-relaxed text-navy-500">สิทธิ์ใน S2 NAS และสิทธิ์ของ Google เป็นคนละส่วนกัน ผู้ใช้ต้องมีสิทธิ์จาก Google เพื่อเปิดรายการจริง</p> : <p className="text-[11px] text-navy-400">ลิงก์ภายนอกจะเปิดในแท็บใหม่</p>}
        {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-[11.5px] text-red-700">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-1"><button type="button" onClick={onClose} className="s2-btn s2-btn-ghost">ยกเลิก</button><button type="submit" disabled={submitting || !name.trim() || !url.trim()} className="s2-btn s2-btn-primary">{submitting ? 'กำลังบันทึก…' : 'บันทึก'}</button></div>
      </form>
    </section>
  </div>;
}
