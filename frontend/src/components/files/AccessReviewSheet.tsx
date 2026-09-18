import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Loader2, ShieldAlert, Users } from 'lucide-react';
import { CLASSIFICATION_LABEL, accessReviewApi, authorizedFetch } from '@/lib/api';
import { Sheet } from '@/components/ui/Sheet';

const SOURCE_LABEL = { OWNER: 'ผู้ดูแลหลัก', DIRECT: 'โดยตรง', INHERITED: 'สืบทอด', ROLE: 'บทบาท/ขอบเขตองค์กร', WORKFLOW: 'คำขอความร่วมมือ' } as const;
const ROLE_LABEL = { OWNER: 'ผู้ดูแล', EDITOR: 'แก้ไข', VIEWER: 'ดู', CONTRIBUTOR: 'อัปโหลด' } as const;

/**
 * เหตุผลที่สิทธิ์ใช้ไม่ได้ - ต่างกันคนละเรื่อง จึงบอกคนละข้อความ
 *
 * ผู้ตรวจสอบที่เห็นแค่ "ไม่มีผล" เหมือนกันหมดจะไปตามแก้ผิดทาง
 * หมดอายุแก้ด้วยการต่ออายุ ส่วนติดชั้นความลับแก้ด้วยการตัดสินใจเรื่องการเปิดเผย
 */
const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'ใช้งานได้',
  PRINCIPAL_INACTIVE: 'บัญชีถูกปิด',
  EXPIRED: 'หมดอายุ',
  RESOURCE_UNAVAILABLE: 'เอกสารไม่พร้อมใช้',
  CLASSIFICATION_RESTRICTED: 'ติดชั้นความลับ',
};

export function AccessReviewButton({ resourceId, resourceName }: { resourceId: string; resourceName: string }) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const review = useQuery({
    queryKey: ['access-review', resourceId],
    queryFn: () => accessReviewApi.get(resourceId),
    enabled: open,
    retry: false,
  });

  const download = async () => {
    setExporting(true);
    try {
      const response = await authorizedFetch(accessReviewApi.exportPath(resourceId));
      if (!response.ok) throw new Error('export failed');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `access-review-${resourceId}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const data = review.data?.data;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="s2-btn s2-btn-outline min-h-11 w-full gap-1.5 text-[12px]">
        <Users className="h-3.5 w-3.5" aria-hidden />
        ตรวจสอบการเข้าถึง
      </button>
      <Sheet
        open={open}
        title={`การเข้าถึง · ${resourceName}`}
        onClose={() => setOpen(false)}
        footer={data ? (
          <button type="button" onClick={() => void download()} disabled={exporting} className="s2-btn s2-btn-outline min-h-11 w-full gap-2 text-[12px]">
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
            ส่งออก CSV
          </button>
        ) : undefined}
      >
        {review.isPending ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-navy-400" aria-hidden /></div>
        ) : review.isError ? (
          <div className="flex items-center gap-2 rounded-xl bg-rose-50 p-3 text-[12px] text-rose-700"><ShieldAlert className="h-4 w-4" aria-hidden />ไม่มีสิทธิ์หรือโหลดข้อมูลไม่สำเร็จ</div>
        ) : data ? (
          <div className="space-y-3 p-1">
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <Stat label="ผู้ใช้ที่เข้าถึงได้" value={data.summary.effectiveUsers} />
              <Stat label="ลิงก์สาธารณะใช้งานได้" value={data.summary.activePublicLinks} />
              <Stat label="ลูกค้าใน Portal" value={data.summary.portalUsers} />
              <Stat label="สิทธิ์ที่หยุดใช้งาน" value={data.summary.assignedButInactive} />
            </div>
            {/*
              * ข้อจำกัดจากนโยบายอยู่เป็นก้อนของตัวเอง เหนือรายการสิทธิ์
              *
              * ไม่ยุบรวมกับหลักฐานการแชร์โดยตั้งใจ - หลักฐานตอบว่า "ใครถูกมอบสิทธิ์อะไรไว้"
              * ซึ่งเป็นข้อเท็จจริงที่แก้ไม่ได้ ส่วนก้อนนี้ตอบว่า "นโยบายวันนี้ปิดอะไรอยู่"
              * ซึ่งเปลี่ยนได้ทุกเมื่อ ถ้ายุบรวมกัน การเปลี่ยนนโยบายจะดูเหมือนการลบประวัติการแชร์
              */}
            <section className="rounded-xl border border-line p-3 text-[11.5px]">
              <h3 className="font-semibold text-navy-700">ชั้นความลับ</h3>
              <p className="mt-0.5 text-navy-600">
                {CLASSIFICATION_LABEL[data.classificationPolicy.level]}
                {data.resource.classifiedAt ? '' : ' · ค่าเริ่มต้นของระบบ ยังไม่มีใครจัดชั้น'}
              </p>
              {data.classificationPolicy.publicLinkBlocked || data.classificationPolicy.externalAccessBlocked ? (
                <ul className="mt-1 list-inside list-disc text-[10.5px] text-navy-400">
                  {data.classificationPolicy.publicLinkBlocked ? <li>ลิงก์สาธารณะถูกปิดด้วยนโยบายนี้</li> : null}
                  {data.classificationPolicy.externalAccessBlocked ? <li>การเข้าถึงจาก Portal ถูกปิดด้วยนโยบายนี้</li> : null}
                  <li>สิทธิ์และลิงก์ที่มีอยู่ยังถูกเก็บไว้ครบ ไม่ได้ถูกลบ</li>
                </ul>
              ) : (
                <p className="mt-0.5 text-[10.5px] text-navy-400">นโยบายนี้ไม่ได้ปิดช่องทางใด</p>
              )}
            </section>
            <section>
              <h3 className="px-1 text-[11.5px] font-semibold text-navy-700">Effective Access</h3>
              <ul className="mt-1 space-y-2">
                {data.entries.map((entry) => (
                  <li key={`${entry.channel}-${entry.subject.id}`} className="rounded-xl border border-line p-3 text-[11.5px]">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0"><p className="truncate font-medium text-navy-800">{entry.subject.displayName}</p><p className="truncate text-[10.5px] text-navy-400">{entry.subject.email} · {entry.channel === 'PORTAL' ? 'Portal' : 'ภายใน'}</p></div>
                      <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] ${entry.usable ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : entry.status === 'CLASSIFICATION_RESTRICTED' ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>{STATUS_LABEL[entry.status] ?? 'ไม่มีผล'}</span>
                    </div>
                    <p className="mt-1 text-navy-600">ผล: {ROLE_LABEL[entry.effectiveRole]} · {entry.allowDownload ? 'ดาวน์โหลดได้' : 'ดาวน์โหลดไม่ได้'}</p>
                    <ul className="mt-1 space-y-0.5 text-[10.5px] text-navy-400">
                      {entry.evidence.map((evidence, index) => <li key={`${evidence.sourceResourceId}-${index}`}>{SOURCE_LABEL[evidence.source]} · {ROLE_LABEL[evidence.role]}{evidence.source === 'INHERITED' ? ` จาก ${evidence.sourceResourceName}` : ''}{!evidence.active ? ' · ไม่มีผล' : ''}</li>)}
                    </ul>
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h3 className="px-1 text-[11.5px] font-semibold text-navy-700">Public Links</h3>
              <ul className="mt-1 space-y-1">
                {data.publicLinks.length ? data.publicLinks.map((link) => <li key={link.id} className="rounded-xl border border-line px-3 py-2 text-[11px] text-navy-600">{link.label ?? 'ไม่มีชื่อกำกับ'} · {link.status} · {link.allowDownload ? 'ดาวน์โหลดได้' : 'ดูเท่านั้น'}{link.source === 'INHERITED' ? ` · สืบทอดจาก ${link.sourceResourceName}` : ''}</li>) : <li className="px-1 text-[11px] text-navy-400">ไม่มีลิงก์สาธารณะ</li>}
              </ul>
            </section>
          </div>
        ) : null}
      </Sheet>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-lg border border-line bg-[var(--s2-surface-soft)] p-2"><span className="block text-navy-400">{label}</span><strong className="text-[14px] text-navy-800">{value}</strong></div>;
}
