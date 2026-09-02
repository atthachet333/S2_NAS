import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { DriveWorkspace } from '@/components/files/DriveWorkspace';
import { FileToolbar, type SortKey } from '@/components/files/FileToolbar';
import { EmptyState } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';
import { listDrive, type DriveEntry } from '@/lib/drive';
import { PreviewModal } from '@/components/files/PreviewModal';
import { downloadResource } from '@/lib/download';
import { isPreviewable } from '@/lib/file-types';
import { useDriveUi } from '@/hooks/useDriveUi';
import { useToast } from '@/hooks/useToast';
import { useNavigate } from 'react-router-dom';

export default function RecentPage() {
  const [sort, setSort] = useState<SortKey>('modified-desc');
  const [preview, setPreview] = useState<DriveEntry | null>(null);
  const { select, openDetails } = useDriveUi();
  const { notify } = useToast();
  const navigate = useNavigate();

  const action = (name: string, entry: DriveEntry | null) => {
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
    if (name === 'download') {
      void downloadResource(entry.id, entry.name).catch((error: unknown) =>
        notify({ tone: 'error', title: error instanceof Error ? error.message : 'ดาวน์โหลดไม่สำเร็จ' }),
      );
    }
  };

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['drive', 'recent'],
    queryFn: () => listDrive('recent'),
  });

  return (
    <div className="space-y-4">
      <PageTitle title="ล่าสุด" description="ไฟล์ที่เปิด อัปโหลด หรือแก้ไขล่าสุด" />
      <FileToolbar sort={sort} onSortChange={setSort} showNew={false} />

      <DriveWorkspace
        entries={data?.entries ?? []}
        isLoading={isPending}
        isError={isError}
        onRetry={() => void refetch()}
        onResourceAction={action}
        allowUpload={false}
        emptyState={
          <EmptyState
            icon={<Clock className="h-6 w-6" aria-hidden />}
            title="ยังไม่มีรายการล่าสุด"
            description="ไฟล์ที่คุณเปิดหรือแก้ไขจะปรากฏที่นี่ เพื่อให้กลับมาทำงานต่อได้เร็ว"
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
    </div>
  );
}
