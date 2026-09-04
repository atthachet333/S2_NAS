import { useEffect, useState } from 'react';
import { FolderUp, Inbox, Search } from 'lucide-react';
import { portalApi, type PortalHomeDto, type PortalResourceDto } from '@/lib/api';
import { PortalItemList } from '@/components/portal/PortalItemList';
import { ListSkeleton } from '@/components/ui/States';

/**
 * หน้าแรกของพื้นที่เอกสารสำหรับลูกค้า
 *
 * ตอบสามคำถามที่ลูกค้าถามจริง: มีอะไรแชร์ให้ฉัน อะไรเพิ่งเข้ามา และฉันส่งไฟล์เข้าที่ไหนได้
 * ไม่มีแผงสถิติ เพราะลูกค้าเห็นเพียงบางส่วนของระบบ ตัวเลขรวมจึงไม่มีความหมายและชวนให้เข้าใจผิด
 */
export default function PortalHomePage() {
  const [data, setData] = useState<PortalHomeDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<PortalResourceDto[] | null>(null);

  useEffect(() => {
    let active = true;
    portalApi
      .home()
      .then((response) => {
        if (active) setData(response.data);
      })
      .catch(() => {
        if (active) setData({ shared: [], recentUploads: [], uploadFolders: [] });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  /** ค้นหาเฉพาะในขอบเขตของตัวเอง - เซิร์ฟเวอร์เป็นผู้จำกัดขอบเขต ไม่ใช่หน้าจอ */
  useEffect(() => {
    const query = term.trim();
    if (query.length < 2) {
      setResults(null);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      portalApi
        .search(query)
        .then((response) => {
          if (active) setResults(response.data);
        })
        .catch(() => {
          if (active) setResults([]);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [term]);

  if (loading) return <ListSkeleton rows={5} />;

  const hasAnything = (data?.shared.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[19px] font-semibold text-navy-900">พื้นที่เอกสารสำหรับลูกค้า</h1>
        <p className="mt-1 text-[12.5px] text-navy-400">
          เอกสารทั้งหมดที่บริษัทแชร์ให้คุณอยู่ที่นี่
        </p>
      </div>

      {hasAnything ? (
        <label className="s2-surface flex items-center gap-2 px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-navy-300" aria-hidden />
          <input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="ค้นหาเอกสารที่แชร์ให้คุณ"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-navy-800 outline-none placeholder:text-navy-300"
          />
        </label>
      ) : null}

      {results !== null ? (
        <section>
          <h2 className="mb-2 text-[13px] font-semibold text-navy-800">ผลการค้นหา</h2>
          {results.length === 0 ? (
            <p className="s2-surface px-4 py-6 text-center text-[12.5px] text-navy-400">
              ไม่พบเอกสารที่ตรงกับคำค้นในเอกสารที่แชร์ให้คุณ
            </p>
          ) : (
            /* ผลการค้นหามาจากหลายโฟลเดอร์ จึงต้องบอกด้วยว่าแต่ละรายการอยู่ที่ไหน */
            <PortalItemList items={results} showPath term={term} />
          )}
        </section>
      ) : null}

      {!hasAnything ? (
        /* สถานะว่างต้องบอกด้วยว่าต้องทำอะไรต่อ ไม่ใช่แค่บอกว่าว่าง */
        <div className="s2-surface flex flex-col items-center gap-3 px-6 py-14 text-center">
          <Inbox className="h-9 w-9 text-navy-200" aria-hidden />
          <p className="text-[14px] font-medium text-navy-800">ยังไม่มีเอกสารที่แชร์ให้คุณ</p>
          <p className="max-w-[420px] text-[12.5px] text-navy-400">
            กรุณาติดต่อผู้ดูแลหากคุณคิดว่าควรมีสิทธิ์เข้าถึงเอกสาร
          </p>
        </div>
      ) : null}

      {results === null && hasAnything ? (
        <>
          <section>
            <h2 className="mb-2 text-[13px] font-semibold text-navy-800">เอกสารที่แชร์กับฉัน</h2>
            <PortalItemList items={data!.shared} />
          </section>

          {data!.recentUploads.length > 0 ? (
            <section>
              <h2 className="mb-2 text-[13px] font-semibold text-navy-800">ไฟล์ล่าสุด</h2>
              <PortalItemList items={data!.recentUploads} />
            </section>
          ) : null}

          {/* แสดงส่วนอัปโหลดก็ต่อเมื่อมีโฟลเดอร์ที่อัปโหลดได้จริง ไม่ชวนให้กดสิ่งที่ทำไม่ได้ */}
          {data!.uploadFolders.length > 0 ? (
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-navy-800">
                <FolderUp className="h-4 w-4 text-navy-400" aria-hidden />
                โฟลเดอร์ที่อัปโหลดได้
              </h2>
              <PortalItemList items={data!.uploadFolders} />
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
