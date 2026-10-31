/**
 * Shared 3D scene for replaying a simulation (Simulation Lab and Scenario Visualizer).
 *
 * Everything drawn comes from the stored simulation: Earth-fixed positions and velocities at
 * 30 s steps (interpolated with cubic Hermite between samples), the maneuver point and Δv
 * direction, and the closest-approach times. Styling only: blue original, green modified,
 * amber alternative, orange threats, red closest approaches, purple maneuver, cyan for your
 * satellite before the burn.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import type { SimTrajectory, Simulation } from "../../types/mission";
import { createGlobe, labelStyle, OrbitTrajectory, satelliteIcon } from "../fx/cesiumKit";

export const SIM_COLORS = {
  original: "#4DA3FF",
  modified: "#35D39A",
  alternative: "#F5B942",
  threat: "#FF9F43",
  tca: "#FF647C",
  burn: "#A78BFA",
  selected: "#36D6E8",
} as const;

export interface SimLayers {
  original: boolean;
  modified: boolean;
  alternative: boolean;
  threats: boolean;
  vector: boolean;
  tca: boolean;
  labels: boolean;
  distance: boolean;
}
export const DEFAULT_LAYERS: SimLayers = { original: true, modified: true, alternative: true, threats: true, vector: true, tca: true, labels: true, distance: true };

export type Vec = [number, number, number];

/** Cubic Hermite interpolation of an Earth-fixed track using its velocities (km, km/s). */
export function stateAt(tr: SimTrajectory, t: number): Vec | null {
  const n = tr.ecef_km.length;
  const x = t / tr.step_s;
  const i = Math.floor(x);
  if (i < 0 || i >= n - 1) return i === n - 1 ? (tr.ecef_km[n - 1] as Vec) : null;
  const s = x - i;
  const h = tr.step_s;
  const p0 = tr.ecef_km[i]!, p1 = tr.ecef_km[i + 1]!, v0 = tr.vel_kms[i]!, v1 = tr.vel_kms[i + 1]!;
  if (p0.some((c) => c === null) || p1.some((c) => c === null)) return null;
  const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
  return [0, 1, 2].map((k) => h00 * p0[k]! + h10 * h * v0[k]! + h01 * p1[k]! + h11 * h * v1[k]!) as Vec;
}
export const cart = (p: ArrayLike<number>) => new Cesium.Cartesian3(p[0]! * 1000, p[1]! * 1000, p[2]! * 1000);
export const dist = (a: ArrayLike<number> | null, b: ArrayLike<number> | null) => (a && b ? Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) : null);
export const fmtKm = (d: number | null) => (d === null ? "—" : d < 1 ? `${(d * 1000).toFixed(0)} m` : d < 100 ? `${d.toFixed(2)} km` : `${d.toFixed(0)} km`);

export interface SimModel {
  start: number; // ms
  horizon: number; // s
  period: number; // s
  orig: SimTrajectory;
  mod?: SimTrajectory;
  alt?: SimTrajectory;
  threats: SimTrajectory[];
  man: null | { t_s: number; time: string; ecef_km: number[]; dv_ecef_unit: number[]; dv_rtn_ms: number[]; dv_ms: number; burn_s: number };
  /** per threat: original closest approach (time, miss) and the closest approach after the burn */
  tcas: { threat: string; tca: string; miss_km: number; t: number; before_km: number | null; after_km: number | null; refined: boolean }[];
}

/** Derived, render-ready view of a simulation. */
export function useSimModel(sim: Simulation): SimModel {
  return useMemo(() => {
    const cfg = sim.config;
    const start = new Date(cfg.start).getTime();
    const orig = sim.trajectories.find((x) => x.kind === "original")!;
    const mod = sim.trajectories.find((x) => x.kind === "modified");
    const alt = sim.trajectories.find((x) => x.kind === "alternative");
    const threats = sim.trajectories.filter((x) => x.kind === "threat");
    const p = orig.ecef_km[0]!;
    const r = Math.hypot(p[0]!, p[1]!, p[2]!);
    const period = 2 * Math.PI * Math.sqrt(r ** 3 / 398600.4418);
    // Encounters: the closest approach WITHOUT the burn (the danger), and the closest approach WITH it.
    // Newer simulations store the plan's refined values; older ones fall back to the 30 s samples.
    const series = (cfg.separations?.series ?? []) as { threat: string; before_km: number[]; after_km: number[] | null }[];
    const ts = (cfg.separations?.t_s ?? []) as number[];
    const enc = cfg.encounters as
      | { threat: string; tca_before: string; miss_before_km: number; tca_after: string | null; miss_after_km: number | null }[]
      | undefined;
    const tcas = series.map((ser, k) => {
      const e = enc?.find((x) => x.threat === ser.threat) ?? enc?.[k];
      if (e) {
        const t = (new Date(e.tca_before).getTime() - start) / 1000;
        return { threat: ser.threat, tca: e.tca_before, miss_km: e.miss_before_km, t, before_km: e.miss_before_km, after_km: e.miss_after_km, refined: true };
      }
      let i0 = 0;
      ser.before_km.forEach((d, i) => { if (d < ser.before_km[i0]!) i0 = i; });
      const after = ser.after_km ? Math.min(...ser.after_km) : null;
      const t = ts[i0] ?? 0;
      return { threat: ser.threat, tca: new Date(start + t * 1000).toISOString(), miss_km: ser.before_km[i0]!, t, before_km: ser.before_km[i0]!, after_km: after, refined: false };
    });
    return { start, horizon: cfg.horizon_s, period, orig, mod, alt, threats, man: cfg.maneuver ?? null, tcas };
  }, [sim]);
}

interface Dyn {
  bb: Cesium.Billboard;
  lb: Cesium.Label;
  tr: SimTrajectory;
  role: "original" | "modified" | "alternative" | "threat";
  fresh?: boolean;
}

/**
 * Creates the Cesium widget and layers for a simulation. The caller drives time by calling
 * `apply(t)` from its own animation loop; the returned helpers move the camera.
 */
export function useSimScene(host: RefObject<HTMLDivElement | null>, m: SimModel, layers: SimLayers) {
  const widget = useRef<Cesium.CesiumWidget | null>(null);
  const lines = useRef<Cesium.PolylineCollection | null>(null);
  const links = useRef<Cesium.PolylineCollection | null>(null);
  const bbs = useRef<Cesium.BillboardCollection | null>(null);
  const labels = useRef<Cesium.LabelCollection | null>(null);
  const marks = useRef<Cesium.PointPrimitiveCollection | null>(null);
  const markLabels = useRef<Cesium.LabelCollection | null>(null);
  const dyn = useRef<Dyn[]>([]);
  const tcaLabels = useRef<{ lb: Cesium.Label; t: number }[]>([]);
  const distLinks = useRef<{ line: Cesium.Polyline; lb: Cesium.Label; tr: SimTrajectory }[]>([]);
  const winKey = useRef(-1);
  const phase = useRef<boolean | null>(null);
  const layersRef = useRef(layers);
  if (layersRef.current !== layers) winKey.current = -1;
  layersRef.current = layers;

  // ---- widget
  useEffect(() => {
    if (!host.current) return;
    const w = createGlobe(host.current);
    w.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(78, 15, 26_000_000) });
    lines.current = w.scene.primitives.add(new Cesium.PolylineCollection());
    links.current = w.scene.primitives.add(new Cesium.PolylineCollection());
    marks.current = w.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    markLabels.current = w.scene.primitives.add(new Cesium.LabelCollection());
    bbs.current = w.scene.primitives.add(new Cesium.BillboardCollection());
    labels.current = w.scene.primitives.add(new Cesium.LabelCollection());
    widget.current = w;
    return () => {
      w.destroy();
      widget.current = null;
    };
  }, [host]);

  // ---- moving objects (markers + labels)
  useEffect(() => {
    const bc = bbs.current, lc = labels.current, kc = links.current;
    if (!bc || !lc || !kc) return;
    bc.removeAll();
    lc.removeAll();
    kc.removeAll();
    dyn.current = [];
    distLinks.current = [];
    const add = (tr: SimTrajectory, role: Dyn["role"], color: string, text: string, hollow = false) => {
      const bb = bc.add({ position: Cesium.Cartesian3.ZERO, image: satelliteIcon(color, { hollow }), scale: role === "threat" ? 0.7 : 0.9, disableDepthTestDistance: Number.POSITIVE_INFINITY });
      const lb = lc.add({ position: Cesium.Cartesian3.ZERO, text, ...labelStyle(color), pixelOffset: new Cesium.Cartesian2(16, 0) });
      dyn.current.push({ bb, lb, tr, role, fresh: true });
    };
    if (layers.original) add(m.orig, "original", SIM_COLORS.original, "If no burn", !!m.mod);
    if (m.mod && layers.modified) add(m.mod, "modified", SIM_COLORS.modified, "Maneuvered");
    if (m.alt && layers.alternative) add(m.alt, "alternative", SIM_COLORS.alternative, "Alternative", true);
    if (layers.threats) m.threats.forEach((th) => add(th, "threat", SIM_COLORS.threat, th.label.replace(" (SYNTHETIC)", " · SYNTH")));
    if (layers.distance)
      m.threats.forEach((th) => {
        const line = kc.add({ positions: [Cesium.Cartesian3.ZERO, Cesium.Cartesian3.UNIT_X], width: 1.5, show: false,
          material: Cesium.Material.fromType("PolylineDash", { color: Cesium.Color.fromCssColorString(SIM_COLORS.tca), dashLength: 8 }) });
        const lb = lc.add({ position: Cesium.Cartesian3.ZERO, text: "", ...labelStyle(SIM_COLORS.tca), show: false, font: "600 11px JetBrains Mono Variable, monospace", pixelOffset: new Cesium.Cartesian2(10, 14) });
        distLinks.current.push({ line, lb, tr: th });
      });
  }, [m, layers.original, layers.modified, layers.alternative, layers.threats, layers.distance]);

  // ---- static markers: maneuver point, closest approaches
  useEffect(() => {
    const mc = marks.current, ml = markLabels.current;
    if (!mc || !ml) return;
    mc.removeAll();
    ml.removeAll();
    tcaLabels.current = [];
    if (m.man && layers.vector) {
      mc.add({ position: cart(m.man.ecef_km), pixelSize: 12, color: Cesium.Color.fromCssColorString(SIM_COLORS.burn), outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY });
      ml.add({ position: cart(m.man.ecef_km), text: `BURN · ${(m.man.dv_ms * 1000).toFixed(1)} mm/s`, ...labelStyle(SIM_COLORS.burn), pixelOffset: new Cesium.Cartesian2(14, -16) });
    }
    if (layers.tca)
      m.tcas.forEach((c) => {
        const p = stateAt(m.orig, c.t);
        if (!p) return;
        mc.add({ position: cart(p), pixelSize: 10, color: Cesium.Color.fromCssColorString(SIM_COLORS.tca), outlineColor: Cesium.Color.WHITE, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY });
        const avoided = m.mod && c.after_km !== null;
        const text = avoided ? `${c.threat} · AVOIDED  ${fmtKm(c.before_km)} → ${fmtKm(c.after_km)}` : `${c.threat} · TCA ${fmtKm(c.before_km)}`;
        const lb = ml.add({ position: cart(p), text, ...labelStyle(avoided ? SIM_COLORS.modified : SIM_COLORS.tca), pixelOffset: new Cesium.Cartesian2(14, 18), show: false });
        tcaLabels.current.push({ lb, t: c.t });
      });
  }, [m, layers.vector, layers.tca]);

  /** Draws trajectories around time t (half an orbit back, one ahead) and moves every marker to t. */
  const apply = useCallback((t: number) => {
    const w = widget.current;
    if (!w) return;
    const L = layersRef.current;
    w.clock.currentTime = Cesium.JulianDate.fromDate(new Date(m.start + t * 1000));
    const burnT = m.man?.t_s ?? Infinity;
    const afterBurn = t >= burnT;

    // trajectories, rebuilt every 30 s of sim time
    const key = Math.floor(t / 30) * 1000 + (afterBurn ? 1 : 0);
    if (key !== winKey.current && lines.current) {
      winKey.current = key;
      const lc = lines.current;
      lc.removeAll();
      const seg = (tr: SimTrajectory, a: number, b: number, mat: Cesium.Material, width: number) => {
        const i0 = Math.max(0, Math.floor(a / tr.step_s));
        const i1 = Math.min(tr.ecef_km.length - 1, Math.ceil(b / tr.step_s));
        if (i1 <= i0) return;
        const pts = tr.ecef_km.slice(i0, i1 + 1).filter((p) => p && p[0] !== null).map((p) => cart(p as number[]));
        if (pts.length > 1) lc.add({ positions: pts, width, material: mat });
      };
      const a = t - m.period / 2, b = t + m.period;
      if (L.original) {
        if (m.mod) {
          // shared path before the burn: your satellite (cyan); after it, the danger path the burn avoids (dashed blue)
          seg(m.orig, a, Math.min(b, burnT), OrbitTrajectory(SIM_COLORS.selected, { glow: true, alpha: 0.85 }), 5);
          seg(m.orig, Math.max(a, burnT), b, OrbitTrajectory(SIM_COLORS.original, { dashed: true, alpha: 0.9 }), 2);
        } else seg(m.orig, a, b, OrbitTrajectory(SIM_COLORS.original, { glow: true }), 5);
      }
      if (m.mod && L.modified) seg(m.mod, Math.max(a, burnT), b, OrbitTrajectory(SIM_COLORS.modified, { glow: true, alpha: 0.95 }), 6);
      if (m.alt && L.alternative) seg(m.alt, a, b, OrbitTrajectory(SIM_COLORS.alternative, { dashed: true, alpha: 0.8 }), 1.6);
      if (L.threats) m.threats.forEach((th) => seg(th, a, b, OrbitTrajectory(SIM_COLORS.threat, { alpha: 0.7 }), 1.3));
      if (m.man && L.vector) {
        const p = cart(m.man.ecef_km);
        const d = Cesium.Cartesian3.multiplyByScalar(new Cesium.Cartesian3(...(m.man.dv_ecef_unit as Vec)), 900_000, new Cesium.Cartesian3());
        lc.add({ positions: [p, Cesium.Cartesian3.add(p, d, new Cesium.Cartesian3())], width: 14, material: Cesium.Material.fromType("PolylineArrow", { color: Cesium.Color.fromCssColorString(SIM_COLORS.burn) }) });
      }
    }

    // markers
    const phaseChanged = phase.current !== afterBurn;
    phase.current = afterBurn;
    for (const d of dyn.current) {
      const p = stateAt(d.tr, t);
      let show = !!p;
      // before the burn the original and maneuvered satellites are the same object: show one, cyan
      if (d.role === "modified" && !afterBurn) show = false;
      d.bb.show = show;
      d.lb.show = show && L.labels;
      if (d.role === "original" && m.mod && (phaseChanged || d.fresh)) {
        d.fresh = false;
        if (afterBurn) d.bb.setImage("sat-original-hollow", satelliteIcon(SIM_COLORS.original, { hollow: true }));
        else d.bb.setImage("sat-selected", satelliteIcon(SIM_COLORS.selected));
        d.lb.text = afterBurn ? "If no burn" : "Your satellite";
        d.lb.fillColor = Cesium.Color.fromCssColorString(afterBurn ? SIM_COLORS.original : SIM_COLORS.selected);
        // keep the two labels apart once the paths split
        d.lb.horizontalOrigin = afterBurn ? Cesium.HorizontalOrigin.RIGHT : Cesium.HorizontalOrigin.LEFT;
        d.lb.pixelOffset = afterBurn ? new Cesium.Cartesian2(-16, 0) : new Cesium.Cartesian2(16, 0);
      }
      if (p) {
        const c = cart(p);
        d.bb.position = c;
        d.lb.position = c;
      }
    }

    // closest-approach labels show for 20 minutes around each TCA
    for (const c of tcaLabels.current) c.lb.show = L.labels && Math.abs(t - c.t) < 1200;

    // dynamic distance indicators: active satellite to each threat inside 150 km
    const active = afterBurn && m.mod ? stateAt(m.mod, t) : stateAt(m.orig, t);
    for (const k of distLinks.current) {
      const pt = stateAt(k.tr, t);
      const d = dist(active, pt);
      const on = L.distance && d !== null && d < 150 && !!active && !!pt;
      k.line.show = on;
      k.lb.show = on && L.labels;
      if (on) {
        const a = cart(active!), b = cart(pt!);
        k.line.positions = [a, b];
        k.lb.position = Cesium.Cartesian3.midpoint(a, b, new Cesium.Cartesian3());
        k.lb.text = fmtKm(d);
      }
    }
  }, [m]);

  const activeAt = useCallback((t: number) => ((m.man && t >= m.man.t_s && m.mod) ? stateAt(m.mod, t) : stateAt(m.orig, t)), [m]);

  const camera = useMemo(() => ({
    home: (duration = 1.2) => {
      const w = widget.current;
      if (!w) return;
      w.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      w.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(78, 15, 26_000_000), duration });
    },
    /** fly to a point (km, Earth-fixed) with a heading/pitch/range, then release */
    flyTo: (p: Vec | null, range = 2_500_000, duration = 1.6, heading = 0.3, pitch = -0.55) => {
      const w = widget.current;
      if (!w || !p) return;
      w.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      w.camera.flyToBoundingSphere(new Cesium.BoundingSphere(cart(p), 1), { offset: new Cesium.HeadingPitchRange(heading, pitch, range), duration, easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT });
    },
    /** keep the camera locked on a point (called every frame while following) */
    lock: (p: Vec | null, range = 3_000_000, heading = 0, pitch = -0.6) => {
      const w = widget.current;
      if (!w || !p) return;
      w.camera.lookAt(cart(p), new Cesium.HeadingPitchRange(heading, pitch, range));
    },
    release: () => widget.current?.camera.lookAtTransform(Cesium.Matrix4.IDENTITY),
  }), []);

  return { widget, apply, camera, activeAt };
}
