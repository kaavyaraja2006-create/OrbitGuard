import { useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { Crosshair, Eye, EyeOff, Home } from "lucide-react";
import { api } from "../services/api";
import { simTimeISO, useApp } from "../stores/app";
import type { ObjectType } from "../types";
import { TYPE_COLOR } from "./ui";
import { HIGH_COLOR, NEAR_COLOR, shownTracked, useTracking } from "../stores/tracking";
import { useTrackingOverlay } from "./useTrackingOverlay";
import { fmtInt } from "../lib/format";

const TYPES: ObjectType[] = ["PAYLOAD", "ROCKET BODY", "DEBRIS", "UNKNOWN"];
const SELECT_COLOR = Cesium.Color.fromCssColorString("#36D6E8");

interface Props {
  className?: string;
  showLegend?: boolean;
  refreshMs?: number;
  /** Multi-satellite tracking + proximity overlay (Space Environment page). */
  tracking?: boolean;
}

/**
 * 3D globe. Every point is an SGP4-propagated position at the simulation
 * clock time, in the Earth-fixed frame returned by /api/v1/positions.
 * Nothing is drawn that the backend did not compute.
 */
export function GlobeViewer({ className = "", showLegend = true, refreshMs = 1000, tracking = false }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const widget = useRef<Cesium.CesiumWidget | null>(null);
  const points = useRef<Cesium.PointPrimitiveCollection | null>(null);
  const lines = useRef<Cesium.PolylineCollection | null>(null);
  const labels = useRef<Cesium.LabelCollection | null>(null);
  const index = useRef(new Map<number, Cesium.PointPrimitive>());
  const typeOf = useRef(new Map<number, ObjectType>());

  const selectedId = useApp((s) => s.selectedId);
  const select = useApp((s) => s.select);
  const dataVersion = useApp((s) => s.dataVersion);
  const [visible, setVisible] = useState<Record<ObjectType, boolean>>({ PAYLOAD: true, "ROCKET BODY": true, DEBRIS: true, UNKNOWN: true });
  const [showPath, setShowPath] = useState(true);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [meta, setMeta] = useState<{ time: string; failed: number; error?: string } | null>(null);
  const tracked = useTracking((s) => s.tracked);
  const isolated = useTracking((s) => s.isolated);
  const nearby = useTracking((s) => s.nearby);
  const tLayers = useTracking((s) => s.layers);
  const proximityOn = useTracking((s) => s.proximityOn);
  const [ready, setReady] = useState(false);

  // ---- create the Cesium widget once
  useEffect(() => {
    if (!host.current) return;
    const w = new Cesium.CesiumWidget(host.current, {
      baseLayer: Cesium.ImageryLayer.fromProviderAsync(
        Cesium.TileMapServiceImageryProvider.fromUrl(Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII")),
      ),
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      skyBox: false,
      shouldAnimate: false,
      requestRenderMode: false,
    });
    w.scene.backgroundColor = Cesium.Color.fromCssColorString("#070B14");
    w.scene.globe.enableLighting = true; // day/night from the simulation clock
    w.scene.globe.baseColor = Cesium.Color.fromCssColorString("#0B1A2E");
    if (w.scene.skyAtmosphere) w.scene.skyAtmosphere.show = true;
    w.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(78, 15, 24_000_000) });

    points.current = w.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    lines.current = w.scene.primitives.add(new Cesium.PolylineCollection());
    labels.current = w.scene.primitives.add(new Cesium.LabelCollection());

    const handler = new Cesium.ScreenSpaceEventHandler(w.scene.canvas);
    handler.setInputAction((e: { position: Cesium.Cartesian2 }) => {
      const picked = w.scene.pick(e.position);
      if (picked && picked.primitive instanceof Cesium.PointPrimitive && typeof picked.id === "number") {
        select(picked.id);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    widget.current = w;
    setReady(true);
    const idx = index.current;
    return () => {
      handler.destroy();
      w.destroy();
      widget.current = null;
      idx.clear();
    };
  }, [select]);

  // ---- position polling at simulation time
  useEffect(() => {
    let alive = true;
    let inflight = false;
    const tick = async () => {
      if (inflight || !widget.current || !points.current) return;
      inflight = true;
      const t = simTimeISO();
      try {
        const p = await api.positions(t);
        if (!alive || !points.current || !widget.current) return;
        widget.current.clock.currentTime = Cesium.JulianDate.fromIso8601(p.time);
        const seen = new Set<number>();
        const c: Record<string, number> = {};
        const coll = points.current;
        for (let k = 0; k < p.norad_ids.length; k++) {
          const id = p.norad_ids[k];
          const type = p.types[k];
          seen.add(id);
          c[type] = (c[type] ?? 0) + 1;
          typeOf.current.set(id, type);
          const pos = new Cesium.Cartesian3(p.ecef_km[3 * k] * 1000, p.ecef_km[3 * k + 1] * 1000, p.ecef_km[3 * k + 2] * 1000);
          let pt = index.current.get(id);
          if (!pt) {
            pt = coll.add({ id, position: pos, pixelSize: 3, color: Cesium.Color.fromCssColorString(TYPE_COLOR[type]) });
            index.current.set(id, pt);
          } else {
            pt.position = pos;
          }
        }
        for (const [id, pt] of index.current) {
          if (!seen.has(id)) {
            coll.remove(pt);
            index.current.delete(id);
          }
        }
        setCounts(c);
        setMeta({ time: p.time, failed: p.failed });
      } catch (e) {
        alive && setMeta((m) => ({ time: m?.time ?? "", failed: m?.failed ?? 0, error: (e as Error).message }));
      } finally {
        inflight = false;
      }
    };
    tick();
    const id = setInterval(tick, refreshMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [refreshMs, dataVersion]);

  useTrackingOverlay(tracking && ready, widget, index, dataVersion);

  // ---- styling: visibility, selection, tracked satellites, nearby objects
  useEffect(() => {
    const shown = tracking ? new Map(shownTracked({ tracked, isolated }).map((t) => [t.id, t.color])) : new Map<number, string>();
    const anyTracked = tracking && shown.size > 0;
    for (const [id, pt] of index.current) {
      const type = typeOf.current.get(id) ?? "UNKNOWN";
      const sel = id === selectedId;
      const tc = shown.get(id);
      const nb = tracking && proximityOn ? nearby.get(id) : undefined;
      const nbShown = nb && (nb.category === "debris" ? tLayers.debris : tLayers.otherNearby);
      if (tc) {
        pt.show = true;
        pt.pixelSize = 10;
        pt.color = Cesium.Color.fromCssColorString(tc);
        pt.outlineColor = Cesium.Color.WHITE;
        pt.outlineWidth = 2;
      } else if (nbShown) {
        pt.show = true;
        pt.pixelSize = nb!.kind === "high" ? 8 : 6;
        pt.color = Cesium.Color.fromCssColorString(nb!.kind === "high" ? HIGH_COLOR : NEAR_COLOR);
        pt.outlineColor = Cesium.Color.BLACK.withAlpha(0.6);
        pt.outlineWidth = 1;
      } else {
        pt.show = sel || visible[type];
        pt.pixelSize = sel ? 9 : type === "PAYLOAD" ? 3.5 : 2.5;
        // with satellites tracked, the rest of the catalogue steps back to reduce clutter
        const base = Cesium.Color.fromCssColorString(TYPE_COLOR[type]);
        pt.color = sel ? SELECT_COLOR : anyTracked ? base.withAlpha(0.28) : base;
        pt.outlineColor = sel ? Cesium.Color.WHITE : Cesium.Color.TRANSPARENT;
        pt.outlineWidth = sel ? 2 : 0;
      }
    }
  });

  // ---- selected object: Earth-fixed trajectory for one orbital period
  useEffect(() => {
    const lc = lines.current;
    const lab = labels.current;
    lc?.removeAll();
    lab?.removeAll();
    if (selectedId === null || !showPath) return;
    let alive = true;
    const load = async () => {
      try {
        const [track, obj] = await Promise.all([api.orbit(selectedId, simTimeISO()), api.object(selectedId, simTimeISO())]);
        if (!alive || !lines.current || !labels.current) return;
        lines.current.removeAll();
        labels.current.removeAll();
        const pos = track.ecef_km.filter((_, i) => track.valid[i]).map(([x, y, z]) => new Cesium.Cartesian3(x * 1000, y * 1000, z * 1000));
        if (pos.length > 1) {
          lines.current.add({ positions: pos, width: 1.6, material: Cesium.Material.fromType("Color", { color: SELECT_COLOR.withAlpha(0.85) }) });
        }
        if (pos.length) {
          labels.current.add({
            position: pos[0],
            text: obj.name ?? String(selectedId),
            font: "12px Inter Variable, sans-serif",
            fillColor: Cesium.Color.fromCssColorString("#E8EEF7"),
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString("#0E1626").withAlpha(0.85),
            pixelOffset: new Cesium.Cartesian2(12, -12),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          });
        }
      } catch {
        /* inspector shows errors; globe stays quiet */
      }
    };
    load();
    const id = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [selectedId, showPath, dataVersion]);

  const flyToSelected = () => {
    const pt = selectedId !== null ? index.current.get(selectedId) : undefined;
    if (!pt || !widget.current) return;
    const carto = Cesium.Cartographic.fromCartesian(pt.position);
    widget.current.camera.flyTo({ destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height + 9_000_000), duration: 1.2 });
  };

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className={`relative overflow-hidden rounded-lg bg-app ${className}`}>
      <div ref={host} className="absolute inset-0" />

      {showLegend && (
        <div className="absolute left-3 top-3 z-10 w-[188px] rounded-lg border border-line-2 bg-panel/90 p-2.5 backdrop-blur">
          <div className="label-caps mb-1.5">Layers</div>
          {TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setVisible((v) => ({ ...v, [t]: !v[t] }))}
              className="flex w-full items-center justify-between rounded px-1.5 py-1 text-[11.5px] hover:bg-hover"
              aria-pressed={visible[t]}
            >
              <span className="flex items-center gap-2" style={{ opacity: visible[t] ? 1 : 0.45 }}>
                <span className="h-2 w-2 rounded-full" style={{ background: TYPE_COLOR[t] }} />
                <span className="text-ink">{t === "ROCKET BODY" ? "Rocket body" : t[0] + t.slice(1).toLowerCase()}</span>
              </span>
              <span className="flex items-center gap-1.5 text-muted">
                <span className="num text-[10.5px]">{fmtInt(counts[t] ?? 0)}</span>
                {visible[t] ? <Eye size={12} /> : <EyeOff size={12} />}
              </span>
            </button>
          ))}
          <button onClick={() => setShowPath((s) => !s)} className="mt-1 flex w-full items-center justify-between rounded px-1.5 py-1 text-[11.5px] hover:bg-hover" aria-pressed={showPath}>
            <span className="flex items-center gap-2 text-ink" style={{ opacity: showPath ? 1 : 0.45 }}>
              <span className="h-[2px] w-3 bg-cyan" /> Selected orbit
            </span>
            {showPath ? <Eye size={12} className="text-muted" /> : <EyeOff size={12} className="text-muted" />}
          </button>
        </div>
      )}

      <div className={`absolute top-3 z-10 flex flex-col gap-1.5 ${showLegend ? "left-[204px]" : "left-3"}`}>
        <button className="btn h-8 w-8 justify-center px-0" title="Reset view" aria-label="Reset view" onClick={() => widget.current?.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(78, 15, 24_000_000), duration: 1 })}>
          <Home size={14} />
        </button>
        <button className="btn h-8 w-8 justify-center px-0" title="Fly to selected object" aria-label="Fly to selected object" disabled={selectedId === null} onClick={flyToSelected}>
          <Crosshair size={14} />
        </button>
      </div>

      <div className="absolute bottom-3 left-3 z-10 rounded-md border border-line-2 bg-panel/85 px-2.5 py-1.5 text-[10.5px] text-ink-2 backdrop-blur">
        {meta?.error ? (
          <span className="text-danger">{meta.error}</span>
        ) : total === 0 ? (
          <span>No propagated objects. Ingest data from Data Sources.</span>
        ) : (
          <span>
            <span className="num text-ink">{fmtInt(total)}</span> objects · SGP4 · Earth-fixed
            {meta && meta.failed > 0 && <span className="text-warn"> · {meta.failed} failed (decayed)</span>}
          </span>
        )}
      </div>
    </div>
  );
}
