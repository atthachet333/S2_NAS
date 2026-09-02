import { useNavigate } from 'react-router-dom';
import { Star } from 'lucide-react';
import { DriveWorkspace } from '@/components/files/DriveWorkspace';
import { EmptyState } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';
import { applyMarks, toDriveEntry, type DriveEntry } from '@/lib/drive';
import { useWorkspaceMarks } from '@/hooks/useWorkspaceMarks';
import { useWorkspaceActions } from '@/hooks/useWorkspaceActions';
import { useDriveUi } from '@/hooks/useDriveUi';
import { isPreviewable } from '@/lib/file-types';
import { PreviewModal } from '@/components/files/PreviewModal';
import { useState } from 'react';

export default function FavoritesPage() {
  const navigate = useNavigate();
  const { select, openDetails } = useDriveUi();
  const { favoriteResources, favoriteIds, pinnedIds, isLoading } = useWorkspaceMarks();
  const { handleWorkspaceAction, workspaceDialogs } = useWorkspaceActions();
  const [preview, setPreview] = useState<DriveEntry | null>(null);

  const entries = applyMarks(favoriteResources.map(toDriveEntry), favoriteIds, pinnedIds);

  const action = (name: string, entry: DriveEntry | null) => {
    if (handleWorkspaceAction(name, entry)) return;
    if (!entry) return;
    if (name === 'open' && entry.kind === 'folder') {
      navigate(`/files/${entry.id}`);
      return;
    }
    if ((name === 'open' || name === 'preview') && entry.kind === 'file') {
      if (isPreviewable(entry.name, entry.mimeType)) setPreview(entry);
      else {
        select(entry);
        openDetails();
      }
      return;
    }
    if (name === 'details') {
      select(entry);
      openDetails();
    }
  };

  return (
    <div className="space-y-4">
      <PageTitle
        title="รายการโปรด"
        description="ไฟล์และโฟลเดอร์ที่คุณทำเครื่องหมายไว้ เห็นเฉพาะคุณคนเดียว"
      />

      <DriveWorkspace
        entries={entries}
        isLoading={isLoading}
        isError={false}
        onResourceAction={action}
        allowUpload={false}
        emptyState={
          <EmptyState
            icon={<Star className="h-6 w-6" aria-hidden />}
            title="ยังไม่มีรายการโปรด"
            description="กดเพิ่มในรายการโปรดจากเมนูของไฟล์หรือโฟลเดอร์ เพื่อให้กลับมาเปิดได้เร็วขึ้น"
          />
        }
      />

      {preview ? (
        <PreviewModal
          entry={preview}
          onClose={() => setPreview(null)}
          onShowDetails={() => {
            select(preview);
            openDetails();
            setPreview(null);
          }}
        />
      ) : null}

      {workspaceDialogs}
    </div>
  );
}
