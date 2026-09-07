import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, RefreshCw, ShieldAlert, Sparkles } from 'lucide-react';
import { PageTitle } from '@/components/ui/PageTitle';
import { ApiError, legalHoldApi, retentionApi } from '@/lib/api';
import { thaiDate } from '@/lib/lifecycle';
import { useToast } from '@/hooks/useToast';

/**
 * หน้าจัดการนโยบายการเก็บรักษาและการระงับการลบ
 *
 * **ต้องแยกให้ชัดจากอายุของชุดสำรอง (F6)** ซึ่งอยู่ในหน้า Backup คนละหน้า
 *   - อายุชุดสำรอง = เก็บไฟล์สำรองของทั้งระบบไว้กี่ชุด
 *   - นโยบายการเก็บรักษา = ห้ามลบเอกสารฉบับนี้จนกว่าจะถึงเมื่อไร
 */

const ERROR_TEXT: Record<string, string> = {
  RETENTION_DENIED: 'คุณไม่มีสิทธิ์จัดการนโยบายการเก็บรักษา',
  RETENTION_POLICY_IN_USE: 'นโยบายนี้ยังมีเอกสารใช้อยู่ กรุณาปิดการใช้งานแทนการลบ',
  RETENTION_PERIOD_REQUIRED: 'กรุณาระบุจำนวนวัน หรือเลือกเก็บถาวร',
  RETENTION_NAME_REQUIRED: 'กรุณาระบุชื่อนโยบาย',
  LEGAL_HOLD_DENIED: 'คุณไม่มีสิทธิ์จัดการการระงับการลบ',
};

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? (ERROR_TEXT[error.code] ?? error.message ?? fallback) : fallback;

export default function AdminRetentionPage() {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [name, setName] = useState('');
  const [days, setDays] = useState('');
  const [forever, setForever] = useState(false);

  const policies = useQuery({
    queryKey: ['retention-policies', 'admin'],
    queryFn: () => retentionApi.list(true),
  });
  const holds = useQuery({ queryKey: ['legal-holds', 'admin'], queryFn: () => legalHoldApi.list() });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['retention-policies'] });
    void queryClient.invalidateQueries({ queryKey: ['legal-holds'] });
  };

  const create = useMutation({
    mutationFn: () =>
      retentionApi.create({
        name: name.trim(),
        retainForever: forever,
        retentionDays: forever ? null : Number(days),
      }),
    onSuccess: () => {
      setName('');
      setDays('');
      setForever(false);
      refresh();
      notify({ tone: 'success', title: 'เพิ่มนโยบายแล้ว' });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'เพิ่มไม่สำเร็จ') }),
  });

  const update = useMutation({
    mutationFn: (input: { id: string; isActive?: boolean; name?: string }) =>
      retentionApi.update(input.id, input),
    onSuccess: () => {
      refresh();
      notify({ tone: 'success', title: 'บันทึกแล้ว' });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'บันทึกไม่สำเร็จ') }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => retentionApi.remove(id),
    onSuccess: () => {
      refresh();
      notify({ tone: 'success', title: 'ลบนโยบายแล้ว' });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'ลบไม่สำเร็จ') }),
  });

  const reapply = useMutation({
    mutationFn: (id: string) => retentionApi.reapply(id),
    onSuccess: (result) => {
      refresh();
      notify({
        tone: 'success',
        title: `คำนวณวันหมดอายุใหม่ ${result.data.updated} รายการ`,
      });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'ดำเนินการไม่สำเร็จ') }),
  });

  const seed = useMutation({
    mutationFn: () => retentionApi.seedDefaults(),
    onSuccess: (result) => {
      refresh();
      notify({
        tone: 'success',
        title:
          result.data.created > 0
            ? `เพิ่มนโยบายตัวอย่าง ${result.data.created} รายการ`
            : 'นโยบายตัวอย่างมีอยู่ครบแล้ว',
      });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'เพิ่มไม่สำเร็จ') }),
  });

  const release = useMutation({
    mutationFn: (id: string) => legalHoldApi.release(id),
    onSuccess: () => {
      refresh();
      notify({ tone: 'success', title: 'ยกเลิกการระงับแล้ว' });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'ยกเลิกไม่สำเร็จ') }),
  });

  const rows = policies.data?.data ?? [];
  const holdRows = holds.data?.data ?? [];

  return (
    <div className="space-y-5">
      <PageTitle
        title="การเก็บรักษาเอกสาร"
        description="กำหนดว่าเอกสารแต่ละประเภทต้องเก็บไว้นานเท่าไร และจัดการการระงับการลบ"
      />

      {/*
        * เตือนให้ชัดตั้งแต่ต้น - ระยะเวลาที่ระบบมีมาให้เป็นตัวอย่าง ไม่ใช่คำแนะนำทางกฎหมาย
        * ระบบไม่ทราบว่าองค์กรต้องเก็บเอกสารชนิดใดนานเท่าไร และไม่ควรแกล้งทำเป็นรู้
        */}
      <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] leading-relaxed text-amber-800">
        ระยะเวลาที่ระบบมีมาให้เป็นเพียงตัวอย่างที่แก้ไขได้ <strong>ไม่ใช่คำแนะนำทางกฎหมาย</strong>{' '}
        และไม่รับประกันว่าสอดคล้องกับกฎหมายไทย องค์กรต้องกำหนดระยะเวลาเองตามที่ปรึกษาของตน
        <br />
        นโยบายนี้เป็นคนละเรื่องกับ <strong>อายุของชุดสำรองข้อมูล</strong> ซึ่งตั้งค่าในหน้า Backup
      </p>

      {/* ---------- นโยบาย ---------- */}
      <section className="space-y-2.5">
        <h2 className="text-[13px] font-semibold text-navy-800">นโยบายการเก็บรักษา</h2>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && (forever || Number(days) > 0)) create.mutate();
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-navy-500">ชื่อนโยบาย</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="เช่น เก็บ 5 ปี"
              maxLength={100}
              className="s2-input h-9 w-52 text-[12.5px]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-navy-500">จำนวนวัน</span>
            <input
              type="number"
              min={1}
              value={days}
              onChange={(event) => setDays(event.target.value)}
              disabled={forever}
              className="s2-input h-9 w-28 text-[12.5px] disabled:opacity-50"
            />
          </label>
          <label className="flex h-9 items-center gap-2 text-[12px] text-navy-600">
            <input
              type="checkbox"
              checked={forever}
              onChange={(event) => setForever(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-line"
            />
            เก็บถาวร
          </label>
          <button
            type="submit"
            disabled={create.isPending || !name.trim() || (!forever && !(Number(days) > 0))}
            className="s2-btn s2-btn-primary h-9 gap-1.5 text-[12.5px] disabled:opacity-60"
          >
            {create.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Plus className="h-4 w-4" aria-hidden />
            )}
            เพิ่มนโยบาย
          </button>
          {rows.length === 0 ? (
            <button
              type="button"
              onClick={() => seed.mutate()}
              disabled={seed.isPending}
              className="s2-btn s2-btn-outline h-9 gap-1.5 text-[12.5px] disabled:opacity-60"
            >
              <Sparkles className="h-4 w-4" aria-hidden />
              เพิ่มตัวอย่าง
            </button>
          ) : null}
        </form>

        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[640px] text-[12.5px]">
            <thead className="bg-[var(--s2-surface-soft)] text-left text-[11.5px] text-navy-500">
              <tr>
                <th className="px-3 py-2 font-medium">ชื่อ</th>
                <th className="px-3 py-2 font-medium">ระยะเวลา</th>
                <th className="px-3 py-2 font-medium">เอกสารที่ใช้</th>
                <th className="px-3 py-2 font-medium">สถานะ</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {policies.isPending ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-navy-400">
                    กำลังโหลด…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-navy-400">
                    ยังไม่มีนโยบายการเก็บรักษา
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="border-t border-line">
                    <td className="px-3 py-2 text-navy-800">{row.name}</td>
                    <td className="px-3 py-2 text-navy-600">
                      {row.retainForever ? 'เก็บถาวร' : `${row.retentionDays?.toLocaleString('th-TH')} วัน`}
                    </td>
                    <td className="px-3 py-2 text-navy-500">
                      {row.resourceCount.toLocaleString('th-TH')}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          row.isActive
                            ? 'rounded-md bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700'
                            : 'rounded-md bg-[var(--s2-surface-soft)] px-1.5 py-0.5 text-[11px] text-navy-400'
                        }
                      >
                        {row.isActive ? 'ใช้งาน' : 'ปิดอยู่'}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1.5">
                        {/* คำนวณใหม่เป็นการกระทำที่ต้องกดเอง ไม่ใช่ผลข้างเคียงของการแก้นิยาม */}
                        <button
                          type="button"
                          onClick={() => {
                            if (
                              window.confirm(
                                `คำนวณวันหมดอายุใหม่ให้เอกสาร ${row.resourceCount} รายการที่ใช้นโยบายนี้?`,
                              )
                            ) {
                              reapply.mutate(row.id);
                            }
                          }}
                          className="s2-btn s2-btn-ghost h-7 gap-1 px-2 text-[11.5px]"
                        >
                          <RefreshCw className="h-3 w-3" aria-hidden />
                          คำนวณใหม่
                        </button>
                        <button
                          type="button"
                          onClick={() => update.mutate({ id: row.id, isActive: !row.isActive })}
                          className="s2-btn s2-btn-ghost h-7 px-2 text-[11.5px]"
                        >
                          {row.isActive ? 'ปิดการใช้งาน' : 'เปิดใช้งาน'}
                        </button>
                        {row.resourceCount === 0 ? (
                          <button
                            type="button"
                            onClick={() => {
                              if (window.confirm(`ลบนโยบาย “${row.name}” ?`)) remove.mutate(row.id);
                            }}
                            className="s2-btn s2-btn-ghost h-7 px-2 text-[11.5px] text-rose-600"
                          >
                            ลบ
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---------- Legal Hold ---------- */}
      <section className="space-y-2.5">
        <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-navy-800">
          <ShieldAlert className="h-4 w-4 text-rose-600" aria-hidden />
          การระงับการลบที่ยังมีผล
        </h2>

        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[640px] text-[12.5px]">
            <thead className="bg-[var(--s2-surface-soft)] text-left text-[11.5px] text-navy-500">
              <tr>
                <th className="px-3 py-2 font-medium">เอกสาร</th>
                <th className="px-3 py-2 font-medium">เหตุผล</th>
                <th className="px-3 py-2 font-medium">อ้างอิง</th>
                <th className="px-3 py-2 font-medium">ผู้ระงับ</th>
                <th className="px-3 py-2 font-medium">เมื่อ</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {holds.isPending ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-navy-400">
                    กำลังโหลด…
                  </td>
                </tr>
              ) : holdRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-navy-400">
                    ไม่มีเอกสารที่ถูกระงับการลบ
                  </td>
                </tr>
              ) : (
                holdRows.map((hold) => (
                  <tr key={hold.id} className="border-t border-line">
                    <td className="max-w-[220px] truncate px-3 py-2 text-navy-800">
                      {hold.resourceName}
                    </td>
                    <td className="max-w-[240px] truncate px-3 py-2 text-navy-600">{hold.reason}</td>
                    <td className="px-3 py-2 text-navy-500">{hold.caseReference ?? '—'}</td>
                    <td className="px-3 py-2 text-navy-600">{hold.createdBy.displayName}</td>
                    <td className="px-3 py-2 text-navy-500">{thaiDate(hold.createdAt)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`ยกเลิกการระงับของ “${hold.resourceName}” ?`)) {
                            release.mutate(hold.id);
                          }
                        }}
                        className="s2-btn s2-btn-ghost h-7 px-2 text-[11.5px]"
                      >
                        ยกเลิกการระงับ
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
