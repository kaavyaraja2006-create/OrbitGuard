import { useEffect, useRef } from "react";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { TYPE_COLOR } from "../ui";
import type { ObjectType } from "../../types";
import { createGlobe, km, OrbitTrajectory, prefersReducedMotion, SatelliteMarker } from "./cesiumKit";

export interface GlobeTrack {
  name: string | null;
  /** flattened Earth-fixed positions over one period, km */
  ecef_km: number[];
  period_min: number;
  color?: string;
}

/**
 * Cinematic, lightweight globe for the landing page and overview: a slowly turning camera,
 * a sample of real SGP4 positions (points) and a few real orbit tracks whose satellites are
 * replayed along their computed path at `timelapse`× real time, in front of a faint star field.
 * Rendering pauses off-screen.
 */
export function OrbitalGlobe({
  points,
  types,
  tracks = [],
  time,
  rotate = 0.035,
  timelapse = 60,
  interactive = false,
  range = 21_000_000,
  centerLon = 70,
  background = "#05080F",
  className = "",
}: {
  points?: number[];
  types?: string[];
  tracks?: GlobeTrack[];
  time?: string;
  /** camera angular speed, rad/s */
  rotate?: number;
  timelapse?: number;
  interactive?: boolean;
  range?: number;
  centerLon?: number;
  background?: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const widget = useRef<Cesium.CesiumWidget | null>(null);
  const pts = useRef<Cesium.PointPrimitiveCollection | null>(null);
  const lines = useRef<Cesium.PolylineCollection | null>(null);
  const bbs = useRef<Cesium.BillboardCollection | null>(null);
  const movers = useRef<{ bb: Cesium.Billboard; path: Cesium.Cartesian3[]; periodS: number }[]>([]);

  useEffect(() => {
    if (!host.current) return;
    const w = createGlobe(host.current, { background, stars: 900 });
    const ctl = w.scene.screenSpaceCameraController;
    if (!interactive) {
      ctl.enableInputs = false;
    } else {
      ctl.enableZoom = false;
      ctl.enableTilt = false;
    }
    w.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(centerLon, 12, range) });
    pts.current = w.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    lines.current = w.scene.primitives.add(new Cesium.PolylineCollection());
    bbs.current = w.scene.primitives.add(new Cesium.BillboardCollection());
    widget.current = w;

    const reduce = prefersReducedMotion();
    let visible = true;
    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
      w.useDefaultRenderLoop = visible;
    });
    io.observe(host.current);
    let last = performance.now();
    let simT = 0;
    const onTick = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!visible || reduce) return;
      if (rotate) w.camera.rotate(Cesium.Cartesian3.UNIT_Z, -rotate * dt);
      simT += dt * timelapse;
      for (const m of movers.current) {
        const n = m.path.length;
        const x = ((simT % m.periodS) / m.periodS) * (n - 1);
        const i = Math.floor(x);
        const f = x - i;
        m.bb.position = Cesium.Cartesian3.lerp(m.path[i]!, m.path[Math.min(n - 1, i + 1)]!, f, new Cesium.Cartesian3());
      }
    };
    w.scene.preRender.addEventListener(onTick);
    return () => {
      io.disconnect();
      w.scene.preRender.removeEventListener(onTick);
      w.destroy();
      widget.current = null;
    };
  }, [interactive, rotate, timelapse, range, centerLon, background]);

  useEffect(() => {
    const w = widget.current;
    if (w && time) w.clock.currentTime = Cesium.JulianDate.fromIso8601(time);
  }, [time]);

  useEffect(() => {
    const pc = pts.current;
    if (!pc) return;
    pc.removeAll();
    if (!points || !types) return;
    for (let k = 0; k < types.length; k++) {
      const t = types[k] as ObjectType;
      pc.add({
        position: km(points, 3 * k),
        pixelSize: t === "PAYLOAD" ? 3.2 : 2.4,
        color: Cesium.Color.fromCssColorString(TYPE_COLOR[t] ?? "#64748B").withAlpha(t === "DEBRIS" ? 0.75 : 0.95),
      });
    }
  }, [points, types]);

  useEffect(() => {
    const lc = lines.current, bc = bbs.current;
    if (!lc || !bc) return;
    lc.removeAll();
    bc.removeAll();
    movers.current = [];
    tracks.forEach((tr, i) => {
      const path: Cesium.Cartesian3[] = [];
      for (let k = 0; k + 2 < tr.ecef_km.length; k += 3) path.push(km(tr.ecef_km, k));
      if (path.length < 2) return;
      const color = tr.color ?? ["#36D6E8", "#4DA3FF", "#A78BFA", "#35D39A"][i % 4]!;
      lc.add({ positions: path, width: 2.2, material: OrbitTrajectory(color, { glow: true, alpha: 0.75 }) });
      const bb = bc.add(SatelliteMarker(path[0]!, color, { scale: 0.75 }));
      movers.current.push({ bb, path, periodS: tr.period_min * 60 });
    });
  }, [tracks]);

  return <div ref={host} className={`absolute inset-0 ${className}`} />;
}
