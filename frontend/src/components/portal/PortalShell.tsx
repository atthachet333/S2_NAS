import { Link, NavLink, Outlet } from 'react-router-dom';
import { History, LogOut } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { ThemeControl } from '@/components/layout/ThemeControl';

/**
 * โครงหน้าของพื้นที่เอกสารสำหรับลูกค้า
 *
 * จงใจไม่ใช้ AppShell ของฝั่งภายในเลย แม้จะดูคล้ายกัน
 * เพราะ AppShell มีเมนู ไดร์ฟ ถังขยะ การค้นหาทั้งระบบ และเมนูผู้ดูแลติดมาด้วย
 * การ "ซ่อนเมนูตามสิทธิ์" ในโครงเดียวกันคือรูปแบบที่พลาดครั้งเดียวแล้วรั่วถาวร
 * ที่นี่จึงไม่มีอะไรให้ซ่อน เพราะไม่เคยมีอยู่ตั้งแต่แรก
 */
export function PortalShell() {
  const { user, logout } = useAuth();

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="s2-glass sticky top-0 z-30 border-b">
        <div className="mx-auto flex h-[68px] w-full max-w-[1180px] items-center gap-3 px-4 lg:px-7">
          <Link to="/portal" className="flex items-center gap-3" aria-label="กลับไปหน้าแรกของพื้นที่เอกสาร">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#14213d] text-[11px] font-bold text-white">
              S2
            </span>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-semibold text-navy-900">S2 NAS</span>
              <span className="block truncate text-[10px] text-navy-400">พื้นที่เอกสารสำหรับลูกค้า</span>
            </span>
          </Link>

          {/*
            ลิงก์เดียวที่มีในพื้นที่นี้ - ไม่ใช่แถบเมนู
            พื้นที่ลูกค้ามีสองหน้าเท่านั้น การใส่โครงเมนูเต็มรูปแบบจะเกินความจำเป็น
          */}
          <NavLink
            to="/portal/uploads"
            className={({ isActive }) =>
              isActive
                ? 'ml-3 hidden items-center gap-1.5 rounded-lg bg-brand-50 px-2.5 py-1.5 text-[12px] font-medium text-brand-700 sm:flex'
                : 'ml-3 hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-navy-500 hover:bg-navy-50 sm:flex'
            }
          >
            <History className="h-3.5 w-3.5" aria-hidden />
            ประวัติการอัปโหลด
          </NavLink>

          <div className="ml-auto flex items-center gap-2">
            {/* ตัวตนของผู้ใช้เอง ไม่ใช่รายชื่อผู้ใช้ของระบบ */}
            <span className="hidden min-w-0 text-right sm:block">
              <span className="block truncate text-[12px] font-medium text-navy-800">{user?.displayName}</span>
              <span className="block truncate text-[10px] text-navy-400">{user?.email}</span>
            </span>
            <ThemeControl compact />
            <button
              type="button"
              onClick={() => void logout()}
              className="s2-btn s2-btn-ghost gap-1.5 px-2 text-[12.5px]"
            >
              <LogOut className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">ออกจากระบบ</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1180px] flex-1 px-4 py-6 lg:px-7">
        <Outlet />
      </main>

      <footer className="border-t border-line px-4 py-4 text-center text-[10.5px] text-navy-300 lg:px-7">
        S2 NAS · หากต้องการสิทธิ์เข้าถึงเอกสารเพิ่มเติม กรุณาติดต่อผู้ดูแลของบริษัท
      </footer>
    </div>
  );
}
