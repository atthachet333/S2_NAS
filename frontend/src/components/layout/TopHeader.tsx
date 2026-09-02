import { Link } from 'react-router-dom';
import { Bell, Search } from 'lucide-react';
import { GlobalSearch } from './GlobalSearch';
import { NewMenu } from './NewMenu';
import { UserMenu } from './UserMenu';
import { BrandLogo } from './BrandLogo';
import { ServerStatus } from './ServerStatus';
import { ThemeControl } from './ThemeControl';

/**
 * Header หลัก
 * ซ้าย: แบรนด์ | กลาง: ค้นหา | ขวา: ปุ่มใหม่, สถานะเซิร์ฟเวอร์, แจ้งเตือน, ผู้ใช้
 */
export function TopHeader() {
  return (
    <header className="s2-header-bar border-b border-line">
      <div className="mx-auto flex h-16 max-w-[1680px] items-center gap-3 px-4 lg:gap-5 lg:px-8">
        <Link to="/dashboard" className="flex shrink-0 items-center" aria-label="S2 NAS หน้าแรก">
          <BrandLogo size={36} />
        </Link>

        <GlobalSearch />

        <div className="flex shrink-0 items-center gap-1.5">
          <NewMenu />

          <div className="hidden lg:block">
            <ServerStatus />
          </div>

          {/* ตัวควบคุมรองใช้ขนาดเท่ากันทั้งหมด 36px เพื่อให้แถบขวาไม่ดูแน่น */}
          <div className="hidden items-center gap-1 sm:flex">
            <ThemeControl compact />
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-[10px] text-navy-400 transition-colors hover:bg-navy-50 hover:text-navy-700"
              aria-label="การแจ้งเตือน"
            >
              <Bell className="h-[17px] w-[17px]" />
            </button>
          </div>

          <span className="mx-0.5 hidden h-6 w-px bg-line sm:block" aria-hidden />

          <UserMenu />

          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-[10px] text-navy-500 sm:hidden"
            aria-label="ค้นหา"
          >
            <Search className="h-5 w-5" />
          </button>
        </div>
      </div>
    </header>
  );
}
