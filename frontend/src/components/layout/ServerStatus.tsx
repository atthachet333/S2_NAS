import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/** สถานะเซิร์ฟเวอร์บน header - ดึงจาก /api/health จริง */
export function ServerStatus({ compact = false }: { compact?: boolean }) {
  const { data, isPending, isError } = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 20_000,
    retry: 1,
  });

  const state = isPending
    ? { label: 'กำลังตรวจสอบ', dot: 'bg-navy-300', text: 'text-navy-400', ping: false }
    : isError
      ? { label: 'ออฟไลน์', dot: 'bg-red-500', text: 'text-red-600', ping: false }
      : data?.status === 'ok'
        ? { label: 'ออนไลน์', dot: 'bg-emerald-500', text: 'text-emerald-700', ping: true }
        : { label: 'ทำงานบางส่วน', dot: 'bg-amber-500', text: 'text-amber-700', ping: false };

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full px-2 py-1.5',
        compact && 'px-2',
      )}
      title={state.label}
    >
      <span className="relative flex h-1.5 w-1.5">
        {state.ping ? (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
        ) : null}
        <span className={cn('relative inline-flex h-1.5 w-1.5 rounded-full', state.dot)} />
      </span>
      {!compact ? <span className={cn('text-[12px] font-medium', state.text)}>{state.label}</span> : null}
    </div>
  );
}
