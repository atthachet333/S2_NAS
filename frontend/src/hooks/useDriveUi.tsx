import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useViewMode, type ViewMode } from './useViewMode';
import type { DriveEntry } from '@/lib/drive';

interface DriveUiValue {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  detailsOpen: boolean;
  openDetails: () => void;
  closeDetails: () => void;
  toggleDetails: () => void;
  selected: DriveEntry | null;
  select: (entry: DriveEntry | null) => void;
  query: string;
  setQuery: (value: string) => void;
}

const DriveUiContext = createContext<DriveUiValue | null>(null);

/** สถานะร่วมของ workspace: มุมมอง, รายการที่เลือก และแผงรายละเอียด */
export function DriveUiProvider({ children }: { children: ReactNode }) {
  const [viewMode, setViewMode] = useViewMode();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selected, setSelected] = useState<DriveEntry | null>(null);
  const [query, setQuery] = useState('');

  const openDetails = useCallback(() => setDetailsOpen(true), []);
  const closeDetails = useCallback(() => setDetailsOpen(false), []);
  const toggleDetails = useCallback(() => setDetailsOpen((v) => !v), []);
  const select = useCallback((entry: DriveEntry | null) => setSelected(entry), []);

  const value = useMemo(
    () => ({
      viewMode,
      setViewMode,
      detailsOpen,
      openDetails,
      closeDetails,
      toggleDetails,
      selected,
      select,
      query,
      setQuery,
    }),
    [viewMode, setViewMode, detailsOpen, openDetails, closeDetails, toggleDetails, selected, select, query],
  );

  return <DriveUiContext.Provider value={value}>{children}</DriveUiContext.Provider>;
}

export function useDriveUi(): DriveUiValue {
  const context = useContext(DriveUiContext);
  if (!context) throw new Error('useDriveUi ต้องอยู่ภายใน DriveUiProvider');
  return context;
}
