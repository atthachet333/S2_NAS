import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Search, ShieldCheck, UserCheck, UserRoundCog, Users, UserX } from 'lucide-react';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';
import { OwnerIdentity } from '@/components/files/OwnerIdentity';
import { UserActionDialog, type UserDialogMode } from '@/components/admin/UserActionDialog';
import { usersApi, type PublicUser, type UserStatus } from '@/lib/api';
import { canActivate, canDisable, userStatusHint, userStatusLabel, userStatusTone } from '@/lib/user-text';
import { formatDateTime, formatRelativeTime } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';

const STATUS_CLASS: Record<string, string> = {
  positive: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-700',
  danger: 'border-red-200 bg-red-50 text-red-700',
  neutral: 'border-line bg-[var(--s2-surface-soft)] text-navy-500',
};

/**
 * จัดการบัญชีผู้ใช้
 *
 * ใช้ข้อมูลจริงจาก User / Role ในฐานข้อมูล ไม่มีข้อมูลตัวอย่าง
 * ทุกการกระทำถูกตรวจสิทธิ์ที่เซิร์ฟเวอร์อีกชั้น การซ่อนปุ่มเป็นเพียงเรื่องของการใช้งาน
 */
export default function AdminUsersPage() {
  const { user: currentUser } = useAuth();
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<UserStatus | ''>('');
  const [roleCode, setRoleCode] = useState('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [dialog, setDialog] = useState<{ mode: UserDialogMode; user: PublicUser } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(term.trim());
      setCursor(undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [term]);

  const roles = useQuery({ queryKey: ['roles'], queryFn: usersApi.roles });

  const users = useQuery({
    queryKey: ['admin-users', debounced, status, roleCode, cursor],
    queryFn: () =>
      usersApi.list({
        q: debounced || undefined,
        status: status || undefined,
        roleCode: roleCode || undefined,
        limit: 25,
        cursor,
      }),
  });

  const page = users.data?.data;
  const rows = page?.items ?? [];

  return (
    <div className="space-y-4">
      <PageTitle title="ผู้ใช้งาน" description="จัดการบัญชีผู้ใช้ สถานะ และบทบาทในระบบ" />

      <Panel>
        <PanelHeader title="ค้นหาและกรอง" description="ค้นจากชื่อหรืออีเมล และกรองตามสถานะหรือบทบาท" />
        <PanelBody>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block text-[11.5px] font-semibold text-navy-700">
              ค้นหา
              <span className="relative mt-1 block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-navy-300" aria-hidden />
                <input
                  className="s2-input h-9 rounded-lg pl-9 pr-2 text-[12.5px]"
                  placeholder="ชื่อหรืออีเมล"
                  value={term}
                  onChange={(event) => setTerm(event.target.value)}
                />
              </span>
            </label>

            <label className="block text-[11.5px] font-semibold text-navy-700">
              สถานะ
              <select
                className="s2-input mt-1 h-9 rounded-lg px-2 text-[12.5px]"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as UserStatus | '');
                  setCursor(undefined);
                }}
              >
                <option value="">ทุกสถานะ</option>
                <option value="ACTIVE">{userStatusLabel('ACTIVE')}</option>
                <option value="INVITED">{userStatusLabel('INVITED')}</option>
                <option value="SUSPENDED">{userStatusLabel('SUSPENDED')}</option>
                <option value="DISABLED">{userStatusLabel('DISABLED')}</option>
              </select>
            </label>

            <label className="block text-[11.5px] font-semibold text-navy-700">
              บทบาท
              <select
                className="s2-input mt-1 h-9 rounded-lg px-2 text-[12.5px]"
                value={roleCode}
                onChange={(event) => {
                  setRoleCode(event.target.value);
                  setCursor(undefined);
                }}
              >
                <option value="">ทุกบทบาท</option>
                {(roles.data?.data ?? []).map((role) => (
                  <option key={role.id} value={role.code}>{role.code}</option>
                ))}
              </select>
            </label>
          </div>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="รายชื่อผู้ใช้งาน"
          description={page ? `พบ ${page.total} บัญชี` : 'ผู้ใช้ทั้งหมดที่เข้าถึง S2 NAS ได้'}
        />
        <PanelBody className="p-0">
          {users.isPending ? (
            <div className="p-4"><ListSkeleton rows={5} /></div>
          ) : users.isError ? (
            <ErrorState title="โหลดรายชื่อผู้ใช้ไม่สำเร็จ" onRetry={() => void users.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<Users className="h-6 w-6" aria-hidden />}
              title="ไม่พบผู้ใช้ตามเงื่อนไขนี้"
              description="ลองล้างตัวกรองสถานะหรือบทบาท หรือใช้คำค้นที่สั้นลง"
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-left text-[12.5px]">
                  <thead className="border-b border-line text-[11px] text-navy-400">
                    <tr>
                      <th scope="col" className="px-4 py-2.5 font-medium">ผู้ใช้งาน</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">สถานะ</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">บทบาท</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">เข้าใช้ล่าสุด</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">สร้างเมื่อ</th>
                      <th scope="col" className="px-4 py-2.5 text-right font-medium">การจัดการ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const isSelf = row.id === currentUser?.id;
                      return (
                        <tr key={row.id} className="border-b border-line last:border-b-0">
                          <td className="px-4 py-3">
                            <OwnerIdentity owner={row} caption={row.email} size="md" />
                            {row.mustChangePassword && row.status === 'ACTIVE' ? (
                              <span className="mt-1 inline-block rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
                                ต้องเปลี่ยนรหัสผ่านเมื่อเข้าใช้ครั้งแรก
                              </span>
                            ) : null}
                          </td>

                          <td className="px-4 py-3">
                            <span
                              title={userStatusHint(row.status)}
                              className={`inline-block rounded-md border px-1.5 py-0.5 text-[10.5px] ${
                                STATUS_CLASS[userStatusTone(row.status)]
                              }`}
                            >
                              {userStatusLabel(row.status)}
                            </span>
                          </td>

                          <td className="px-4 py-3">
                            <span className="flex flex-wrap gap-1">
                              {row.roles.map((link) => (
                                <span
                                  key={link.role.id}
                                  className="rounded-md border border-line bg-[var(--s2-surface-soft)] px-1.5 py-0.5 text-[10.5px] text-navy-500"
                                >
                                  {link.role.code}
                                </span>
                              ))}
                            </span>
                          </td>

                          <td className="px-4 py-3 text-navy-500">
                            {row.lastLoginAt ? (
                              <span title={formatDateTime(row.lastLoginAt)}>{formatRelativeTime(row.lastLoginAt)}</span>
                            ) : (
                              <span className="text-navy-300">ยังไม่เคยเข้าใช้</span>
                            )}
                          </td>

                          <td className="px-4 py-3 text-navy-500" title={formatDateTime(row.createdAt)}>
                            {formatRelativeTime(row.createdAt)}
                          </td>

                          <td className="px-4 py-3">
                            <span className="flex flex-wrap justify-end gap-1.5">
                              {canActivate(row.status) ? (
                                <RowAction
                                  icon={<UserCheck className="h-3.5 w-3.5" />}
                                  label="เปิดใช้งาน"
                                  onClick={() => setDialog({ mode: 'activate', user: row })}
                                />
                              ) : null}
                              {row.status === 'ACTIVE' ? (
                                <RowAction
                                  icon={<KeyRound className="h-3.5 w-3.5" />}
                                  label="รีเซ็ตรหัสผ่าน"
                                  onClick={() => setDialog({ mode: 'reset-password', user: row })}
                                />
                              ) : null}
                              <RowAction
                                icon={<ShieldCheck className="h-3.5 w-3.5" />}
                                label="บทบาท"
                                onClick={() => setDialog({ mode: 'roles', user: row })}
                              />
                              <Link
                                to="/admin/ownership"
                                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-[11.5px] text-navy-500 hover:bg-navy-50 hover:text-navy-800"
                              >
                                <UserRoundCog className="h-3.5 w-3.5" aria-hidden />
                                การส่งมอบความรับผิดชอบ
                              </Link>
                              {canDisable(row.status, isSelf) ? (
                                <RowAction
                                  icon={<UserX className="h-3.5 w-3.5" />}
                                  label="ปิดใช้งาน"
                                  danger
                                  onClick={() => setDialog({ mode: 'disable', user: row })}
                                />
                              ) : null}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {page?.nextCursor ? (
                <div className="border-t border-line p-3">
                  <button
                    type="button"
                    className="s2-btn s2-btn-outline w-full"
                    onClick={() => setCursor(page.nextCursor ?? undefined)}
                  >
                    ดูหน้าถัดไป
                  </button>
                </div>
              ) : null}
            </>
          )}
        </PanelBody>
      </Panel>

      {dialog ? (
        <UserActionDialog mode={dialog.mode} user={dialog.user} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

function RowAction({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px] transition-colors ${
        danger
          ? 'border-red-200 text-red-600 hover:bg-red-50'
          : 'border-line text-navy-500 hover:bg-navy-50 hover:text-navy-800'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
