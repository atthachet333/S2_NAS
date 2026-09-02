import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { DriveWorkspace } from '@/components/files/DriveWorkspace';
import { FileToolbar, type SortKey } from '@/components/files/FileToolbar';
import { EmptyState } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';
import { listDrive } from '@/lib/drive';

export default function FavoritesPage() {
  const [sort, setSort] = useState<SortKey>('name-asc');

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['drive', 'favorites'],
    queryFn: () => listDrive('favorites'),
  });

  return (
    <div className="space-y-4">
      <PageTitle title="รายการโปรด" description="ไฟล์และโฟลเดอร์ที่คุณปักหมุดไว้" />
      <FileToolbar sort={sort} onSortChange={setSort} showNew={false} showUpload={false} />

      <DriveWorkspace
        entries={data?.entries ?? []}
        isLoading={isPending}
        isError={isError}
        onRetry={() => void refetch()}
        allowUpload={false}
        emptyState={
          <EmptyState
            icon={<Star className="h-6 w-6" aria-hidden />}
            title="ยังไม่มีรายการโปรด"
            description="กดเพิ่มในรายการโปรดจากเมนูของไฟล์หรือโฟลเดอร์ เพื่อให้กลับมาเปิดได้เร็วขึ้น"
          />
        }
      />
    </div>
  );
}
