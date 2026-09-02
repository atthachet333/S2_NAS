import { Link, NavLink, Outlet } from 'react-router-dom';
import { ArrowLeft, Database, HardDrive, Plug, ScrollText, Settings, ShieldCheck, UserCog, Users } from 'lucide-react';
import { ServerStatus } from './ServerStatus';
import { ThemeControl } from './ThemeControl';
import { UserMenu } from './UserMenu';
import { cn } from '@/lib/utils';

const ADMIN_NAV = [
  { label: 'ผู้ใช้งาน', to: '/admin/users', icon: Users },
  { label: 'สิทธิ์', to: '/admin/permissions', icon: ShieldCheck },
  { label: 'Ownership', to: '/admin/ownership', icon: UserCog },
  { label: 'Activity Log', to: '/admin/activity', icon: ScrollText },
  { label: 'Storage', to: '/admin/storage', icon: HardDrive },
  { label: 'Backup', to: '/admin/backup', icon: Database },
  { label: 'Connected Apps', to: '/admin/integrations', icon: Plug },
  { label: 'ตั้งค่า', to: '/admin/settings', icon: Settings },
];

/**
 * Admin Area แยกออกจากพื้นที่ไฟล์อย่างชัดเจน
 * ที่นี่ใช้ side navigation ได้ แต่พื้นที่ไฟล์หลักห้ามมี sidebar
 */
export function AdminShell() {
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="s2-glass sticky top-0 z-30 border-b">
        <div className="flex h-[68px] items-center gap-3 px-4 lg:px-7">
          <Link
            to="/files"
            className="s2-btn s2-btn-ghost gap-1.5 px-2 text-[12.5px]"
            aria-label="กลับไปยังไฟล์"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">กลับไปยังไฟล์</span>
          </Link>
          <div className="mx-2 hidden h-6 w-px bg-line sm:block" />
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#14213d] text-[11px] font-bold text-white">S2</span>
          <div className="hidden sm:block"><p className="text-[13.5px] font-semibold text-navy-900">จัดการระบบ</p><p className="text-[10px] text-navy-400">S2 NAS Administration</p></div>
          <span className="ml-auto hidden sm:block"><ServerStatus /></span><ThemeControl compact /><UserMenu />
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1540px] flex-1 flex-col gap-6 px-4 py-6 lg:flex-row lg:px-7">
        <nav className="rounded-2xl border border-line bg-surface p-2 shadow-subtle lg:w-60 lg:shrink-0 lg:self-start" aria-label="เมนูผู้ดูแลระบบ">
          <p className="hidden px-3 pb-2 pt-2 text-[10px] font-semibold uppercase tracking-[.16em] text-navy-300 lg:block">Management</p><ul className="flex gap-1 overflow-x-auto lg:flex-col lg:gap-1">
            {ADMIN_NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2.5 whitespace-nowrap rounded-xl px-3 py-2.5 text-[12.5px] transition-colors',
                      isActive
                        ? 'bg-brand-50 font-medium text-brand-700'
                        : 'text-navy-500 hover:bg-navy-50 hover:text-navy-800',
                    )
                  }
                >
                  <item.icon className="h-4 w-4" aria-hidden />
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
