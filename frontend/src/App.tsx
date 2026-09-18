import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PortalRoute } from '@/components/portal/PortalRoute';
import { TextSkeleton } from '@/components/ui/States';
import LoginPage from '@/pages/LoginPage';
import DashboardPage from '@/pages/DashboardPage';

/**
 * การแบ่งโค้ดตามเส้นทาง (F24-B)
 *
 * **ปัญหาที่แก้:** ก่อนหน้านี้ทุกหน้าถูก import แบบตรง ๆ ทั้งหมด ผู้ใช้ที่เปิดหน้าเข้าสู่ระบบ
 * บนมือถือจึงต้องดาวน์โหลดหน้าจอผู้ดูแลระบบ หน้าสำรองข้อมูล และหน้าตรวจสอบทั้งชุด
 * ก่อนจะพิมพ์รหัสผ่านได้ ซึ่งเป็นน้ำหนักที่เขาไม่มีวันได้ใช้
 *
 * **สิ่งที่ยังโหลดทันที:** หน้าเข้าสู่ระบบ เปลือกแอป และหน้าแรกหลังเข้าระบบ
 * สามอย่างนี้อยู่บนเส้นทางที่ผู้ใช้ทุกคนต้องผ่านเสมอ การแยกมันออกไปจะเพิ่มการรอ
 * โดยไม่ประหยัดอะไร เพราะยังไงก็ต้องโหลดอยู่ดี
 *
 * **สิ่งที่แยกออก:** หน้าที่เข้าเป็นครั้งคราวและกลุ่มผู้ดูแลระบบทั้งหมด
 * ไม่แยกคอมโพเนนต์เล็ก ๆ ทีละตัว เพราะจะได้ไฟล์ย่อยจำนวนมากที่ต้องรอทีละคำขอ
 * ซึ่งบนเครือข่ายมือถือแย่กว่าไฟล์เดียวที่ใหญ่กว่าเล็กน้อย
 */
const FilesPage = lazy(() => import('@/pages/FilesPage'));
const SharedPage = lazy(() => import('@/pages/SharedPage'));
const RecentPage = lazy(() => import('@/pages/RecentPage'));
const FavoritesPage = lazy(() => import('@/pages/FavoritesPage'));
const SearchPage = lazy(() => import('@/pages/SearchPage'));
const SmartViewPage = lazy(() => import('@/pages/SmartViewPage'));
const OcrReviewPage = lazy(() => import('@/pages/OcrReviewPage'));
const TrashPage = lazy(() => import('@/pages/TrashPage'));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage'));
const SettingsIntegrationsPage = lazy(() => import('@/pages/SettingsIntegrationsPage'));

const AdminShell = lazy(() => import('@/components/layout/AdminShell').then((m) => ({ default: m.AdminShell })));
const AdminUsersPage = lazy(() => import('@/pages/admin/AdminUsersPage'));
const AdminClientsPage = lazy(() => import('@/pages/admin/AdminClientsPage'));
const AdminPermissionsPage = lazy(() => import('@/pages/admin/AdminPermissionsPage'));
const AdminActivityPage = lazy(() => import('@/pages/admin/AdminActivityPage'));
const AdminStoragePage = lazy(() => import('@/pages/admin/AdminStoragePage'));
const AdminBackupPage = lazy(() => import('@/pages/admin/AdminBackupPage'));
const AdminSettingsPage = lazy(() => import('@/pages/admin/AdminSettingsPage'));
const AdminIntegrationsPage = lazy(() => import('@/pages/admin/AdminIntegrationsPage'));
const AdminOwnershipPage = lazy(() => import('@/pages/admin/AdminOwnershipPage'));
const AdminCategoriesPage = lazy(() => import('@/pages/admin/AdminCategoriesPage'));
const AdminRetentionPage = lazy(() => import('@/pages/admin/AdminRetentionPage'));
const AdminAuditPage = lazy(() => import('@/pages/admin/AdminAuditPage'));
const AdminPublicSharesPage = lazy(() => import('@/pages/admin/AdminPublicSharesPage'));
const AdminGoogleDrivePage = lazy(() => import('@/pages/admin/AdminGoogleDrivePage'));

const PortalShell = lazy(() => import('@/components/portal/PortalShell').then((m) => ({ default: m.PortalShell })));
const PortalHomePage = lazy(() => import('@/pages/portal/PortalHomePage'));
const PortalFolderPage = lazy(() => import('@/pages/portal/PortalFolderPage'));
const PortalUploadsPage = lazy(() => import('@/pages/portal/PortalUploadsPage'));
const PortalWorkflowsPage = lazy(() => import('@/pages/portal/PortalWorkflowsPage'));
const PortalWorkflowDetailPage = lazy(() => import('@/pages/portal/PortalWorkflowDetailPage'));
const GuestSharePage = lazy(() => import('@/pages/guest/GuestSharePage'));

/** ตัวแทนระหว่างรอไฟล์ของหน้า - ใช้โครงร่างเดิมของระบบ ไม่ใช่ตัวหมุนกลางจอ */
function RouteFallback() {
  return (
    <div className="px-1 py-2" role="status" aria-label="กำลังโหลดหน้า">
      <TextSkeleton lines={6} />
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        {/*
          พื้นที่เอกสารสำหรับลูกค้า - แยกจากพื้นที่ทำงานภายในทั้งโครง
          ไม่ใช้ AppShell ร่วมกัน จึงไม่มีเมนู ไดร์ฟ ถังขยะ หรือเมนูผู้ดูแลให้หลุดออกมาได้
        */}
        <Route element={<PortalRoute><PortalShell /></PortalRoute>}>
          <Route path="/portal" element={<PortalHomePage />} />
          <Route path="/portal/uploads" element={<PortalUploadsPage />} />
          <Route path="/portal/workflows" element={<PortalWorkflowsPage />} />
          <Route path="/portal/workflows/:workflowId" element={<PortalWorkflowDetailPage />} />
          <Route path="/portal/folders/:folderId" element={<PortalFolderPage />} />
          <Route path="/portal/resources/:folderId" element={<PortalFolderPage />} />
        </Route>

        {/*
          ลิงก์แชร์ภายนอก - อยู่นอกด่านตรวจสิทธิ์ทั้งหมดโดยตั้งใจ
          ผู้เปิดหน้านี้ไม่มีบัญชี จึงต้องไม่ถูกส่งไปหน้าเข้าสู่ระบบ
          และไม่ใช้เปลือกหน้าจอร่วมกับพื้นที่ภายในหรือพื้นที่ลูกค้า
        */}
        <Route path="/s/:token" element={<GuestSharePage />} />

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
          {/* มุมมองอัจฉริยะเป็นชุดตัวกรองสำเร็จรูป ไม่ใช่โฟลเดอร์ */}
          <Route path="/smart-views/:slug" element={<SmartViewPage />} />
          <Route path="/ocr-review" element={<OcrReviewPage />} />
          <Route path="/trash" element={<TrashPage />} />
          {/* การเชื่อมต่อของผู้ใช้เอง - ไม่ต้องเป็นผู้ดูแลระบบ เพราะเป็นบัญชี Google ของเขาเอง */}
          <Route path="/settings/integrations" element={<SettingsIntegrationsPage />} />
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
          <Route path="categories" element={<AdminCategoriesPage />} />
          <Route path="retention" element={<AdminRetentionPage />} />
          <Route path="activity" element={<AdminActivityPage />} />
          {/* เครื่องมือของผู้ตรวจสอบ - ต่างจาก Activity Log ที่เป็นไทม์ไลน์อย่างเดียว */}
          <Route path="audit" element={<AdminAuditPage />} />
          {/* ประตูที่เปิดสู่ภายนอก - ผู้ดูแลต้องเห็นทั้งหมดในที่เดียว */}
          <Route path="public-shares" element={<AdminPublicSharesPage />} />
          <Route path="google-drive" element={<AdminGoogleDrivePage />} />
          <Route path="storage" element={<AdminStoragePage />} />
          <Route path="backup" element={<AdminBackupPage />} />
          <Route path="integrations" element={<AdminIntegrationsPage />} />
          <Route path="settings" element={<AdminSettingsPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
