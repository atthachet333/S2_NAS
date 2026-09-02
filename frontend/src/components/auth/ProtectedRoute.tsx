import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { ChangePasswordDialog } from './ChangePasswordDialog';

export function ProtectedRoute({ children, permission }: { children: ReactNode; permission?: string }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const closePasswordDialog = useCallback(() => setPasswordDialogOpen(false), []);
  useEffect(() => {
    const open = () => setPasswordDialogOpen(true);
    window.addEventListener('s2-open-password-dialog', open);
    return () => window.removeEventListener('s2-open-password-dialog', open);
  }, []);
  if (isLoading) return <div className="flex min-h-screen items-center justify-center bg-canvas text-sm text-navy-400">กำลังตรวจสอบ Session…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (permission && !user.permissions.includes(permission)) return <Navigate to="/files" replace />;
  return <>{children}<ChangePasswordDialog forced={Boolean(user.mustChangePassword)} open={Boolean(user.mustChangePassword) || passwordDialogOpen} onClose={closePasswordDialog} /></>;
}
