import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Cable, Check, Eye, EyeOff, History, Loader2, Lock, Mail, Server, ShieldCheck } from 'lucide-react';
import { BrandLogo } from '@/components/layout/BrandLogo';
import { ServerStatus } from '@/components/layout/ServerStatus';
import { ThemeControl } from '@/components/layout/ThemeControl';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';
import { googleLoginMessage, startGoogleLogin } from '@/lib/google-login';
import { homePathFor } from '@/lib/portal';
import { useToast } from '@/hooks/useToast';

const schema = z.object({ email: z.string().min(1, 'กรุณากรอกอีเมล').email('รูปแบบอีเมลไม่ถูกต้อง'), password: z.string().min(1, 'กรุณากรอกรหัสผ่าน') });
type LoginForm = z.infer<typeof schema>;

const benefits = [
  { icon: Server, title: 'พื้นที่จัดเก็บขององค์กร', detail: 'ไฟล์อยู่บน Server ที่บริษัทควบคุม' },
  { icon: ShieldCheck, title: 'ควบคุมสิทธิ์', detail: 'จัดการการเข้าถึงอย่างเป็นระบบ' },
  { icon: History, title: 'ตรวจสอบย้อนหลัง', detail: 'เตรียมพร้อมสำหรับ Version และ Audit' },
  { icon: Cable, title: 'เชื่อมต่อระบบ S2', detail: 'ศูนย์กลางทรัพยากรสำหรับระบบในอนาคต' },
];

export default function LoginPage() {
  const [notice, setNotice] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [googleStarting, setGoogleStarting] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const { user, isLoading, login } = useAuth();
  const { notify } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<LoginForm>({ resolver: zodResolver(schema) });

  /**
   * ปุ่ม Google แสดงเฉพาะเมื่อเซิร์ฟเวอร์ตั้งค่าไว้แล้ว
   * ปุ่มที่กดแล้วพาไปหน้าผิดพลาดทันทีแย่กว่าการไม่มีปุ่มเลย
   */
  useEffect(() => {
    let active = true;
    void api
      .googleConfig()
      .then((response) => { if (active) setGoogleEnabled(response.data.enabled); })
      .catch(() => { if (active) setGoogleEnabled(false); });
    return () => { active = false; };
  }, []);

  /** ปลายทางหลังเข้าสู่ระบบ - ใช้ร่วมกันทั้งรหัสผ่านและ Google (backend ตรวจซ้ำอีกชั้น) */
  const from = (location.state as { from?: string } | null)?.from;

  /** ความล้มเหลวจากขั้นตอน Google กลับมาเป็นรหัสใน query string */
  const googleNotice = googleLoginMessage(new URLSearchParams(location.search).get('google'));
  const onSubmit = handleSubmit(async (values) => {
    // react-hook-form กัน submit ซ้ำผ่าน isSubmitting อยู่แล้ว
    // เพิ่มการ์ดอีกชั้นเผื่อกรณีกด Enter รัว ๆ ระหว่างคำขอกำลังทำงาน
    if (isSubmitting) return;

    setNotice(null);
    try {
      const session = await login(values.email, values.password);
      notify({
        tone: 'success',
        title: 'เข้าสู่ระบบสำเร็จ',
        description: 'ยินดีต้อนรับกลับสู่ S2 NAS',
      });
      /**
       * ปลายทางขึ้นกับชนิดของบัญชี ไม่ใช่ค่า from ที่ติดมากับการถูกเด้งออกจากหน้าเดิม
       * ลูกค้าไปที่พื้นที่เอกสาร บุคลากรภายในไปที่หน้าทำงานภายใน
       */
      navigate(homePathFor(session, from), { replace: true });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'เข้าสู่ระบบไม่สำเร็จ');
    }
  });
  // เข้าสู่ระบบอยู่แล้ว - ส่งไปหน้าแรกของฝั่งที่ผู้ใช้สังกัด
  if (!isLoading && user) return <Navigate to={homePathFor(user, from)} replace />;

  return <main className="relative min-h-screen overflow-hidden bg-canvas">
    <div className="pointer-events-none absolute inset-0 opacity-70 [background-image:radial-gradient(circle_at_14%_18%,color-mix(in_srgb,var(--s2-primary)_16%,transparent),transparent_28%),radial-gradient(circle_at_86%_78%,color-mix(in_srgb,var(--s2-primary)_9%,transparent),transparent_30%)]" />
    <div className="absolute right-5 top-5 z-10"><ThemeControl compact /></div>
    <div className="relative mx-auto grid min-h-screen w-full max-w-[1440px] lg:grid-cols-[1.08fr_.92fr]">
      <section className="order-2 flex flex-col justify-center px-6 py-8 sm:px-12 sm:py-12 lg:order-1 lg:px-16 lg:py-16 xl:px-24">
        <div className="max-w-xl">
          <div className="mb-7 flex items-center gap-3 lg:mb-10">
            <BrandLogo size={56} />
            <p className="text-[11.5px] text-navy-400">Private company cloud platform</p>
          </div>
          <p className="text-[11px] font-semibold uppercase tracking-[.22em] text-brand-600">Company-owned storage</p>
          <h1 className="mt-4 max-w-lg text-[clamp(28px,4vw,46px)] font-semibold leading-[1.22] tracking-[-.035em] text-navy-900">พื้นที่ไฟล์ส่วนกลาง<br /><span className="text-brand-600">ที่องค์กรเป็นเจ้าของ</span></h1>
          <p className="mt-5 max-w-lg text-[14px] leading-7 text-navy-500">ระบบจัดเก็บเอกสารและไฟล์บนเซิร์ฟเวอร์ พร้อมเป็นศูนย์กลางทรัพยากรของ S2 Ecosystem</p>
          <div className="mt-10 hidden gap-3 sm:grid sm:grid-cols-2">
            {benefits.map((benefit) => <div key={benefit.title} className="flex gap-3 rounded-2xl border border-line bg-surface/70 p-3.5 backdrop-blur-sm">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><benefit.icon className="h-[17px] w-[17px]" /></span>
              <div><p className="text-[12.5px] font-semibold text-navy-800">{benefit.title}</p><p className="mt-0.5 text-[10.5px] leading-relaxed text-navy-400">{benefit.detail}</p></div>
            </div>)}
          </div>
        </div>
      </section>

      <section className="order-1 flex items-center justify-center px-5 pb-8 pt-20 sm:px-10 sm:py-12 lg:order-2 lg:px-16">
        <div className="w-full max-w-[430px] rounded-[22px] border border-line bg-[var(--s2-elevated)] p-6 shadow-pop sm:p-8">
          <div className="mb-7"><div className="mb-5 flex items-center justify-between"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-50 text-brand-600"><Lock className="h-5 w-5" /></span><ServerStatus /></div><h2 className="text-[22px] font-semibold tracking-[-.025em] text-navy-900">เข้าสู่พื้นที่ของคุณ</h2><p className="mt-1.5 text-[12.5px] text-navy-400">ใช้บัญชี S2 NAS ที่ได้รับจากผู้ดูแลระบบ</p></div>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div><label htmlFor="email" className="mb-1.5 block text-[12px] font-semibold text-navy-700">อีเมล</label><div className="relative"><Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-navy-300" /><input id="email" type="email" autoComplete="username" placeholder="name@company.com" {...register('email')} className="s2-input h-11 rounded-xl pl-10 pr-3 text-[13px]" /></div>{errors.email ? <p className="mt-1 text-[11px] text-red-600">{errors.email.message}</p> : null}</div>
            <div><label htmlFor="password" className="mb-1.5 block text-[12px] font-semibold text-navy-700">รหัสผ่าน</label><div className="relative"><Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-navy-300" /><input id="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="รหัสผ่านของคุณ" {...register('password')} className="s2-input h-11 rounded-xl pl-10 pr-10 text-[13px]" /><button type="button" onClick={() => setShowPassword((v) => !v)} className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-navy-300 hover:text-navy-600" aria-label={showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}>{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div>{errors.password ? <p className="mt-1 text-[11px] text-red-600">{errors.password.message}</p> : null}</div>
            <button type="submit" disabled={isSubmitting || isLoading} aria-busy={isSubmitting} className="s2-btn s2-btn-primary mt-2 w-full">
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  กำลังเข้าสู่ระบบ…
                </>
              ) : (
                'เข้าสู่ระบบ'
              )}
            </button>
            {notice ? <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[11.5px] leading-relaxed text-red-700">{notice}</div> : null}
          </form>

          {googleEnabled ? (
            <>
              <div className="my-4 flex items-center gap-3" aria-hidden>
                <span className="h-px flex-1 bg-[var(--s2-card-border)]" />
                <span className="text-[10.5px] text-navy-400">หรือ</span>
                <span className="h-px flex-1 bg-[var(--s2-card-border)]" />
              </div>

              {/*
                ทางเลือกรอง ไม่ใช่ทางหลัก - ใช้ปุ่มแบบ outline เพื่อไม่ให้กลบการเข้าสู่ระบบด้วยรหัสผ่าน

                สั่งเปลี่ยนหน้าทั้งหน้าเอง ไม่ใช้ <a href> เพราะปุ่มนี้ re-render ตัวเองตอนคลิก
                (เปลี่ยนเป็นสถานะกำลังโหลด) ซึ่งทำให้การนำทางเริ่มต้นของลิงก์ถูกยกเลิกได้
              */}
              <button
                type="button"
                disabled={googleStarting}
                onClick={() => {
                  if (googleStarting) return;
                  setGoogleStarting(true);
                  startGoogleLogin(from);
                }}
                className="s2-btn s2-btn-outline h-11 w-full justify-center rounded-xl text-[13px] disabled:opacity-60"
              >
                {googleStarting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    กำลังพาไปที่ Google…
                  </>
                ) : (
                  <>
                    <GoogleMark />
                    เข้าสู่ระบบด้วย Google
                  </>
                )}
              </button>
            </>
          ) : null}

          {googleNotice ? (
            <div
              role="alert"
              className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[11.5px] leading-relaxed text-red-700"
            >
              {googleNotice}
            </div>
          ) : null}
          <div className="mt-6 flex items-center gap-2 border-t border-line pt-5 text-[10.5px] text-navy-400"><Check className="h-3.5 w-3.5 text-emerald-600" />การเชื่อมต่อได้รับการตรวจสอบโดย S2 NAS</div>
        </div>
      </section>
    </div>
  </main>;
}

/** โลโก้ Google แบบ inline - ไม่โหลดจากภายนอกเพื่อไม่ให้หน้าเข้าสู่ระบบพึ่งเครือข่ายอื่น */
function GoogleMark() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 18 18" aria-hidden focusable="false">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.35 0-4.34-1.58-5.05-3.71H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.95 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l2.99-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l2.99 2.33C4.66 5.16 6.65 3.58 9 3.58Z" />
    </svg>
  );
}
