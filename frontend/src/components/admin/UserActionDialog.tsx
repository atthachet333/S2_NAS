import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Eye, EyeOff, KeyRound, ShieldCheck, UserCheck, UserX, X } from 'lucide-react';
import { ApiError, usersApi, type PublicUser } from '@/lib/api';
import { useToast } from '@/hooks/useToast';

export type UserDialogMode = 'activate' | 'reset-password' | 'disable' | 'roles';

const MIN_PASSWORD_LENGTH = 12;

const ERROR_TEXT: Record<string, string> = {
  WEAK_PASSWORD: 'รหัสผ่านไม่ผ่านเกณฑ์ความปลอดภัย',
  USER_ALREADY_ACTIVE: 'บัญชีนี้เปิดใช้งานอยู่แล้ว',
  USER_NOT_FOUND: 'ไม่พบผู้ใช้รายนี้แล้ว',
  ROLE_NOT_FOUND: 'ไม่พบบทบาทที่เลือก',
  LAST_SUPER_ADMIN: 'ต้องเหลือผู้ดูแลสูงสุดที่เปิดใช้งานอย่างน้อยหนึ่งคน',
  CANNOT_DISABLE_SELF: 'ปิดการใช้งานบัญชีของตัวเองไม่ได้',
};

const TITLES: Record<UserDialogMode, string> = {
  activate: 'เปิดใช้งานบัญชี',
  'reset-password': 'ตั้งรหัสผ่านชั่วคราวใหม่',
  disable: 'ปิดการใช้งานบัญชี',
  roles: 'เปลี่ยนบทบาท',
};

/**
 * กล่องดำเนินการกับบัญชีผู้ใช้
 *
 * รหัสผ่านชั่วคราวถูกส่งไปเซิร์ฟเวอร์ครั้งเดียวแล้วหายไปจากหน้าจอทันที
 * ระบบไม่มีเส้นทางอ่านรหัสกลับมาอีก ผู้ดูแลจึงต้องส่งต่อให้เจ้าตัวเองในตอนนั้น
 */
export function UserActionDialog({
  mode,
  user,
  onClose,
}: {
  mode: UserDialogMode;
  user: PublicUser;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { notify } = useToast();
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const [roleCodes, setRoleCodes] = useState<string[]>(user.roles.map((link) => link.role.code));
  const [error, setError] = useState<string | null>(null);
  const [owned, setOwned] = useState<{ ownedTotal: number; ownedFolders: number } | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => { firstRef.current?.focus(); }, []);

  const roles = useQuery({ queryKey: ['roles'], queryFn: usersApi.roles, enabled: mode === 'roles' });

  const run = useMutation({
    mutationFn: async () => {
      if (mode === 'activate') return usersApi.activate(user.id, password);
      if (mode === 'reset-password') return usersApi.resetPassword(user.id, password);
      if (mode === 'disable') return usersApi.disable(user.id, acknowledge);
      return usersApi.changeRoles(user.id, roleCodes);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void queryClient.invalidateQueries({ queryKey: ['handover-overview'] });
      notify({
        tone: 'success',
        title:
          mode === 'activate'
            ? `เปิดใช้งาน ${user.displayName} แล้ว`
            : mode === 'reset-password'
              ? 'ตั้งรหัสผ่านชั่วคราวใหม่แล้ว'
              : mode === 'disable'
                ? `ปิดการใช้งาน ${user.displayName} แล้ว`
                : 'เปลี่ยนบทบาทแล้ว',
      });
      // ล้างรหัสออกจากหน่วยความจำของหน้าทันทีที่ใช้เสร็จ
      setPassword('');
      onClose();
    },
    onError: (reason) => {
      if (reason instanceof ApiError && reason.code === 'USER_STILL_OWNS_RESOURCES') {
        const details = reason.details as { ownedTotal?: number; ownedFolders?: number } | undefined;
        setOwned({ ownedTotal: details?.ownedTotal ?? 0, ownedFolders: details?.ownedFolders ?? 0 });
        setError(null);
        return;
      }
      setError(reason instanceof ApiError ? ERROR_TEXT[reason.code] ?? reason.message : 'ดำเนินการไม่สำเร็จ');
    },
  });

  const needsPassword = mode === 'activate' || mode === 'reset-password';
  const passwordTooShort = needsPassword && password.length < MIN_PASSWORD_LENGTH;

  const Icon =
    mode === 'activate' ? UserCheck : mode === 'reset-password' ? KeyRound : mode === 'disable' ? UserX : ShieldCheck;

  return (
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-[var(--s2-overlay)] p-3 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-dialog-title"
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl border border-line bg-[var(--s2-elevated)] p-5 shadow-pop sm:p-6"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
            <Icon className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="user-dialog-title" className="text-[16px] font-semibold text-navy-900">{TITLES[mode]}</h2>
            <p className="mt-1 truncate text-[11px] text-navy-400">{user.displayName} · {user.email}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="ปิด" className="rounded-lg p-1.5 text-navy-400 hover:bg-navy-50">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            run.mutate();
          }}
        >
          {needsPassword ? (
            <>
              <label className="block text-[11.5px] font-semibold text-navy-700">
                รหัสผ่านชั่วคราว
                <span className="relative mt-1.5 block">
                  <input
                    ref={firstRef}
                    type={revealed ? 'text' : 'password'}
                    className="s2-input h-11 rounded-xl px-3 pr-11 text-[13px]"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setError(null);
                    }}
                    autoComplete="new-password"
                    minLength={MIN_PASSWORD_LENGTH}
                    maxLength={200}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setRevealed((value) => !value)}
                    aria-label={revealed ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-navy-400 hover:bg-navy-50"
                  >
                    {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </span>
              </label>

              <ul className="space-y-1 text-[11px] leading-relaxed text-navy-400">
                <li>ยาวอย่างน้อย {MIN_PASSWORD_LENGTH} ตัวอักษร และมีอักขระอย่างน้อยสองประเภท</li>
                <li>ผู้ใช้จะถูกบังคับให้เปลี่ยนรหัสผ่านทันทีที่เข้าสู่ระบบครั้งแรก</li>
                <li>
                  ระบบเก็บเฉพาะค่า hash และไม่แสดงรหัสนี้อีกหลังกดยืนยัน
                  ต้องแจ้งเจ้าของบัญชีด้วยช่องทางที่ปลอดภัยเอง
                </li>
              </ul>
            </>
          ) : null}

          {mode === 'disable' ? (
            owned ? (
              <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                  <div className="text-[12px] leading-relaxed text-amber-700">
                    <p className="font-semibold">ผู้ใช้นี้ยังเป็นผู้ดูแลทรัพยากรอยู่</p>
                    <p className="mt-1">
                      ถือทรัพยากรอยู่ {owned.ownedTotal} รายการ ({owned.ownedFolders} โฟลเดอร์)
                      ถ้าปิดบัญชีโดยไม่ส่งมอบ เอกสารจะตกอยู่กับบัญชีที่เข้าใช้งานไม่ได้
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  className="s2-btn s2-btn-outline w-full"
                  onClick={() => {
                    onClose();
                    navigate('/admin/ownership');
                  }}
                >
                  ไปที่การส่งมอบความรับผิดชอบ
                </button>

                <label className="flex items-start gap-2 text-[11.5px] text-amber-700">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={acknowledge}
                    onChange={(event) => setAcknowledge(event.target.checked)}
                  />
                  รับทราบว่าทรัพยากรจะยังอยู่กับบัญชีนี้ และยืนยันปิดการใช้งาน
                </label>
              </div>
            ) : (
              <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-[12px] leading-relaxed text-amber-700">
                ผู้ใช้จะเข้าสู่ระบบไม่ได้อีก session ที่เปิดอยู่จะถูกตัดทันที
                และจะไม่สามารถรับการแชร์ทรัพยากรใหม่ได้
              </p>
            )
          ) : null}

          {mode === 'roles' ? (
            <fieldset>
              <legend className="text-[11.5px] font-semibold text-navy-700">บทบาทในระบบ</legend>
              <div className="mt-2 space-y-1.5">
                {(roles.data?.data ?? []).map((role) => (
                  <label key={role.id} className="flex items-center gap-2 text-[12.5px] text-navy-700">
                    <input
                      type="checkbox"
                      checked={roleCodes.includes(role.code)}
                      onChange={(event) =>
                        setRoleCodes((current) =>
                          event.target.checked
                            ? [...current, role.code]
                            : current.filter((code) => code !== role.code),
                        )
                      }
                    />
                    <span className="font-medium">{role.code}</span>
                    <span className="text-[11px] text-navy-400">{role.name}</span>
                  </label>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-navy-400">
                เปลี่ยนบทบาทแล้ว session ที่เปิดอยู่ของผู้ใช้รายนี้จะถูกตัด
                เพราะสิทธิ์ที่ฝังอยู่ใน token เดิมไม่ตรงกับบทบาทใหม่แล้ว
              </p>
            </fieldset>
          ) : null}

          {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-[11.5px] text-red-700">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="s2-btn s2-btn-ghost">ยกเลิก</button>
            <button
              type="submit"
              disabled={
                run.isPending ||
                passwordTooShort ||
                (mode === 'roles' && roleCodes.length === 0) ||
                (mode === 'disable' && owned !== null && !acknowledge)
              }
              className={mode === 'disable' ? 's2-btn border border-red-200 bg-red-600 text-white' : 's2-btn s2-btn-primary'}
            >
              {run.isPending ? 'กำลังดำเนินการ…' : TITLES[mode]}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
