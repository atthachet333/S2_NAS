import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Share2 } from 'lucide-react';
import { DriveWorkspace } from '@/components/files/DriveWorkspace';
import { EmptyState } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';
import { PreviewModal } from '@/components/files/PreviewModal';
import { workspaceApi } from '@/lib/api';
import { applyMarks, toDriveEntry, type DriveEntry } from '@/lib/drive';
import { useWorkspaceMarks } from '@/hooks/useWorkspaceMarks';
import { useWorkspaceActions } from '@/hooks/useWorkspaceActions';
import { useDriveUi } from '@/hooks/useDriveUi';
import { isPreviewable } from '@/lib/file-types';

/**
 * แชร์กับฉัน
 *
 * แสดงเฉพาะสิ่งที่มีคนตั้งใจแชร์ให้เราเป็นรายบุคคลเท่านั้น
 * ทรัพยากรที่เห็นได้เพราะเปิดให้ทั้งองค์กรจะไม่มาอยู่ที่นี่ มิฉะนั้นหน้านี้จะ
 * กลายเป็นรายการทุกอย่างในบริษัทและหมดความหมาย
 */
export default function SharedPage() {
  const navigate = useNavigate();
  const { select, openDetails } = useDriveUi();
  const { favoriteIds, pinnedIds } = useWorkspaceMarks();
  const { handleWorkspaceAction, workspaceDialogs } = useWorkspaceActions();
  const [preview, setPreview] = useState<DriveEntry | null>(null);

  const shared = useQuery({ queryKey: ['shared'], queryFn: workspaceApi.sharedWithMe });

  const entries = applyMarks(
    (shared.data?.data ?? []).map((item) => ({
      ...toDriveEntry(item),
      permission: item.myAccessLevel,
      sharedAt: item.sharedAt,
    })),
    favoriteIds,
    pinnedIds,
  );

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
        title="แชร์กับฉัน"
        description="ไฟล์และโฟลเดอร์ที่เพื่อนร่วมงานให้สิทธิ์คุณโดยเฉพาะ"
      />

      <DriveWorkspace
        entries={entries}
        isLoading={shared.isPending}
        isError={shared.isError}
        onRetry={() => void shared.refetch()}
        onResourceAction={action}
        allowUpload={false}
        columns={[
          { key: 'owner', label: 'ผู้ดูแล' },
          { key: 'permission', label: 'สิทธิ์ของคุณ' },
          { key: 'sharedAt', label: 'ได้รับเมื่อ' },
        ]}
        emptyState={
          <EmptyState
            icon={<Share2 className="h-6 w-6" aria-hidden />}
            title="ยังไม่มีไฟล์ที่แชร์ให้คุณโดยเฉพาะ"
            description="เมื่อมีผู้ให้สิทธิ์คุณกับไฟล์หรือโฟลเดอร์ใด รายการจะแสดงที่นี่ ทรัพยากรที่เปิดให้ทั้งองค์กรดูอยู่ที่ ไดร์ฟของฉัน"
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
