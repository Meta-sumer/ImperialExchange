import { create } from 'zustand';

/**
 * UI state the chrome shares across screens.
 *
 * native-stack draws a header per screen, so anything that must exist once
 * — the profile menu, the measured header height — cannot live inside a
 * header instance.
 */
interface ChromeState {
  profileOpen: boolean;
  /** Measured height of the app header (safe area + bar + rail). */
  headerHeight: number;
  openProfile: () => void;
  closeProfile: () => void;
  setHeaderHeight: (h: number) => void;
}

export const useChrome = create<ChromeState>()((set, get) => ({
  profileOpen: false,
  headerHeight: 0,
  openProfile: () => set({ profileOpen: true }),
  closeProfile: () => set({ profileOpen: false }),
  setHeaderHeight: (h) => { if (Math.abs(get().headerHeight - h) >= 1) set({ headerHeight: h }); },
}));
