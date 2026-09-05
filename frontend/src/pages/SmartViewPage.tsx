import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { DriveWorkspace } from '@/components/files/DriveWorkspace';
import { PreviewModal } from '@/components/files/PreviewModal';
import { EmptyState } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';
import { smartViewApi } from '@/lib/api';
import { applyMarks, toDriveEntry, type DriveEntry } from '@/lib/drive';
import { useWorkspaceMarks } from '@/hooks/useWorkspaceMarks';
import { useWorkspaceActions } from '@/hooks/useWorkspaceActions';
import { useDriveUi } from '@/hooks/useDriveUi';
import { isPreviewable } from '@/lib/file-types';

/**
 * มุมมองอัจฉริยะหนึ่งมุมมอง
 *
 * เป็นผลของชุดตัวกรองสำเร็จรูป ไม่ใช่โฟลเดอร์ - จึงไม่มีการอัปโหลดเข้ามุมมอง
 * และไม่มีการ "ย้ายออก" เอกสารหายไปเองเมื่อสถานะของมันเปลี่ยน
 */
export default function SmartViewPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const { select, openDetails } = useDriveUi();
  const { favoriteIds, pinnedIds } = useWorkspaceMarks();
  const { handleWorkspaceAction, workspaceDialogs } = useWorkspaceActions();
  const [preview, setPreview] = useState<DriveEntry | null>(null);

  const result = useQuery({
    queryKey: ['smart-view', slug],
    queryFn: () => smartViewApi.run(slug, new URLSearchParams({ limit: '100' })),
    enabled: slug.length > 0,
  });

  const entries = applyMarks(
    (result.data?.data.items ?? []).map(toDriveEntry),
    favoriteIds,
    pinnedIds,
  );

  const views = useQuery({
    queryKey: ['smart-views'],
    queryFn: smartViewApi.list,
    staleTime: 10 * 60_000,
  });
  const meta = views.data?.data.find((view) => view.slug === slug);

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
        title={result.data?.data.view.name ?? meta?.name ?? 'มุมมองอัจฉริยะ'}
        description={meta?.description ?? 'ชุดเงื่อนไขสำเร็จรูป แสดงเฉพาะรายการที่คุณมีสิทธิ์เข้าถึง'}
      />

      {!result.isPending && !result.isError ? (
        <p className="text-[12px] text-navy-400">
          พบ {entries.length} รายการที่คุณเข้าถึงได้
          {result.data?.data.nextCursor ? ' · แสดง 100 รายการแรก' : ''}
        </p>
      ) : null}

      <DriveWorkspace
        entries={entries}
        isLoading={result.isPending}
        isError={result.isError}
        onRetry={() => void result.refetch()}
        onResourceAction={action}
        allowUpload={false}
        emptyState={
          <EmptyState
            icon={<Sparkles className="h-6 w-6" aria-hidden />}
            title="ไม่มีรายการในมุมมองนี้"
            description="มุมมองนี้จะแสดงรายการเองเมื่อมีเอกสารเข้าเงื่อนไข"
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
