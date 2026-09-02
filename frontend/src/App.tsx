import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { AdminShell } from '@/components/layout/AdminShell';
import LoginPage from '@/pages/LoginPage';
import DashboardPage from '@/pages/DashboardPage';
import FilesPage from '@/pages/FilesPage';
import SharedPage from '@/pages/SharedPage';
import RecentPage from '@/pages/RecentPage';
import FavoritesPage from '@/pages/FavoritesPage';
import TrashPage from '@/pages/TrashPage';
import NotFoundPage from '@/pages/NotFoundPage';
import AdminUsersPage from '@/pages/admin/AdminUsersPage';
import AdminPermissionsPage from '@/pages/admin/AdminPermissionsPage';
import AdminActivityPage from '@/pages/admin/AdminActivityPage';
import AdminStoragePage from '@/pages/admin/AdminStoragePage';
import AdminBackupPage from '@/pages/admin/AdminBackupPage';
import AdminSettingsPage from '@/pages/admin/AdminSettingsPage';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AdminFoundationPage } from '@/pages/admin/AdminFoundationPage';
import { Plug } from 'lucide-react';
import AdminOwnershipPage from '@/pages/admin/AdminOwnershipPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      {/* พื้นที่ไฟล์ - หน้าแรกหลังเข้าใช้งานคือ ไฟล์ของฉัน */}
      <Route element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/files/:folderId" element={<FilesPage />} />
        <Route path="/shared" element={<SharedPage />} />
        <Route path="/recent" element={<RecentPage />} />
        <Route path="/favorites" element={<FavoritesPage />} />
        <Route path="/trash" element={<TrashPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>

      {/* Admin Area แยกจากพื้นที่ไฟล์ */}
      <Route path="/admin" element={<ProtectedRoute permission="admin:access"><AdminShell /></ProtectedRoute>}>
        <Route index element={<Navigate to="/admin/users" replace />} />
        <Route path="users" element={<AdminUsersPage />} />
        <Route path="permissions" element={<AdminPermissionsPage />} />
        <Route path="ownership" element={<AdminOwnershipPage />} />
        <Route path="activity" element={<AdminActivityPage />} />
        <Route path="storage" element={<AdminStoragePage />} />
        <Route path="backup" element={<AdminBackupPage />} />
        <Route path="integrations" element={<AdminFoundationPage title="Connected Apps" description="จุดเชื่อมต่อระบบใน S2 Ecosystem" icon={Plug} emptyTitle="ยังไม่มีระบบที่เชื่อมต่อ" emptyDescription="S2 Payroll, S2 ERP และ S2 LINE Bot ยังไม่เชื่อมต่อใน Phase นี้" />} />
        <Route path="settings" element={<AdminSettingsPage />} />
      </Route>
    </Routes>
  );
}
