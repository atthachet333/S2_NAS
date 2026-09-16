import { useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Clock, HardDrive, LayoutDashboard, MoreHorizontal, Search, Server, Share2, Star, Trash2, Upload,
  type LucideIcon,
} from 'lucide-react';
import { MY_DRIVE_LABEL, SYSTEM_DRIVE_LABEL } from '@/lib/drive-labels';
import { Sheet, SheetItem } from '@/components/ui/Sheet';
import { MobileUploadSheet } from '@/components/files/MobileUploadSheet';
import { InstallOption } from '@/components/pwa/InstallOption';
import { cn } from '@/lib/utils';

/**
 * แถบนำทางล่างสำหรับโทรศัพท์ (F24-C)
 *
 * **ทำไมต้องมี ทั้งที่มี TopNav อยู่แล้ว:** TopNav มีเจ็ดปลายทางเรียงกันในแถบที่เลื่อนได้
 * บนจอ 375px ผู้ใช้เห็นสามปลายทางแรกและไม่มีอะไรบอกว่ายังมีอีกสี่อันซ่อนอยู่ทางขวา
 * ปลายทางที่ต้องเลื่อนไปหาคือปลายทางที่คนไม่ใช้
 *
 * **ทำไมสี่ปุ่มกับ "เพิ่มเติม" ไม่ใช่เจ็ดปุ่ม:** ความกว้างนิ้วราว 44px คูณเจ็ดคือ 308px
 * ซึ่งไม่เหลือที่ให้ป้ายกำกับอ่านออกบนจอ 320px ปลายทางที่ใช้บ่อยจึงอยู่ในแถบ
 * ส่วนที่เหลืออยู่ในแผ่น "เพิ่มเติม" ที่ยังเข้าถึงได้ครบ
 *
 * **อัปโหลดเป็นปุ่มกระทำ ไม่ใช่ปลายทาง** เพราะเป็นงานที่ผู้ใช้มาทำบนมือถือบ่อยที่สุด
 * และเดิมมันถูกซ่อนอยู่ในเมนู "+ ใหม่" ซึ่งบนมือถือแสดงเป็นไอคอนบวกเล็ก ๆ เท่านั้น
 */
interface NavDestination {
  label: string;
  to: string;
  icon: LucideIcon;
}

/** ปลายทางในแถบล่าง - เฉพาะที่ใช้บ่อยจริง ไม่มีของผู้ดูแลระบบ */
const PRIMARY: NavDestination[] = [
  { label: 'ไฟล์', to: '/files', icon: HardDrive },
  { label: 'ค้นหา', to: '/search', icon: Search },
];

const SECONDARY: NavDestination[] = [
  { label: 'ล่าสุด', to: '/recent', icon: Clock },
];

/** ปลายทางที่เหลือ เข้าถึงผ่านแผ่น "เพิ่มเติม" */
const MORE: NavDestination[] = [
  { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
  { label: MY_DRIVE_LABEL, to: '/files', icon: HardDrive },
  { label: SYSTEM_DRIVE_LABEL, to: '/system-drive', icon: Server },
  { label: 'แชร์กับฉัน', to: '/shared', icon: Share2 },
  { label: 'รายการโปรด', to: '/favorites', icon: Star },
  { label: 'ถังขยะ', to: '/trash', icon: Trash2 },
];

/** เส้นทางที่รองรับการอัปโหลดเข้าโฟลเดอร์ปัจจุบัน */
export function isUploadCapableRoute(pathname: string): boolean {
  return pathname.startsWith('/files') || pathname.startsWith('/system-drive');
}

export function MobileNav() {
  const [moreOpen, setMoreOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  /**
   * การอัปโหลดต้องมีโฟลเดอร์ปลายทาง หน้าที่รู้จักปลายทางคือหน้าไดร์ฟ
   * ถ้าผู้ใช้กดจากหน้าอื่น จึงพาไปที่ไดร์ฟก่อน แล้วค่อยเปิดตัวเลือกการอัปโหลด
   */
  const openUpload = () => {
    if (!isUploadCapableRoute(location.pathname)) navigate('/files');
    setUploadOpen(true);
  };

  return (
    <>
      <nav
        aria-label="นำทางหลัก"
        className="s2-header-bar fixed inset-x-0 bottom-0 z-[var(--z-header)] border-t border-line md:hidden"
        // แถบบ้านของ iPhone กินพื้นที่ขอบล่าง ปุ่มต้องไม่ไปอยู่ใต้มัน
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <ul className="flex items-stretch justify-around px-1">
          {PRIMARY.map((item) => <NavButton key={item.to} item={item} />)}

          <li className="flex">
            <button
              type="button"
              onClick={openUpload}
              aria-label="อัปโหลด"
              className="flex min-h-[56px] min-w-[56px] flex-col items-center justify-center gap-0.5 px-2 py-1.5 text-[10.5px] text-navy-500"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--s2-primary)] text-white shadow-[0_4px_12px_color-mix(in_srgb,var(--s2-primary)_28%,transparent)]">
                <Upload className="h-4 w-4" aria-hidden />
              </span>
              อัปโหลด
            </button>
          </li>

          {SECONDARY.map((item) => <NavButton key={item.to} item={item} />)}

          <li className="flex">
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-label="เพิ่มเติม"
              aria-haspopup="dialog"
              className="flex min-h-[56px] min-w-[56px] flex-col items-center justify-center gap-0.5 px-2 py-1.5 text-[10.5px] text-navy-500"
            >
              <MoreHorizontal className="h-[18px] w-[18px]" aria-hidden />
              เพิ่มเติม
            </button>
          </li>
        </ul>
      </nav>

      <Sheet open={moreOpen} title="ไปยัง" onClose={() => setMoreOpen(false)}>
        {/* การติดตั้งอยู่ท้ายเมนู ไม่แย่งช่องในแถบนำทางที่ใช้ทุกวัน */}
        {MORE.map((item) => (
          <SheetItem
            key={item.label}
            icon={<item.icon className="h-4 w-4" />}
            label={item.label}
            onSelect={() => { setMoreOpen(false); navigate(item.to); }}
          />
        ))}
        <InstallOption onDone={() => setMoreOpen(false)} />
      </Sheet>

      <MobileUploadSheet open={uploadOpen} onClose={() => setUploadOpen(false)} />
    </>
  );
}

function NavButton({ item }: { item: NavDestination }) {
  return (
    <li className="flex">
      <NavLink
        to={item.to}
        className={({ isActive }) =>
          cn(
            // 56px สูงพอให้นิ้วแตะได้โดยไม่ต้องเล็ง และกว้างพอสำหรับป้ายภาษาไทย
            'flex min-h-[56px] min-w-[56px] flex-col items-center justify-center gap-0.5 px-2 py-1.5 text-[10.5px] transition-colors',
            isActive ? 'font-medium text-brand-700' : 'text-navy-500',
          )
        }
      >
        {({ isActive }) => (
          <>
            <item.icon className={cn('h-[18px] w-[18px]', isActive && 'text-brand-600')} aria-hidden />
            {item.label}
          </>
        )}
      </NavLink>
    </li>
  );
}
