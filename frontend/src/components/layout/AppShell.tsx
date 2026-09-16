import { Outlet } from 'react-router-dom';
import { TopHeader } from './TopHeader';
import { TopNav } from './TopNav';
import { MobileNav } from './MobileNav';
import { DetailsDrawer } from '@/components/files/DetailsDrawer';
import { UploadPanel } from '@/components/files/UploadPanel';
import { DriveUiProvider } from '@/hooks/useDriveUi';
import { CommandPalette } from './CommandPalette';
import { AssistantPanel } from '@/components/assistant/AssistantPanel';
import { OfflineNotice } from '@/components/pwa/OfflineNotice';
import { useConnectivity } from '@/hooks/useConnectivity';

function Shell() {
  const { online } = useConnectivity();

  return (
    <div className="flex min-h-screen w-full max-w-full flex-col overflow-x-hidden bg-canvas">
      <div className="sticky top-0 z-[var(--z-header)]">
        <TopHeader />
        {/*
          แถบนำทางบนเป็นของจอกว้าง โทรศัพท์ใช้แถบล่างแทน

          เจ็ดปลายทางในแถบที่เลื่อนแนวนอนได้ ทำให้สี่ปลายทางสุดท้ายมองไม่เห็น
          และไม่มีอะไรบอกว่ามันมีอยู่
        */}
        <div className="hidden md:block">
          <TopNav />
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {/*
          ระยะล่างเผื่อแถบนำทางที่ลอยอยู่ เฉพาะจอที่มีแถบนั้นจริง
          จอกว้างไม่มีแถบล่าง จึงไม่ต้องเสียพื้นที่ไปเปล่า ๆ
        */}
        <main className="mx-auto min-w-0 w-full max-w-[1680px] flex-1 px-4 pt-6 pb-[calc(72px+env(safe-area-inset-bottom))] md:pb-6 lg:px-8 lg:pt-7 lg:pb-7">
          {/* บอกก่อนเนื้อหา ไม่ใช่ซ่อนไว้ท้ายหน้า เพราะมันเปลี่ยนความหมายของทุกอย่างที่อยู่ใต้มัน */}
          {online ? null : <div className="mb-4"><OfflineNotice /></div>}
          <Outlet />
        </main>
        <DetailsDrawer />
      </div>
      <CommandPalette />
      <UploadPanel />
      <AssistantPanel />
      <MobileNav />
    </div>
  );
}

/** Layout ของพื้นที่ไฟล์ - ไม่มี sidebar ถาวร */
export function AppShell() {
  return (
    <DriveUiProvider>
      <Shell />
    </DriveUiProvider>
  );
}
