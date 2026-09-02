import { NavLink } from 'react-router-dom';
import { Clock, HardDrive, LayoutDashboard, Share2, Star, Trash2, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavTab {
  label: string;
  to: string;
  icon: LucideIcon;
}

const TABS: NavTab[] = [
  { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
  { label: 'ไดร์ฟของฉัน', to: '/files', icon: HardDrive },
  { label: 'แชร์กับฉัน', to: '/shared', icon: Share2 },
  { label: 'ล่าสุด', to: '/recent', icon: Clock },
  { label: 'รายการโปรด', to: '/favorites', icon: Star },
  { label: 'ถังขยะ', to: '/trash', icon: Trash2 },
];

/** แถบนำทางหลักใต้ header แทนการใช้ sidebar ถาวร */
export function TopNav() {
  return (
    <nav className="s2-nav-bar border-b border-line" aria-label="พื้นที่ไฟล์">
      <ul className="mx-auto flex w-full min-w-0 max-w-[1680px] items-center gap-1 overflow-x-auto px-4 [scrollbar-width:none] lg:justify-center lg:px-8 [&::-webkit-scrollbar]:hidden">
        {TABS.map((tab) => (
          <li key={tab.to}>
            <NavLink
              to={tab.to}
              className={({ isActive }) =>
                cn(
                  'relative flex h-11 items-center gap-2 whitespace-nowrap px-3.5 text-[12.5px] transition-colors',
                  isActive
                    ? 'font-medium text-brand-700 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand-600'
                    : 'text-navy-500 hover:text-navy-800',
                )
              }
            >
              <tab.icon className="h-4 w-4" aria-hidden />
              {tab.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
