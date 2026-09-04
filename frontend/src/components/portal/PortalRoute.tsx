import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { INTERNAL_HOME, isExternalAccount } from '@/lib/portal';

/**
 * ด่านของพื้นที่เอกสารสำหรับลูกค้า - ฝั่งหน้าจอ
 *
 * เป็นเรื่องของการนำทางเท่านั้น ไม่ใช่ความปลอดภัย
 * เซิร์ฟเวอร์ปฏิเสธ /api/portal ให้บัญชีภายใน และปฏิเสธ API ภายในให้บัญชีลูกค้าอยู่แล้ว
 * ที่นี่มีไว้เพื่อไม่ให้ผู้ใช้ไปยืนอยู่หน้าที่โหลดข้อมูลไม่ได้เลย
 */
export function PortalRoute({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas text-sm text-navy-400">
        กำลังตรวจสอบ Session…
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  // บุคลากรภายในไม่ได้อยู่ที่นี่ - ส่งกลับพื้นที่ทำงานของตัวเอง
  if (!isExternalAccount(user)) return <Navigate to={INTERNAL_HOME} replace />;

  return <>{children}</>;
}
