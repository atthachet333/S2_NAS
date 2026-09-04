import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { AdminShell } from '@/components/layout/AdminShell';
import LoginPage from '@/pages/LoginPage';
import DashboardPage from '@/pages/DashboardPage';
import FilesPage from '@/pages/FilesPage';
import SharedPage from '@/pages/SharedPage';
import RecentPage from '@/pages/RecentPage';
import FavoritesPage from '@/pages/FavoritesPage';
import SearchPage from '@/pages/SearchPage';
import TrashPage from '@/pages/TrashPage';
import NotFoundPage from '@/pages/NotFoundPage';
import AdminUsersPage from '@/pages/admin/AdminUsersPage';
import AdminClientsPage from '@/pages/admin/AdminClientsPage';
import AdminPermissionsPage from '@/pages/admin/AdminPermissionsPage';
import AdminActivityPage from '@/pages/admin/AdminActivityPage';
import AdminStoragePage from '@/pages/admin/AdminStoragePage';
import AdminBackupPage from '@/pages/admin/AdminBackupPage';
import AdminSettingsPage from '@/pages/admin/AdminSettingsPage';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PortalRoute } from '@/components/portal/PortalRoute';
import { PortalShell } from '@/components/portal/PortalShell';
import PortalHomePage from '@/pages/portal/PortalHomePage';
import PortalFolderPage from '@/pages/portal/PortalFolderPage';
import PortalUploadsPage from '@/pages/portal/PortalUploadsPage';
import AdminIntegrationsPage from '@/pages/admin/AdminIntegrationsPage';
import AdminOwnershipPage from '@/pages/admin/AdminOwnershipPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      {/*
        พื้นที่เอกสารสำหรับลูกค้า - แยกจากพื้นที่ทำงานภายในทั้งโครง
        ไม่ใช้ AppShell ร่วมกัน จึงไม่มีเมนู ไดร์ฟ ถังขยะ หรือเมนูผู้ดูแลให้หลุดออกมาได้
      */}
      <Route element={<PortalRoute><PortalShell /></PortalRoute>}>
        <Route path="/portal" element={<PortalHomePage />} />
        <Route path="/portal/uploads" element={<PortalUploadsPage />} />
        <Route path="/portal/folders/:folderId" element={<PortalFolderPage />} />
        <Route path="/portal/resources/:folderId" element={<PortalFolderPage />} />
      </Route>

      {/* พื้นที่ไฟล์ - หน้าแรกหลังเข้าใช้งานคือ ไดร์ฟของฉัน */}
      <Route element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/files/:folderId" element={<FilesPage />} />
        {/* ไดร์ฟของระบบใช้หน้าเดียวกับไดร์ฟของฉัน ต่างกันแค่ขอบเขตข้อมูลและนโยบายการเขียน */}
        <Route path="/system-drive" element={<FilesPage driveRoot="SYSTEM_DRIVE" />} />
        <Route path="/system-drive/:folderId" element={<FilesPage driveRoot="SYSTEM_DRIVE" />} />
        <Route path="/shared" element={<SharedPage />} />
        <Route path="/recent" element={<RecentPage />} />
        <Route path="/favorites" element={<FavoritesPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/trash" element={<TrashPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>

      {/* Admin Area แยกจากพื้นที่ไฟล์ */}
      <Route path="/admin" element={<ProtectedRoute permission="admin:access"><AdminShell /></ProtectedRoute>}>
        <Route index element={<Navigate to="/admin/users" replace />} />
        <Route path="users" element={<AdminUsersPage />} />
        {/* ลูกค้าแยกจากผู้ใช้งานภายใน - คนละวิธีให้สิทธิ์ คนละสิ่งที่ต้องดูแล */}
        <Route path="clients" element={<AdminClientsPage />} />
        <Route path="permissions" element={<AdminPermissionsPage />} />
        <Route path="ownership" element={<AdminOwnershipPage />} />
        <Route path="activity" element={<AdminActivityPage />} />
        <Route path="storage" element={<AdminStoragePage />} />
        <Route path="backup" element={<AdminBackupPage />} />
        <Route path="integrations" element={<AdminIntegrationsPage />} />
        <Route path="settings" element={<AdminSettingsPage />} />
      </Route>
    </Routes>
  );
}
