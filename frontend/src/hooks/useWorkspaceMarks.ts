import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, workspaceApi } from '@/lib/api';
import { useToast } from './useToast';

/**
 * รายการโปรดและการปักหมุดของผู้ใช้คนปัจจุบัน
 *
 * ทั้งสองอย่างเป็นข้อมูลรายบุคคล ไม่ได้อยู่ใน DTO ของทรัพยากร จึงโหลดเป็นชุดเดียว
 * แล้วนำ id ไปประกบกับรายการที่แสดงอยู่ วิธีนี้ทำให้เปิดโฟลเดอร์ไหนก็ไม่ต้องถามซ้ำ
 * และดาวกับหมุดบนการ์ดตรงกันทุกหน้าโดยอัตโนมัติ
 */
export function useWorkspaceMarks() {
  const queryClient = useQueryClient();
  const { notify } = useToast();

  const favorites = useQuery({ queryKey: ['favorites'], queryFn: workspaceApi.favorites });
  const pins = useQuery({ queryKey: ['pins'], queryFn: workspaceApi.pins });

  const favoriteIds = useMemo(
    () => new Set((favorites.data?.data ?? []).map((item) => item.id)),
    [favorites.data],
  );
  const pinnedIds = useMemo(() => new Set((pins.data?.data ?? []).map((item) => item.id)), [pins.data]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['favorites'] });
    void queryClient.invalidateQueries({ queryKey: ['pins'] });
    void queryClient.invalidateQueries({ queryKey: ['drive'] });
  }, [queryClient]);

  const fail = useCallback(
    (error: unknown, fallback: string) => {
      notify({ tone: 'error', title: error instanceof ApiError ? error.message : fallback });
    },
    [notify],
  );

  const favoriteMutation = useMutation({
    mutationFn: async ({ id, next }: { id: string; next: boolean }): Promise<void> => {
      if (next) await workspaceApi.addFavorite(id);
      else await workspaceApi.removeFavorite(id);
    },
    onSuccess: (_data, variables) => {
      refresh();
      notify({ tone: 'success', title: variables.next ? 'เพิ่มในรายการโปรดแล้ว' : 'นำออกจากรายการโปรดแล้ว' });
    },
    onError: (error) => fail(error, 'ปรับรายการโปรดไม่สำเร็จ'),
  });

  const pinMutation = useMutation({
    mutationFn: async ({ id, next }: { id: string; next: boolean }): Promise<void> => {
      if (next) await workspaceApi.pin(id);
      else await workspaceApi.unpin(id);
    },
    onSuccess: (_data, variables) => {
      refresh();
      notify({ tone: 'success', title: variables.next ? 'ปักหมุดแล้ว' : 'ยกเลิกปักหมุดแล้ว' });
    },
    onError: (error) => fail(error, 'ปรับการปักหมุดไม่สำเร็จ'),
  });

  return {
    favoriteIds,
    pinnedIds,
    pinnedResources: pins.data?.data ?? [],
    favoriteResources: favorites.data?.data ?? [],
    isLoading: favorites.isPending || pins.isPending,
    toggleFavorite: (id: string, next: boolean) => favoriteMutation.mutate({ id, next }),
    togglePin: (id: string, next: boolean) => pinMutation.mutate({ id, next }),
    isMutating: favoriteMutation.isPending || pinMutation.isPending,
  };
}
