import { useQuery } from '@tanstack/react-query';
import { ArrowRight, UserRoundCog } from 'lucide-react';
import { usersApi } from '@/lib/api';
import { OwnerIdentity } from './OwnerIdentity';

/**
 * ตัวเลือกผู้ดูแลโฟลเดอร์
 *
 * แสดงเฉพาะผู้ใช้สถานะ ACTIVE เท่านั้น ผู้ใช้ที่ยัง INVITED หรือถูกปิดใช้งาน
 * รับผิดชอบทรัพยากรไม่ได้ และเซิร์ฟเวอร์จะปฏิเสธอยู่แล้ว
 */
export function OwnerPicker({
  value,
  onChange,
  currentOwner,
  /** true เมื่อกำลังโอนผู้ดูแล จะแสดงคู่เปรียบเทียบ ปัจจุบัน → ใหม่ */
  showTransfer = false,
  disabled = false,
}: {
  value: string;
  onChange: (id: string) => void;
  currentOwner?: { displayName: string; email: string };
  showTransfer?: boolean;
  disabled?: boolean;
}) {
  const { data, isPending } = useQuery({ queryKey: ['active-users'], queryFn: () => usersApi.list({ limit: 100 }) });
  const activeUsers = (data?.data.items ?? []).filter((item) => item.status === 'ACTIVE');
  const selected = activeUsers.find((item) => item.id === value);

  if (disabled) {
    return (
      <div className="rounded-xl border border-line bg-[var(--s2-surface-soft)] px-3 py-2.5">
        {currentOwner ? <OwnerIdentity owner={currentOwner} caption={currentOwner.email} size="sm" /> : null}
        <p className="mt-2 text-[10.5px] text-navy-400">
          บัญชีของคุณกำหนดผู้ดูแลรายอื่นไม่ได้ โฟลเดอร์นี้จะอยู่ในความดูแลของคุณ
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {showTransfer && currentOwner ? (
        <div className="flex items-center gap-2 rounded-xl border border-line bg-[var(--s2-surface-soft)] px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="s2-section-title">ผู้ดูแลปัจจุบัน</p>
            <div className="mt-1.5">
              <OwnerIdentity owner={currentOwner} caption={currentOwner.email} size="sm" />
            </div>
          </div>

          <ArrowRight className="h-4 w-4 shrink-0 text-navy-300" aria-hidden />

          <div className="min-w-0 flex-1">
            <p className="s2-section-title">ผู้ดูแลใหม่</p>
            <div className="mt-1.5">
              {selected ? (
                <OwnerIdentity owner={selected} caption={selected.email} size="sm" />
              ) : (
                <p className="text-[11.5px] text-navy-400">ยังไม่ได้เลือก</p>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <select
        className="s2-input h-11 rounded-xl px-3 text-[13px]"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label="เลือกผู้ดูแล"
      >
        {isPending ? <option value="">กำลังโหลดรายชื่อ…</option> : null}
        {activeUsers.map((item) => (
          <option key={item.id} value={item.id}>
            {item.displayName} · {item.email}
          </option>
        ))}
      </select>

      {!isPending && activeUsers.length <= 1 ? (
        <p className="flex items-start gap-2 rounded-xl border border-dashed border-line px-3 py-2.5 text-[11px] leading-relaxed text-navy-400">
          <UserRoundCog className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          ขณะนี้มีผู้ใช้ที่เปิดใช้งานเพียงบัญชีเดียว จึงยังโอนให้ผู้อื่นไม่ได้
        </p>
      ) : (
        <p className="text-[11px] leading-relaxed text-navy-400">
          ผู้ดูแลใหม่จะเป็นผู้รับผิดชอบหลักของโฟลเดอร์นี้
        </p>
      )}
    </div>
  );
}
