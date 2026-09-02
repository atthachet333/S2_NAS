import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { OwnerAvatar } from '@/components/files/OwnerIdentity';
import { ApiError } from '@/lib/api';
import { userStatusLabel } from '@/lib/user-text';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/useToast';

export function ProfileDialog({ onClose }: { onClose: () => void }) {
  const { user, updateProfile } = useAuth();
  const { notify } = useToast();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const save = useMutation({
    mutationFn: () => updateProfile(displayName),
    onSuccess: () => {
      notify({ tone: 'success', title: 'บันทึกโปรไฟล์แล้ว' });
      onClose();
    },
    onError: (reason) => {
      setError(reason instanceof ApiError ? reason.message : 'บันทึกโปรไฟล์ไม่สำเร็จ');
    },
  });

  if (!user) return null;

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-3 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-dialog-title"
        className="w-full max-w-md rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop sm:p-6"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <OwnerAvatar owner={user} size="lg" />
          <div className="min-w-0 flex-1">
            <h2 id="profile-dialog-title" className="text-[16px] font-semibold text-navy-900">โปรไฟล์</h2>
            <p className="mt-1 truncate text-[11px] text-navy-400">{user.email}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="ปิด" className="rounded-lg p-1.5 text-navy-400 hover:bg-navy-50">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <label className="block text-[11.5px] font-semibold text-navy-700">
            ชื่อที่แสดง
            <input
              ref={inputRef}
              className="s2-input mt-1.5 h-11 rounded-xl px-3 text-[13px]"
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.target.value);
                setError(null);
              }}
              maxLength={100}
              required
            />
          </label>

          <label className="block text-[11.5px] font-semibold text-navy-700">
            อีเมล
            <input className="s2-input mt-1.5 h-11 rounded-xl px-3 text-[13px]" value={user.email} readOnly disabled />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10.5px] text-navy-400">บทบาท</p>
              <p className="mt-1 text-[12px] font-medium text-navy-700">{user.roles.join(', ') || '—'}</p>
            </div>
            <div>
              <p className="text-[10.5px] text-navy-400">สถานะ</p>
              <p className="mt-1 text-[12px] font-medium text-navy-700">{userStatusLabel(user.status)}</p>
            </div>
          </div>

          {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-[11.5px] text-red-700">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="s2-btn s2-btn-ghost">ยกเลิก</button>
            <button type="submit" className="s2-btn s2-btn-primary" disabled={save.isPending || !displayName.trim()}>
              {save.isPending ? 'กำลังบันทึก…' : 'บันทึกการเปลี่ยนแปลง'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
