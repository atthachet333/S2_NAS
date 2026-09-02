import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Search } from 'lucide-react';
import { NewMenu } from './NewMenu';
import { UserMenu } from './UserMenu';
import { BrandLogo } from './BrandLogo';
import { ServerStatus } from './ServerStatus';
import { ThemeControl } from './ThemeControl';

/**
 * Header หลัก
 * ซ้าย: แบรนด์ | กลาง: ค้นหา | ขวา: ปุ่มใหม่, สถานะเซิร์ฟเวอร์, แจ้งเตือน, ผู้ใช้
 */
export function TopHeader({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // ทางลัด "/" เพื่อโฟกัสช่องค้นหา แบบเดียวกับเครื่องมือจัดการไฟล์ทั่วไป
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typingInField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;

      if (event.key === '/' && !typingInField) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <header className="s2-header-bar border-b border-line">
      <div className="mx-auto flex h-16 max-w-[1680px] items-center gap-3 px-4 lg:gap-5 lg:px-8">
        <Link to="/dashboard" className="flex shrink-0 items-center" aria-label="S2 NAS หน้าแรก">
          <BrandLogo size={36} />
        </Link>

        <div className="relative mx-auto hidden w-full max-w-2xl sm:block">
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-navy-300"
            aria-hidden
          />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="ค้นหาไฟล์ โฟลเดอร์ ลิงก์ หรือทรัพยากร..."
            aria-label="ค้นหาไฟล์และโฟลเดอร์"
            className="s2-input h-10 rounded-[12px] pl-10 pr-12 text-[13px] placeholder:text-navy-300"
          />
          <span className="s2-kbd pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">/</span>
        </div>

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
