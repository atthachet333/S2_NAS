import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Share2 } from 'lucide-react';
import { DriveWorkspace } from '@/components/files/DriveWorkspace';
import { FileToolbar, type SortKey } from '@/components/files/FileToolbar';
import { EmptyState } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';
import { listDrive } from '@/lib/drive';

export default function SharedPage() {
  const [sort, setSort] = useState<SortKey>('modified-desc');

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['drive', 'shared'],
    queryFn: () => listDrive('shared'),
  });

  return (
    <div className="space-y-4">
      <PageTitle title="แชร์กับฉัน" description="ไฟล์และโฟลเดอร์ที่เพื่อนร่วมงานแชร์ให้คุณ" />
      <FileToolbar sort={sort} onSortChange={setSort} showNew={false} showUpload={false} />

      <DriveWorkspace
        entries={data?.entries ?? []}
        isLoading={isPending}
        isError={isError}
        onRetry={() => void refetch()}
        allowUpload={false}
        columns={[
          { key: 'owner', label: 'เจ้าของ' },
          { key: 'sharedBy', label: 'แชร์โดย' },
          { key: 'permission', label: 'สิทธิ์' },
          { key: 'sharedAt', label: 'วันที่แชร์' },
        ]}
        emptyState={
          <EmptyState
            icon={<Share2 className="h-6 w-6" aria-hidden />}
            title="ยังไม่มีไฟล์ที่แชร์กับคุณ"
            description="เมื่อมีผู้แชร์ไฟล์หรือโฟลเดอร์ให้คุณ รายการจะแสดงที่นี่"
          />
        }
      />
    </div>
  );
}
