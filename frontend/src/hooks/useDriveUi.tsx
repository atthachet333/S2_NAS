import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useViewMode, type ViewMode } from './useViewMode';
import type { DriveEntry } from '@/lib/drive';

export type DetailsTab = 'details' | 'versions' | 'access' | 'activity';

interface DriveUiValue {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  detailsOpen: boolean;
  openDetails: (tab?: DetailsTab) => void;
  detailsTab: DetailsTab;
  setDetailsTab: (tab: DetailsTab) => void;
  closeDetails: () => void;
  toggleDetails: () => void;
  selected: DriveEntry | null;
  select: (entry: DriveEntry | null) => void;
}

const DriveUiContext = createContext<DriveUiValue | null>(null);

/** สถานะร่วมของ workspace: มุมมอง, รายการที่เลือก และแผงรายละเอียด */
export function DriveUiProvider({ children }: { children: ReactNode }) {
  const [viewMode, setViewMode] = useViewMode();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsTab, setDetailsTab] = useState<DetailsTab>('details');
  const [selected, setSelected] = useState<DriveEntry | null>(null);

  // เปิดแผงพร้อมเลือกแท็บได้ เพื่อให้เมนู "ประวัติการใช้งาน" พาไปถึงที่หมายในคลิกเดียว
  const openDetails = useCallback((tab?: DetailsTab) => {
    if (tab) setDetailsTab(tab);
    setDetailsOpen(true);
  }, []);
  const closeDetails = useCallback(() => setDetailsOpen(false), []);
  const toggleDetails = useCallback(() => setDetailsOpen((v) => !v), []);
  const select = useCallback((entry: DriveEntry | null) => setSelected(entry), []);

  const value = useMemo(
    () => ({
      viewMode,
      setViewMode,
      detailsOpen,
      openDetails,
      detailsTab,
      setDetailsTab,
      closeDetails,
      toggleDetails,
      selected,
      select,
    }),
    [viewMode, setViewMode, detailsOpen, openDetails, detailsTab, closeDetails, toggleDetails, selected, select],
  );

  return <DriveUiContext.Provider value={value}>{children}</DriveUiContext.Provider>;
}

export function useDriveUi(): DriveUiValue {
  const context = useContext(DriveUiContext);
  if (!context) throw new Error('useDriveUi ต้องอยู่ภายใน DriveUiProvider');
  return context;
}
