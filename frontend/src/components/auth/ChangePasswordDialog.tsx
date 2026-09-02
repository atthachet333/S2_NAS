import { useEffect, useRef, useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';

export function ChangePasswordDialog({ forced, open, onClose }: { forced: boolean; open: boolean; onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const { changePassword } = useAuth();
  const navigate = useNavigate();
  useEffect(() => { if (open) window.setTimeout(() => firstRef.current?.focus(), 0); }, [open]);
  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !forced) onClose();
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])') ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [open, forced, onClose]);
  if (!open) return null;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError(null);
    if (newPassword.length < 12) return setError('รหัสผ่านใหม่ต้องมีอย่างน้อย 12 ตัวอักษร');
    if (newPassword !== confirmPassword) return setError('รหัสผ่านใหม่ไม่ตรงกัน');
    setSubmitting(true);
    try { await changePassword(currentPassword, newPassword); navigate('/login', { replace: true }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'เปลี่ยนรหัสผ่านไม่สำเร็จ'); }
    finally { setSubmitting(false); }
  };
  return <div className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-4 backdrop-blur-sm" role="presentation" onMouseDown={() => { if (!forced) onClose(); }}>
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="change-password-title" className="w-full max-w-md rounded-2xl border border-line bg-[var(--s2-elevated)] p-6 shadow-pop" onMouseDown={(event) => event.stopPropagation()}>
      <div className="flex items-start gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><KeyRound className="h-5 w-5" /></span><div className="min-w-0 flex-1"><h2 id="change-password-title" className="text-[16px] font-semibold text-navy-900">{forced ? 'ตั้งรหัสผ่านใหม่ก่อนเริ่มใช้งาน' : 'เปลี่ยนรหัสผ่าน'}</h2><p className="mt-1 text-[11.5px] leading-relaxed text-navy-400">เพื่อความปลอดภัย ระบบจะให้เข้าสู่ระบบใหม่หลังเปลี่ยนรหัสผ่าน</p></div>{!forced ? <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-navy-400 hover:bg-navy-50" aria-label="ปิด"><X className="h-4 w-4" /></button> : null}</div>
      <form onSubmit={submit} className="mt-6 space-y-3.5">
        <PasswordField inputRef={firstRef} label="รหัสผ่านปัจจุบัน" value={currentPassword} onChange={setCurrentPassword} />
        <PasswordField label="รหัสผ่านใหม่" value={newPassword} onChange={setNewPassword} />
        <PasswordField label="ยืนยันรหัสผ่านใหม่" value={confirmPassword} onChange={setConfirmPassword} />
        {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-[11px] text-red-700">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-2">{!forced ? <button type="button" onClick={onClose} className="s2-btn s2-btn-ghost">ยกเลิก</button> : null}<button type="submit" disabled={submitting} className="s2-btn s2-btn-primary">{submitting ? 'กำลังบันทึก…' : 'บันทึกรหัสผ่านใหม่'}</button></div>
      </form>
    </section>
  </div>;
}

function PasswordField({ label, value, onChange, inputRef }: { label: string; value: string; onChange: (value: string) => void; inputRef?: React.Ref<HTMLInputElement> }) {
  return <label className="block text-[11.5px] font-semibold text-navy-700">{label}<input ref={inputRef} type="password" value={value} onChange={(event) => onChange(event.target.value)} autoComplete="new-password" className="s2-input mt-1.5 h-10 rounded-xl px-3 text-[13px]" required /></label>;
}
