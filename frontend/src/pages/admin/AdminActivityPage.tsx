import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { EmptyState, ErrorState, TextSkeleton } from '@/components/ui/States';
import { PageTitle } from '@/components/ui/PageTitle';
import { usersApi, workspaceApi } from '@/lib/api';
import { activityDetail, activityLabel } from '@/lib/activity-text';
import { formatDateTime, formatRelativeTime } from '@/lib/utils';

/**
 * บันทึกกิจกรรมทั้งระบบ
 *
 * หน้านี้เปิดเฉพาะผู้ดูแล จึงแสดง IP และ user agent ได้ ซึ่งต่างจากไทม์ไลน์
 * ในแผงรายละเอียดที่ผู้ใช้ทั่วไปเห็น และตั้งใจไม่เปิดเผยสองฟิลด์นั้น
 */
export default function AdminActivityPage() {
  const [userId, setUserId] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const users = useQuery({ queryKey: ['users'], queryFn: () => usersApi.list({ limit: 100 }) });
  const actions = useQuery({ queryKey: ['activity-actions'], queryFn: workspaceApi.activityActions });

  const logs = useInfiniteQuery({
    queryKey: ['admin-activity', userId, action, from, to],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (userId) params.set('userId', userId);
      if (action) params.set('action', action);
      if (from) params.set('from', new Date(from).toISOString());
      // ครอบคลุมทั้งวันที่เลือก ไม่ใช่แค่เที่ยงคืนของวันนั้น
      if (to) params.set('to', new Date(`${to}T23:59:59.999`).toISOString());
      if (pageParam) params.set('cursor', pageParam);
      return workspaceApi.activity(params);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.data.nextCursor ?? undefined,
  });

  const entries = logs.data?.pages.flatMap((page) => page.data.items) ?? [];

  return (
    <div className="space-y-4">
      <PageTitle title="Activity Log" description="บันทึกการใช้งานทั้งหมดในระบบ" />

      <Panel>
        <PanelHeader title="ตัวกรอง" description="เลือกช่วงเวลา ผู้ใช้ และประเภทเหตุการณ์" />
        <PanelBody>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block text-[11.5px] font-semibold text-navy-700">
              ผู้ใช้
              <select className="s2-input mt-1 h-9 rounded-lg px-2 text-[12.5px]" value={userId} onChange={(event) => setUserId(event.target.value)}>
                <option value="">ทุกคน</option>
                {(users.data?.data.items ?? []).map((user) => (
                  <option key={user.id} value={user.id}>{user.displayName}</option>
                ))}
              </select>
            </label>

            <label className="block text-[11.5px] font-semibold text-navy-700">
              เหตุการณ์
              <select className="s2-input mt-1 h-9 rounded-lg px-2 text-[12.5px]" value={action} onChange={(event) => setAction(event.target.value)}>
                <option value="">ทั้งหมด</option>
                {(actions.data?.data ?? []).map((row) => (
                  <option key={row.action} value={row.action}>
                    {activityLabel(row.action)} ({row.count})
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-[11.5px] font-semibold text-navy-700">
              ตั้งแต่วันที่
              <input type="date" className="s2-input mt-1 h-9 rounded-lg px-2 text-[12.5px]" value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>

            <label className="block text-[11.5px] font-semibold text-navy-700">
              ถึงวันที่
              <input type="date" className="s2-input mt-1 h-9 rounded-lg px-2 text-[12.5px]" value={to} onChange={(event) => setTo(event.target.value)} />
            </label>
          </div>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="บันทึกกิจกรรม" description="เรียงจากเหตุการณ์ล่าสุด" />
        <PanelBody className="p-0">
          {logs.isPending ? (
            <div className="p-4"><TextSkeleton lines={6} /></div>
          ) : logs.isError ? (
            <ErrorState title="โหลดบันทึกกิจกรรมไม่สำเร็จ" onRetry={() => void logs.refetch()} />
          ) : entries.length === 0 ? (
            <EmptyState
              icon={<ScrollText className="h-6 w-6" aria-hidden />}
              title="ไม่พบบันทึกตามเงื่อนไขนี้"
              description="ลองขยายช่วงเวลา หรือล้างตัวกรองผู้ใช้และประเภทเหตุการณ์"
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-[12.5px]">
                  <thead className="border-b border-line text-[11px] text-navy-400">
                    <tr>
                      <th scope="col" className="px-4 py-2.5 font-medium">เหตุการณ์</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">ผู้ใช้</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">เวลา</th>
                      <th scope="col" className="px-4 py-2.5 font-medium">ที่มา</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => {
                      const detail = activityDetail(entry.action, entry.metadata);
                      return (
                        <tr key={entry.id} className="border-b border-line last:border-b-0">
                          <td className="px-4 py-2.5">
                            <span className="font-medium text-navy-800">{activityLabel(entry.action)}</span>
                            {detail ? <span className="block text-[11px] text-navy-400">{detail}</span> : null}
                          </td>
                          <td className="px-4 py-2.5 text-navy-600">{entry.actor?.displayName ?? 'ระบบ'}</td>
                          <td className="px-4 py-2.5 text-navy-500" title={formatDateTime(entry.createdAt)}>
                            {formatRelativeTime(entry.createdAt)}
                          </td>
                          <td className="px-4 py-2.5 text-navy-400">{entry.ipAddress ?? '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {logs.hasNextPage ? (
                <div className="border-t border-line p-3">
                  <button
                    type="button"
                    className="s2-btn s2-btn-outline w-full"
                    disabled={logs.isFetchingNextPage}
                    onClick={() => void logs.fetchNextPage()}
                  >
                    {logs.isFetchingNextPage ? 'กำลังโหลด…' : 'โหลดเพิ่ม'}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}
