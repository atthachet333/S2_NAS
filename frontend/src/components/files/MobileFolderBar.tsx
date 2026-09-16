import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, FolderTree } from 'lucide-react';
import type { BreadcrumbNode } from '@/lib/drive';
import { Sheet, SheetItem } from '@/components/ui/Sheet';
import { parentDestination } from '@/lib/folder-navigation';

/**
 * การนำทางโฟลเดอร์บนจอแคบ (F24-C)
 *
 * **ทำไมไม่ใช้เส้นทางแบบเต็ม:** ชื่อโฟลเดอร์ของระบบนี้เป็นชื่อลูกค้าและชื่อหมวดเอกสาร
 * ซึ่งยาวโดยธรรมชาติ เส้นทางสามระดับกินความกว้างเกิน 375px ตั้งแต่ระดับที่สอง
 * ผลคือแถบที่ต้องเลื่อนแนวนอน ซึ่งชนกับการปัดเพื่อย้อนกลับของเบราว์เซอร์
 *
 * **ปุ่มย้อนกลับไปที่โฟลเดอร์แม่ ไม่ใช่ประวัติของเบราว์เซอร์** ผู้ใช้ที่มาถึงโฟลเดอร์นี้
 * จากการค้นหา ย่อมคาดหวังว่าปุ่มย้อนกลับในหน้าไฟล์จะพาขึ้นไปหนึ่งชั้น
 * ไม่ใช่กลับไปหน้าผลการค้นหา ซึ่งเป็นคนละความหมายกัน
 */
export function MobileFolderBar({
  root,
  rootTo,
  nodes,
}: {
  root: string;
  rootTo: string;
  nodes: BreadcrumbNode[];
}) {
  const [pathOpen, setPathOpen] = useState(false);
  const navigate = useNavigate();

  const current = nodes[nodes.length - 1];
  const destination = parentDestination(nodes, rootTo);
  const ancestors = nodes.slice(0, -1);

  return (
    <div className="flex items-center gap-1 md:hidden">
      <button
        type="button"
        onClick={() => navigate(destination.to)}
        disabled={destination.atRoot}
        aria-label={destination.atRoot ? 'อยู่ที่ระดับบนสุดแล้ว' : `ขึ้นไปยัง ${destination.label}`}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-navy-500 transition-colors hover:bg-navy-50 disabled:opacity-35"
      >
        <ChevronLeft className="h-5 w-5" aria-hidden />
      </button>

      <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-navy-900">
        {current?.name ?? root}
      </span>

      {/* เส้นทางเต็มยังเข้าถึงได้ แต่ไม่กินพื้นที่จนกว่าจะถูกขอ */}
      {ancestors.length > 0 ? (
        <button
          type="button"
          onClick={() => setPathOpen(true)}
          aria-label="แสดงเส้นทางทั้งหมด"
          aria-haspopup="dialog"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-navy-400 transition-colors hover:bg-navy-50 hover:text-navy-700"
        >
          <FolderTree className="h-[18px] w-[18px]" aria-hidden />
        </button>
      ) : null}

      <Sheet open={pathOpen} title="เส้นทางโฟลเดอร์" onClose={() => setPathOpen(false)}>
        <SheetItem label={root} onSelect={() => { setPathOpen(false); navigate(rootTo); }} />
        {ancestors.map((node) => (
          <SheetItem
            key={node.id ?? node.name}
            label={node.name}
            onSelect={() => { setPathOpen(false); navigate(node.id ? `${rootTo}/${node.id}` : rootTo); }}
          />
        ))}
      </Sheet>
    </div>
  );
}
