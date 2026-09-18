import { Link, useNavigate } from 'react-router-dom';
import { LogIn, Lock, ShieldX } from 'lucide-react';
import { BrandLogo } from '@/components/layout/BrandLogo';
import { ThemeControl } from '@/components/layout/ThemeControl';
import { useAuth } from '@/hooks/useAuth';
import { loginPathFor } from '@/lib/return-to';

/**
 * หน้ากั้นของ Link Lock - สองสถานะที่ต้องไม่ปนกัน
 *
 * BLOCKED       = ยังไม่ได้เข้าสู่ระบบ ทางออกคือเข้าสู่ระบบ
 * ACCESS DENIED = เข้าสู่ระบบแล้วแต่บัญชีนี้ไม่มีสิทธิ์ ทางออกคือติดต่อผู้ดูแล
 *
 * แยกกันเพราะผู้ใช้ต้องทำคนละอย่าง การรวมเป็นหน้าเดียวจะบอกทางออกที่ผิดให้คนครึ่งหนึ่ง
 *
 * **ไม่มีข้อมูลของเอกสารปรากฏบนหน้านี้เลย** ไม่มีชื่อไฟล์ ไม่มีชื่อโฟลเดอร์ ไม่มีขนาด
 * ไม่มีชนิด และไม่มีเนื้อหาเบลอ ๆ อยู่ด้านหลัง - เพราะหน้านี้ถูกแสดงตอนที่เซิร์ฟเวอร์
 * ยังไม่ยอมบอกอะไรเลย ถ้าหน้าจอแสดงอะไรได้มากกว่านั้น แปลว่ามันได้ข้อมูลมาจากที่อื่น
 * ซึ่งก็คือรูรั่วที่เฟสนี้ตั้งใจปิด
 */

export type LinkLockState = 'BLOCKED' | 'ACCESS_DENIED';

export function LinkLockedPage({
  state,
  returnTo,
}: {
  state: LinkLockState;
  /** ที่ที่ผู้ใช้ตั้งใจจะไป - ถูกทำให้ปลอดภัยก่อนใช้เสมอ ดู return-to.ts */
  returnTo?: string | null;
}) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const blocked = state === 'BLOCKED';

  return (
    <div className="flex min-h-[100dvh] flex-col bg-canvas">
      <header className="flex items-center justify-between px-4 py-4 lg:px-7">
        <Link to="/" className="flex items-center gap-2.5" aria-label="S2 NAS หน้าแรก">
          <BrandLogo size={32} />
          <span className="text-[13px] font-semibold text-navy-900">S2 NAS</span>
        </Link>
        <ThemeControl compact />
      </header>

      <main className="flex flex-1 items-center justify-center px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <div className="w-full max-w-md text-center">
          <div
            className={`mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border ${
              blocked
                ? 'border-brand-200 bg-brand-50 text-brand-600'
                : 'border-rose-200 bg-rose-50 text-rose-600'
            }`}
          >
            {blocked ? <Lock className="h-7 w-7" aria-hidden /> : <ShieldX className="h-7 w-7" aria-hidden />}
          </div>

          {/*
            ข้อความหลักเป็นภาษาอังกฤษตัวใหญ่ตามที่กำหนด - อ่านออกทันทีโดยไม่ต้องอ่านรายละเอียด
            ขนาดปรับตามความกว้างจอ เพื่อไม่ให้ล้นบนเครื่อง 320px
          */}
          <h1 className="mt-5 text-[34px] font-bold leading-none tracking-tight text-navy-900 sm:text-[42px]">
            {blocked ? 'BLOCKED' : 'ACCESS DENIED'}
          </h1>

          <div className="mt-4 space-y-1.5 text-[13.5px] leading-relaxed text-navy-600">
            {blocked ? (
              <>
                <p>กรุณาเข้าสู่ระบบเพื่อเข้าถึงเอกสารนี้</p>
                <p>เอกสารนี้อนุญาตเฉพาะผู้ใช้งานที่ได้รับสิทธิ์เท่านั้น</p>
              </>
            ) : (
              <>
                <p>บัญชีนี้ไม่มีสิทธิ์เข้าถึงเอกสาร</p>
                <p>กรุณาติดต่อผู้ดูแลระบบ</p>
              </>
            )}
          </div>

          <div className="mt-7 flex flex-col gap-2.5">
            {blocked ? (
              <button
                type="button"
                onClick={() => navigate(loginPathFor(returnTo))}
                className="s2-btn s2-btn-primary min-h-11 w-full gap-2 text-[13px]"
              >
                <LogIn className="h-4 w-4" aria-hidden />
                เข้าสู่ระบบ
              </button>
            ) : null}

            <Link to="/" className="s2-btn s2-btn-outline min-h-11 w-full text-[13px]">
              กลับหน้าหลัก
            </Link>

            {/*
              ทางออกที่สองของผู้ที่ล็อกอินผิดบัญชี - พบบ่อยเมื่อเครื่องหนึ่งใช้หลายคน
              ไม่แสดงตอน BLOCKED เพราะยังไม่มีบัญชีให้เปลี่ยน
            */}
            {!blocked && user ? (
              <button
                type="button"
                onClick={() => void logout()}
                className="s2-btn s2-btn-ghost min-h-11 w-full text-[13px]"
              >
                เปลี่ยนบัญชี
              </button>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}
