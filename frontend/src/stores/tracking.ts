import { create } from "zustand";
import type { Category } from "../types/proximity";

/** Selected-satellite palette: cyan / green / blue family (selected objects), each one distinct. */
export const TRACK_COLORS = ["#36D6E8", "#35D39A", "#4DA3FF", "#A3E635", "#7DD3FC", "#2DD4BF", "#93C5FD", "#86EFAC", "#22D3EE", "#60A5FA", "#5EEAD4", "#BEF264"];
export const NEAR_COLOR = "#FF9F43"; // nearby objects (proximity, not risk)
export const HIGH_COLOR = "#FF647C"; // HIGH-priority screened conjunction
export const MAX_TRACKED = 25;

export interface Tracked {
  id: number;
  name: string | null;
  color: string;
  visible: boolean;
}

export type CameraCmd = { kind: "focus" | "orbit" | "all" | "reset"; id?: number; nonce: number } | null;

interface TrackingState {
  tracked: Tracked[];
  isolated: number | null;
  add: (items: { id: number; name: string | null }[]) => void;
  remove: (id: number) => void;
  clear: () => void;
  toggleVisible: (id: number) => void;
  isolate: (id: number | null) => void;

  // proximity
  proximityOn: boolean;
  radiusKm: number;
  categories: Category[];
  mode: "current" | "future";
  horizonH: number;
  set: (p: Partial<Pick<TrackingState, "proximityOn" | "radiusKm" | "categories" | "mode" | "horizonH">>) => void;

  // visualisation layers
  layers: { labels: boolean; orbits: boolean; debris: boolean; otherNearby: boolean; boundary: boolean; nearbyPaths: boolean };
  toggleLayer: (k: keyof TrackingState["layers"]) => void;

  /** nearby id -> highlight kind, written by the proximity panel, read by the globe */
  nearby: Map<number, { kind: "near" | "high"; category: Category; of: number }>;
  setNearby: (m: TrackingState["nearby"]) => void;
  /** trajectories of nearby objects the user asked to see */
  nearbyPaths: Set<number>;
  toggleNearbyPath: (id: number) => void;

  camera: CameraCmd;
  command: (kind: NonNullable<CameraCmd>["kind"], id?: number) => void;
}

export const ALL_CATEGORIES: Category[] = ["debris", "rocket_body", "active_satellite", "inactive_satellite", "satellite_unknown_status", "unknown"];

export const useTracking = create<TrackingState>((set, get) => ({
  tracked: [],
  isolated: null,
  add: (items) => {
    const cur = get().tracked;
    const used = new Set(cur.map((t) => t.color));
    const next = [...cur];
    for (const it of items) {
      if (next.length >= MAX_TRACKED || next.some((t) => t.id === it.id)) continue;
      const color = TRACK_COLORS.find((c) => !used.has(c)) ?? TRACK_COLORS[next.length % TRACK_COLORS.length]!;
      used.add(color);
      next.push({ id: it.id, name: it.name, color, visible: true });
    }
    set({ tracked: next });
  },
  remove: (id) => set((s) => ({ tracked: s.tracked.filter((t) => t.id !== id), isolated: s.isolated === id ? null : s.isolated })),
  clear: () => set({ tracked: [], isolated: null, nearby: new Map(), nearbyPaths: new Set() }),
  toggleVisible: (id) => set((s) => ({ tracked: s.tracked.map((t) => (t.id === id ? { ...t, visible: !t.visible } : t)) })),
  isolate: (id) => set({ isolated: id }),

  proximityOn: true,
  radiusKm: 25,
  categories: [...ALL_CATEGORIES],
  mode: "current",
  horizonH: 6,
  set: (p) => set(p),

  layers: { labels: true, orbits: true, debris: true, otherNearby: true, boundary: true, nearbyPaths: true },
  toggleLayer: (k) => set((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),

  nearby: new Map(),
  setNearby: (m) => set({ nearby: m }),
  nearbyPaths: new Set(),
  toggleNearbyPath: (id) =>
    set((s) => {
      const n = new Set(s.nearbyPaths);
      n.has(id) ? n.delete(id) : n.add(id);
      return { nearbyPaths: n };
    }),

  camera: null,
  command: (kind, id) => set({ camera: { kind, id, nonce: Date.now() + Math.random() } }),
}));

/** Satellites currently drawn: all visible ones, or only the isolated one. */
export function shownTracked(s: Pick<TrackingState, "tracked" | "isolated">) {
  return s.tracked.filter((t) => (s.isolated !== null ? t.id === s.isolated : t.visible));
}
