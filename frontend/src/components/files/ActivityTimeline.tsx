import { useInfiniteQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { workspaceApi } from '@/lib/api';
import { activityDetail, activityLabel, activityTone, type ActivityTone } from '@/lib/activity-text';
import { formatDateTime, formatRelativeTime } from '@/lib/utils';
import { EmptyState, ErrorState, TextSkeleton } from '@/components/ui/States';

const TONE_CLASS: Record<ActivityTone, string> = {
  brand: 'bg-brand-500',
  neutral: 'bg-navy-300',
  positive: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
};

/** ไทม์ไลน์ของทรัพยากรหนึ่งชิ้น อ่านจากบันทึกกิจกรรมจริงเท่านั้น */
export function ActivityTimeline({ resourceId }: { resourceId: string }) {
  const query = useInfiniteQuery({
    queryKey: ['resource-activity', resourceId],
    queryFn: ({ pageParam }) => workspaceApi.resourceActivity(resourceId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.data.nextCursor ?? undefined,
  });

  if (query.isPending) return <TextSkeleton lines={5} />;
  if (query.isError) {
    return <ErrorState title="โหลดประวัติไม่สำเร็จ" onRetry={() => void query.refetch()} />;
  }

  // รวมทุกหน้าที่โหลดมาแล้วเป็นไทม์ไลน์เดียว เรียงจากใหม่ไปเก่า
  const items = query.data.pages.flatMap((page) => page.data.items);
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<History className="h-6 w-6" aria-hidden />}
        title="ยังไม่มีบันทึกกิจกรรม"
        description="เมื่อมีการแก้ไข อัปโหลด หรือเปลี่ยนสิทธิ์ของรายการนี้ ประวัติจะแสดงที่นี่"
        className="py-10"
      />
    );
  }

  return (
    <div className="space-y-3">
      <ol className="space-y-3">
        {items.map((entry) => {
          const detail = activityDetail(entry.action, entry.metadata);
          return (
            <li key={entry.id} className="flex gap-2.5">
              <span className="mt-1.5 flex flex-col items-center">
                <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_CLASS[activityTone(entry.action)]}`} aria-hidden />
              </span>
              <div className="min-w-0 flex-1 border-b border-line pb-3">
                <p className="text-[12.5px] font-medium text-navy-800">{activityLabel(entry.action)}</p>
                {detail ? <p className="mt-0.5 text-[11.5px] text-navy-500">{detail}</p> : null}
                <p className="mt-0.5 text-[11px] text-navy-400" title={formatDateTime(entry.createdAt)}>
                  {entry.actor ? entry.actor.displayName : 'ระบบ'} · {formatRelativeTime(entry.createdAt)}
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      {query.hasNextPage ? (
        <button
          type="button"
          className="s2-btn s2-btn-outline w-full"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'กำลังโหลด…' : 'ดูประวัติก่อนหน้า'}
        </button>
      ) : null}
    </div>
  );
}
