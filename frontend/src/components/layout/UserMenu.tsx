import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronDown, KeyRound, LogOut, Monitor, Moon, ShieldCheck, Sun, UserRound } from 'lucide-react';
import { MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { AnchoredMenu } from '@/components/ui/AnchoredMenu';
import { useToast } from '@/hooks/useToast';
import { useAuth } from '@/hooks/useAuth';
import { useTheme, type ThemePreference } from '@/hooks/useTheme';
import { OwnerAvatar } from '@/components/files/OwnerIdentity';

/**
 * เมนูบัญชีผู้ใช้
 *
 * ทางเข้าเดียวของ Admin Area เพื่อไม่ให้ปนกับการใช้งานไฟล์
 * ยึดใต้ปุ่ม avatar โดยตรง กว้างคงที่ และแบ่งกลุ่มด้วยหัวข้อสั้น ๆ
 */
export function UserMenu() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { notify } = useToast();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { preference, setPreference } = useTheme();

  const isAdmin = Boolean(user?.permissions.includes('admin:access'));

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${user?.displayName ?? 'ผู้ใช้'} ${user?.roles.join(', ') ?? ''}`.trim()}
        className="flex h-9 items-center gap-2 rounded-[10px] pl-1 pr-1.5 transition-colors hover:bg-navy-50"
      >
        <OwnerAvatar owner={{ displayName: user?.displayName, email: user?.email }} size="md" />
        <span className="hidden max-w-[120px] text-left leading-tight xl:block">
          <span className="block truncate text-[12.5px] font-semibold text-navy-800">{user?.displayName}</span>
          <span className="block truncate text-[10px] text-navy-400">{user?.roles.join(', ')}</span>
        </span>
        <ChevronDown className="hidden h-3.5 w-3.5 text-navy-400 xl:block" aria-hidden />
      </button>

      <AnchoredMenu
        anchorRef={buttonRef}
        open={open}
        onClose={() => setOpen(false)}
        width={236}
        label="เมนูบัญชีผู้ใช้"
      >
        <>
          <div className="flex items-center gap-2.5 border-b border-line px-2.5 pb-2.5 pt-1.5">
            <OwnerAvatar owner={{ displayName: user?.displayName, email: user?.email }} size="md" />
            <div className="min-w-0">
              <p className="truncate text-[12.5px] font-semibold text-navy-800">{user?.displayName}</p>
              <p className="truncate text-[10.5px] text-navy-400">{user?.email}</p>
            </div>
          </div>

          <p className="s2-section-title px-2.5 pb-1 pt-2">บัญชี</p>
          <MenuItem icon={<UserRound className="h-4 w-4" />} label="โปรไฟล์" disabled onSelect={() => undefined} />
          <MenuItem
            icon={<KeyRound className="h-4 w-4" />}
            label="เปลี่ยนรหัสผ่าน"
            onSelect={() => {
              setOpen(false);
              window.dispatchEvent(new Event('s2-open-password-dialog'));
            }}
          />

          {/* สลับธีมบนจอเล็ก ซึ่งไม่มีปุ่มธีมบน header */}
          <div className="px-2.5 py-2 sm:hidden">
            <p className="s2-section-title pb-1.5">ธีม</p>
            <div className="grid grid-cols-3 gap-1">
              {(
                [
                  ['light', Sun],
                  ['dark', Moon],
                  ['system', Monitor],
                ] as [ThemePreference, typeof Sun][]
              ).map(([value, Icon]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setPreference(value)}
                  aria-label={`ธีม ${value}`}
                  aria-pressed={preference === value}
                  className={
                    preference === value
                      ? 'flex justify-center rounded-lg bg-brand-50 p-1.5 text-brand-600'
                      : 'flex justify-center rounded-lg p-1.5 text-navy-400 hover:bg-navy-50'
                  }
                >
                  <Icon className="h-4 w-4" />
                </button>
              ))}
            </div>
          </div>

          {isAdmin ? (
            <>
              <MenuSeparator />
              <p className="s2-section-title px-2.5 pb-1">ระบบ</p>
              <Link to="/admin" className="s2-menu-item" role="menuitem" onClick={() => setOpen(false)}>
                <span className="shrink-0 text-navy-400">
                  <ShieldCheck className="h-4 w-4" />
                </span>
                <span className="flex-1">จัดการระบบ</span>
              </Link>
            </>
          ) : null}

          <MenuSeparator />
          <MenuItem
            icon={<LogOut className="h-4 w-4" />}
            label="ออกจากระบบ"
            danger
            onSelect={() => {
              setOpen(false);
              void logout().then(() => {
                notify({ tone: 'success', title: 'ออกจากระบบแล้ว' });
                navigate('/login', { replace: true });
              });
            }}
          />
        </>
      </AnchoredMenu>
    </>
  );
}
