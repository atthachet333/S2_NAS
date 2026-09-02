import { useCallback, useEffect, useState } from 'react';

export type ViewMode = 'grid' | 'list';

const STORAGE_KEY = 's2-nas-view';

function read(): ViewMode {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

/** จำมุมมองที่ผู้ใช้เลือกไว้ข้ามการใช้งานแต่ละครั้ง */
export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(read);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* โหมดส่วนตัวของเบราว์เซอร์อาจเขียนไม่ได้ */
    }
  }, [mode]);

  const update = useCallback((next: ViewMode) => setMode(next), []);
  return [mode, update];
}
