import { Outlet } from 'react-router-dom';
import { TopHeader } from './TopHeader';
import { TopNav } from './TopNav';
import { DetailsDrawer } from '@/components/files/DetailsDrawer';
import { UploadPanel } from '@/components/files/UploadPanel';
import { DriveUiProvider } from '@/hooks/useDriveUi';
import { CommandPalette } from './CommandPalette';

function Shell() {

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <div className="sticky top-0 z-[var(--z-header)]">
        <TopHeader />
        <TopNav />
      </div>
      <div className="flex min-h-0 flex-1">
        <main className="mx-auto min-w-0 w-full max-w-[1680px] flex-1 px-4 py-6 lg:px-8 lg:py-7">
          <Outlet />
        </main>
        <DetailsDrawer />
      </div>
      <CommandPalette />
      <UploadPanel />
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
