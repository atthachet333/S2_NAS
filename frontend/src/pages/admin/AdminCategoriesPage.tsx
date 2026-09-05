import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Sparkles } from 'lucide-react';
import { PageTitle } from '@/components/ui/PageTitle';
import { ApiError, categoryApi } from '@/lib/api';
import { useToast } from '@/hooks/useToast';

/**
 * จัดการประเภทเอกสาร
 *
 * ปิดการใช้งานแทนการลบเป็นค่าเริ่มต้น - ประเภทที่ยังมีเอกสารอ้างถึงลบไม่ได้
 * เพราะจะทำให้การจัดประเภทที่คนนั่งทำไว้หลายร้อยฉบับหายไปโดยกู้กลับไม่ได้
 */

const ERROR_TEXT: Record<string, string> = {
  CATEGORY_EXISTS: 'มีประเภทเอกสารชื่อนี้อยู่แล้ว',
  CATEGORY_IN_USE: 'ประเภทนี้ยังมีเอกสารใช้อยู่ กรุณาปิดการใช้งานแทนการลบ',
  CATEGORY_DENIED: 'คุณไม่มีสิทธิ์จัดการประเภทเอกสาร',
  CATEGORY_NAME_REQUIRED: 'กรุณาระบุชื่อประเภทเอกสาร',
  CATEGORY_NOT_FOUND: 'ไม่พบประเภทเอกสารนี้แล้ว',
};

const message = (error: unknown, fallback: string) =>
  error instanceof ApiError ? (ERROR_TEXT[error.code] ?? error.message ?? fallback) : fallback;

export default function AdminCategoriesPage() {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [name, setName] = useState('');

  const categories = useQuery({
    queryKey: ['document-categories', 'admin'],
    queryFn: () => categoryApi.list(true),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['document-categories'] });
  };

  const create = useMutation({
    mutationFn: () => categoryApi.create({ name: name.trim() }),
    onSuccess: () => {
      setName('');
      invalidate();
      notify({ tone: 'success', title: 'เพิ่มประเภทเอกสารแล้ว' });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'เพิ่มไม่สำเร็จ') }),
  });

  const update = useMutation({
    mutationFn: (input: { id: string; name?: string; isActive?: boolean; sortOrder?: number }) =>
      categoryApi.update(input.id, input),
    onSuccess: () => {
      invalidate();
      notify({ tone: 'success', title: 'บันทึกแล้ว' });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'บันทึกไม่สำเร็จ') }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => categoryApi.remove(id),
    onSuccess: () => {
      invalidate();
      notify({ tone: 'success', title: 'ลบประเภทเอกสารแล้ว' });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'ลบไม่สำเร็จ') }),
  });

  const seed = useMutation({
    mutationFn: () => categoryApi.seedDefaults(),
    onSuccess: (result) => {
      invalidate();
      notify({
        tone: 'success',
        title:
          result.data.created > 0
            ? `เพิ่มประเภทเริ่มต้น ${result.data.created} รายการ`
            : 'ประเภทเริ่มต้นมีอยู่ครบแล้ว',
      });
    },
    onError: (error) => notify({ tone: 'error', title: message(error, 'เพิ่มไม่สำเร็จ') }),
  });

  const rows = categories.data?.data ?? [];

  return (
    <div className="space-y-4">
      <PageTitle
        title="ประเภทเอกสาร"
        description="กำหนดประเภทที่ใช้จัดหมวดเอกสารขององค์กร ใช้เป็นตัวกรองในการค้นหาได้"
      />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) create.mutate();
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="ชื่อประเภทเอกสาร เช่น ใบกำกับภาษี"
          maxLength={100}
          aria-label="ชื่อประเภทเอกสาร"
          className="s2-input h-9 w-full max-w-xs text-[12.5px]"
        />
        <button
          type="submit"
          disabled={!name.trim() || create.isPending}
          className="s2-btn s2-btn-primary h-9 gap-1.5 text-[12.5px] disabled:opacity-60"
        >
          {create.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Plus className="h-4 w-4" aria-hidden />
          )}
          เพิ่มประเภท
        </button>

        {rows.length === 0 ? (
          <button
            type="button"
            onClick={() => seed.mutate()}
            disabled={seed.isPending}
            className="s2-btn s2-btn-outline h-9 gap-1.5 text-[12.5px] disabled:opacity-60"
          >
            <Sparkles className="h-4 w-4" aria-hidden />
            เพิ่มประเภทเริ่มต้น
          </button>
        ) : null}
      </form>

      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-[560px] text-[12.5px]">
          <thead className="bg-[var(--s2-surface-soft)] text-left text-[11.5px] text-navy-500">
            <tr>
              <th className="px-3 py-2 font-medium">ชื่อ</th>
              <th className="px-3 py-2 font-medium">เอกสารที่ใช้</th>
              <th className="px-3 py-2 font-medium">ลำดับ</th>
              <th className="px-3 py-2 font-medium">สถานะ</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {categories.isPending ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-navy-400">
                  กำลังโหลด…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-navy-400">
                  ยังไม่มีประเภทเอกสาร
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="border-t border-line">
                  <td className="px-3 py-2 text-navy-800">{row.name}</td>
                  <td className="px-3 py-2 text-navy-500">{row.resourceCount.toLocaleString('th-TH')}</td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      defaultValue={row.sortOrder}
                      aria-label={`ลำดับของ ${row.name}`}
                      onBlur={(event) => {
                        const value = Number(event.target.value);
                        if (value !== row.sortOrder) update.mutate({ id: row.id, sortOrder: value });
                      }}
                      className="s2-input h-7 w-16 text-[12px]"
                    />
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
                      <button
                        type="button"
                        onClick={() => {
                          const next = window.prompt('ชื่อใหม่ของประเภทเอกสาร', row.name);
                          if (next && next.trim() && next !== row.name) {
                            update.mutate({ id: row.id, name: next.trim() });
                          }
                        }}
                        className="s2-btn s2-btn-ghost h-7 px-2 text-[11.5px]"
                      >
                        เปลี่ยนชื่อ
                      </button>
                      <button
                        type="button"
                        onClick={() => update.mutate({ id: row.id, isActive: !row.isActive })}
                        className="s2-btn s2-btn-ghost h-7 px-2 text-[11.5px]"
                      >
                        {row.isActive ? 'ปิดการใช้งาน' : 'เปิดใช้งาน'}
                      </button>
                      {/* ลบได้เฉพาะประเภทที่ไม่มีเอกสารใช้อยู่ */}
                      {row.resourceCount === 0 ? (
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`ลบประเภท “${row.name}” ?`)) remove.mutate(row.id);
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
    </div>
  );
}
