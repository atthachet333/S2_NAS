import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { useOutsideClose } from '@/hooks/useOutsideClose';
import type { BreadcrumbNode } from '@/lib/drive';
import { cn } from '@/lib/utils';

/**
 * เส้นทางโฟลเดอร์ V3
 *
 * ลำดับชั้นที่ลึกจะถูกย่อระดับกลางให้เหลือปุ่ม "…" ที่กดเปิดดูได้
 * จึงเห็นต้นทางกับปลายทางเสมอ แม้บนหน้าจอแคบ
 */
const MAX_VISIBLE = 3;

export function Breadcrumb({
  root,
  nodes,
  className,
}: {
  root: string;
  nodes: BreadcrumbNode[];
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
  useOutsideClose(menuRef, expanded, () => setExpanded(false));

  const collapsed = nodes.length > MAX_VISIBLE;
  const hiddenNodes = collapsed ? nodes.slice(0, nodes.length - 2) : [];
  const visibleNodes = collapsed ? nodes.slice(nodes.length - 2) : nodes;

  return (
    <nav
      aria-label="เส้นทางโฟลเดอร์"
      className={cn(
        'flex min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap text-[12.5px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      <Link
        to="/files"
        className={cn(
          'shrink-0 rounded-md px-1.5 py-0.5 transition-colors hover:bg-navy-50',
          nodes.length === 0 ? 'font-semibold text-navy-800' : 'text-navy-500 hover:text-navy-800',
        )}
        aria-current={nodes.length === 0 ? 'page' : undefined}
      >
        {root}
      </Link>

      {collapsed ? (
        <span className="relative flex shrink-0 items-center gap-1" ref={menuRef}>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-navy-300" aria-hidden />
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={`แสดงอีก ${hiddenNodes.length} ระดับ`}
            className="rounded-md px-1 py-0.5 text-navy-400 transition-colors hover:bg-navy-50 hover:text-navy-700"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>

          {expanded ? (
            <span role="menu" className="s2-menu absolute left-0 top-full z-[var(--z-menu)] mt-1.5 block w-56">
              {hiddenNodes.map((node) => (
                <Link
                  key={node.id ?? node.name}
                  to={node.id ? `/files/${node.id}` : '/files'}
                  role="menuitem"
                  onClick={() => setExpanded(false)}
                  className="s2-menu-item"
                >
                  <span className="truncate">{node.name}</span>
                </Link>
              ))}
            </span>
          ) : null}
        </span>
      ) : null}

      {visibleNodes.map((node, index) => {
        const last = index === visibleNodes.length - 1;
        return (
          <span key={node.id ?? node.name} className="flex min-w-0 shrink-0 items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-navy-300" aria-hidden />
            {last ? (
              <span className="max-w-[42vw] truncate px-1.5 py-0.5 font-semibold text-navy-800 sm:max-w-none" aria-current="page">
                {node.name}
              </span>
            ) : (
              <Link
                to={node.id ? `/files/${node.id}` : '/files'}
                className="max-w-[32vw] truncate rounded-md px-1.5 py-0.5 text-navy-500 transition-colors hover:bg-navy-50 hover:text-navy-800 sm:max-w-none"
              >
                {node.name}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
