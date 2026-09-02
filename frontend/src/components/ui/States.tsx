import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Skeleton สำหรับ grid view */
export function GridSkeleton({ count = 10 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="s2-surface p-3">
          <div className="s2-skeleton h-9 w-9 rounded-[10px]" />
          <div className="s2-skeleton mt-3 h-3 w-4/5" />
          <div className="s2-skeleton mt-2 h-2.5 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/** Skeleton สำหรับ list view */
export function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="s2-surface overflow-hidden">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
          <div className="s2-skeleton h-7 w-7 rounded-lg" />
          <div className="s2-skeleton h-3 flex-1 max-w-[42%]" />
          <div className="s2-skeleton hidden h-3 w-24 md:block" />
          <div className="s2-skeleton hidden h-3 w-28 lg:block" />
          <div className="s2-skeleton h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

export function TextSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: lines }).map((_, index) => (
        <div key={index} className={cn('s2-skeleton h-3', index === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  footer,
  className,
  compact = false,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  footer?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn(compact ? 'flex flex-col items-center justify-center gap-2.5 px-5 py-10 text-center' : 's2-surface flex min-h-[430px] flex-col items-center justify-center gap-2.5 overflow-hidden px-6 py-14 text-center shadow-subtle', className)}>
      {icon ? (
        <div className="relative mb-2 flex h-16 w-16 items-center justify-center rounded-[20px] border border-brand-200 bg-brand-50 text-brand-600 shadow-raised before:absolute before:-inset-4 before:-z-10 before:rounded-full before:bg-brand-50/40">
          {icon}
        </div>
      ) : null}
      <p className="text-[15px] font-medium text-navy-800">{title}</p>
      {description ? (
        <p className="max-w-md text-[13px] leading-relaxed text-navy-400">{description}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
      {footer ? <div className="mt-5 w-full">{footer}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = 'ไม่สามารถโหลดข้อมูลได้',
  message,
  onRetry,
  className,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-14 text-center', className)}>
      <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-2xl bg-red-50 text-red-500">
        <AlertCircle className="h-5 w-5" aria-hidden />
      </div>
      <p className="text-[14px] font-medium text-navy-800">{title}</p>
      <p className="max-w-md text-[12px] leading-relaxed text-navy-400">
        {message ?? 'กรุณาลองใหม่อีกครั้ง หรือติดต่อผู้ดูแลระบบ'}
      </p>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="s2-btn s2-btn-outline mt-3">
          ลองใหม่อีกครั้ง
        </button>
      ) : null}
    </div>
  );
}
