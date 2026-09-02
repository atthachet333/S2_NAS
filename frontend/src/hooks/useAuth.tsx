import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { authApi, setAccessToken, type AuthUser } from '@/lib/api';
import { publishAuthEvent, runExclusive, subscribeAuthEvents } from '@/lib/session-coordinator';

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  updateProfile(displayName: string): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * refresh cookie (httpOnly) คือแหล่งข้อมูล session ที่เชื่อถือได้เพียงแหล่งเดียว
 *
 * ตอน bootstrap จะเรียก /auth/session เสมอ ไม่ว่าฝั่ง client จะมีสถานะอะไรค้างอยู่หรือไม่
 * cookie ที่ยังใช้ได้จึงกู้คืนผู้ใช้ได้เสมอ แม้ localStorage จะถูกล้างไปแล้ว
 *
 * ห้ามเก็บ access token หรือ refresh token ลง localStorage / sessionStorage / IndexedDB
 * access token อยู่ในหน่วยความจำของหน้าเว็บเท่านั้น
 *
 * การเรียก /auth/session ถูกจัดคิวข้ามแท็บด้วย Web Locks (ดู session-coordinator)
 * เพื่อไม่ให้สองแท็บส่ง refresh cookie ใบเดียวกันพร้อมกันแล้วมีแท็บหนึ่งหลุดออกจากระบบ
 */
let bootstrapSession: ReturnType<typeof authApi.session> | null = null;

/**
 * bootstrap ครั้งเดียวต่อหนึ่งช่วงชีวิตของแท็บ
 * React Strict Mode เรียก effect สองรอบ แต่ promise ถูกจำไว้ที่ระดับโมดูล
 * จึงเกิด request จริงเพียงครั้งเดียว
 */
function restoreSessionOnce() {
  bootstrapSession ??= runExclusive(() => authApi.session());
  return bootstrapSession;
}

/** บังคับ bootstrap รอบใหม่ เช่นเมื่อแท็บอื่นเพิ่งเข้าสู่ระบบ */
function restartSession() {
  bootstrapSession = null;
  return restoreSessionOnce();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;

    restoreSessionOnce()
      .then((response) => {
        if (!active) return;
        if (response.data.authenticated) {
          setAccessToken(response.data.accessToken);
          setUser(response.data.user);
        } else {
          // ไม่มี cookie หรือ cookie ใช้ไม่ได้: จบลงที่สถานะยังไม่ได้เข้าสู่ระบบอย่างเรียบร้อย
          setAccessToken(null);
          setUser(null);
        }
      })
      .catch(() => {
        // ติดต่อเซิร์ฟเวอร์ไม่ได้จริง ๆ ให้ถือว่ายังไม่ได้เข้าสู่ระบบ ไม่วนลองใหม่เอง
        if (!active) return;
        setAccessToken(null);
        setUser(null);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  // ซิงก์สถานะยืนยันตัวตนระหว่างแท็บ
  // ช่องถูกสร้างและปิดภายใน effect นี้ จึงปลอดภัยกับ Strict Mode ที่ mount/unmount รอบพิเศษ
  useEffect(() => {
    let active = true;

    const unsubscribe = subscribeAuthEvents((event) => {
      if (!active) return;

      if (event.type === 'LOGOUT' || event.type === 'PASSWORD_CHANGED') {
        // แท็บอื่นออกจากระบบหรือเปลี่ยนรหัสผ่าน session ปัจจุบันถูกเพิกถอนแล้ว
        // ล้างสถานะทันทีโดยไม่ต้องถามเซิร์ฟเวอร์ซ้ำ ป้องกันการวน refresh
        bootstrapSession = null;
        setAccessToken(null);
        setUser(null);
        setIsLoading(false);
        return;
      }

      // แท็บอื่นเพิ่งเข้าสู่ระบบ: bootstrap ใหม่จาก cookie (ไม่มีการส่ง token ข้ามแท็บ)
      restartSession()
        .then((response) => {
          if (!active || !response.data.authenticated) return;
          setAccessToken(response.data.accessToken);
          setUser(response.data.user);
        })
        .catch(() => undefined);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    isLoading,
    async login(email, password) {
      const response = await authApi.login(email, password);
      bootstrapSession = null;
      setAccessToken(response.data.accessToken);
      setUser(response.data.user);
      publishAuthEvent('LOGIN');
    },
    async logout() {
      try {
        await authApi.logout();
      } finally {
        bootstrapSession = null;
        setAccessToken(null);
        setUser(null);
        publishAuthEvent('LOGOUT');
      }
    },
    async changePassword(currentPassword, newPassword) {
      await authApi.changePassword(currentPassword, newPassword);
      bootstrapSession = null;
      setAccessToken(null);
      setUser(null);
      publishAuthEvent('PASSWORD_CHANGED');
    },
    async updateProfile(displayName) {
      const response = await authApi.updateProfile(displayName);
      setUser(response.data);
    },
  }), [user, isLoading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth ต้องอยู่ภายใน AuthProvider');
  return value;
}
