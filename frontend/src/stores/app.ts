import { create } from "zustand";

/**
 * Simulation clock. Simulated time advances at `speed` x real time while
 * playing. Every position request uses `simTime()`, so the globe always
 * shows propagated positions for the displayed timestamp.
 */
interface ClockState {
  anchorReal: number; // ms, performance-independent wall clock
  anchorSim: number; // ms since epoch (UTC)
  speed: number;
  playing: boolean;
}

interface AppState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  mobileNav: boolean;
  setMobileNav: (open: boolean) => void;
  selectedId: number | null;
  select: (id: number | null) => void;
  clock: ClockState;
  setSpeed: (s: number) => void;
  setPlaying: (p: boolean) => void;
  setSimTime: (ms: number) => void;
  resetToNow: () => void;
  dataVersion: number; // bumped after ingestion so views refetch
  bumpData: () => void;
}

const now = () => Date.now();

export function simTimeOf(c: ClockState, wall = now()): number {
  return c.playing ? c.anchorSim + (wall - c.anchorReal) * c.speed : c.anchorSim;
}

export const useApp = create<AppState>((set, get) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  mobileNav: false,
  setMobileNav: (open) => set({ mobileNav: open }),
  selectedId: null,
  select: (id) => set({ selectedId: id }),
  clock: { anchorReal: now(), anchorSim: now(), speed: 1, playing: true },
  setSpeed: (speed) => {
    const c = get().clock;
    set({ clock: { ...c, anchorReal: now(), anchorSim: simTimeOf(c), speed } });
  },
  setPlaying: (playing) => {
    const c = get().clock;
    set({ clock: { ...c, anchorReal: now(), anchorSim: simTimeOf(c), playing } });
  },
  setSimTime: (ms) => {
    const c = get().clock;
    set({ clock: { ...c, anchorReal: now(), anchorSim: ms } });
  },
  resetToNow: () => {
    const c = get().clock;
    set({ clock: { ...c, anchorReal: now(), anchorSim: now(), speed: 1, playing: true } });
  },
  dataVersion: 0,
  bumpData: () => set((s) => ({ dataVersion: s.dataVersion + 1 })),
}));

export const simTimeISO = () => new Date(simTimeOf(useApp.getState().clock)).toISOString();
