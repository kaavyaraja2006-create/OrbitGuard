import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import * as Cesium from "cesium";
import { api } from "../services/api";
import { simTimeISO } from "../stores/app";
import { NEAR_COLOR, shownTracked, useTracking } from "../stores/tracking";

const DEFAULT_VIEW = Cesium.Cartesian3.fromDegrees(78, 15, 24_000_000);
const toCart = ([x, y, z]: number[]) => new Cesium.Cartesian3(x! * 1000, y! * 1000, z! * 1000);

/**
 * Multi-satellite overlay on the Cesium globe:
 *  - each selected satellite's SGP4 orbit (one period, Earth-fixed) in its own colour
 *  - a sphere of the chosen proximity radius centred on the satellite's propagated position
 *  - labels, camera commands, and trajectories of nearby objects on request
 * Orbits are fetched from the backend; nothing here is drawn from assumed geometry.
 */
export function useTrackingOverlay(
  enabled: boolean,
  widget: MutableRefObject<Cesium.CesiumWidget | null>,
  index: MutableRefObject<Map<number, Cesium.PointPrimitive>>,
  dataVersion: number,
) {
  const tracked = useTracking((s) => s.tracked);
  const isolated = useTracking((s) => s.isolated);
  const layers = useTracking((s) => s.layers);
  const radiusKm = useTracking((s) => s.radiusKm);
  const proximityOn = useTracking((s) => s.proximityOn);
  const nearbyPaths = useTracking((s) => s.nearbyPaths);
  const camera = useTracking((s) => s.camera);

  const lines = useRef<Cesium.PolylineCollection | null>(null);
  const labels = useRef<Cesium.LabelCollection | null>(null);
  const spheres = useRef(new Map<number, Cesium.Primitive[]>());
  const labelOf = useRef(new Map<number, Cesium.Label>());
  const orbits = useRef(new Map<number, Cesium.Cartesian3[]>());

  const shown = shownTracked({ tracked, isolated });
  const shownKey = shown.map((t) => `${t.id}:${t.color}`).join(",");

  // collections
  useEffect(() => {
    const w = widget.current;
    if (!enabled || !w) return;
    lines.current = w.scene.primitives.add(new Cesium.PolylineCollection());
    labels.current = w.scene.primitives.add(new Cesium.LabelCollection());
    const sph = spheres.current;
    return () => {
      if (!w.isDestroyed()) {
        w.scene.primitives.remove(lines.current!);
        w.scene.primitives.remove(labels.current!);
        for (const ps of sph.values()) ps.forEach((p) => w.scene.primitives.remove(p));
      }
      sph.clear();
      lines.current = null;
      labels.current = null;
    };
  }, [enabled, widget]);

  // orbits of the selected satellites and of requested nearby objects
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const ids = shown.map((t) => t.id);
    const extra = layers.nearbyPaths ? [...nearbyPaths].filter((i) => !ids.includes(i)).slice(0, 25) : [];
    const load = async () => {
      const lc = lines.current;
      if (!lc) return;
      if (!ids.length && !extra.length) {
        lc.removeAll();
        orbits.current.clear();
        return;
      }
      try {
        const [a, b] = await Promise.all([
          ids.length ? api.multiSelect(ids, simTimeISO(), true) : Promise.resolve({ items: [] }),
          extra.length ? api.multiSelect(extra, simTimeISO(), true) : Promise.resolve({ items: [] }),
        ]);
        if (!alive || !lines.current) return;
        lines.current.removeAll();
        orbits.current.clear();
        const draw = (id: number, pts: number[][] | undefined, valid: boolean[] | undefined, color: Cesium.Color, width: number, dashed = false) => {
          const pos = (pts ?? []).filter((_, i) => valid?.[i]).map(toCart);
          if (pos.length < 2) return;
          orbits.current.set(id, pos);
          lines.current!.add({
            positions: pos,
            width,
            material: dashed
              ? Cesium.Material.fromType("PolylineDash", { color, dashLength: 12 })
              : Cesium.Material.fromType("Color", { color }),
          });
        };
        if (layers.orbits) {
          for (const it of a.items) {
            const t = shown.find((x) => x.id === it.norad_id);
            if (t && it.orbit) draw(it.norad_id, it.orbit.ecef_km, it.orbit.valid, Cesium.Color.fromCssColorString(t.color).withAlpha(0.8), 1.8);
          }
        }
        for (const it of b.items) if (it.orbit) draw(it.norad_id, it.orbit.ecef_km, it.orbit.valid, Cesium.Color.fromCssColorString(NEAR_COLOR).withAlpha(0.75), 1.4, true);
      } catch {
        /* the panel reports API errors */
      }
    };
    load();
    const id = setInterval(load, 60000); // the ground track drifts as the Earth turns
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, shownKey, layers.orbits, layers.nearbyPaths, [...nearbyPaths].join(","), dataVersion]);

  // proximity spheres (rebuilt when the set, radius or colours change)
  useEffect(() => {
    const w = widget.current;
    if (!enabled || !w) return;
    for (const ps of spheres.current.values()) ps.forEach((p) => w.scene.primitives.remove(p));
    spheres.current.clear();
    if (!proximityOn || !layers.boundary) return;
    for (const t of shown) {
      const c = Cesium.Color.fromCssColorString(t.color);
      const fill = new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry: new Cesium.EllipsoidGeometry({ radii: new Cesium.Cartesian3(1, 1, 1), vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(c.withAlpha(0.12)) },
        }),
        appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true }),
        asynchronous: false,
      });
      const wire = new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry: new Cesium.EllipsoidOutlineGeometry({ radii: new Cesium.Cartesian3(1, 1, 1), stackPartitions: 12, slicePartitions: 16 }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(c.withAlpha(0.55)) },
        }),
        appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
        asynchronous: false,
      });
      w.scene.primitives.add(fill);
      w.scene.primitives.add(wire);
      spheres.current.set(t.id, [fill, wire]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, shownKey, radiusKm, proximityOn, layers.boundary]);

  // labels (rebuilt with the set)
  useEffect(() => {
    const lab = labels.current;
    if (!enabled || !lab) return;
    lab.removeAll();
    labelOf.current.clear();
    if (!layers.labels) return;
    for (const t of shown) {
      const l = lab.add({
        position: Cesium.Cartesian3.ZERO,
        text: t.name ?? String(t.id),
        font: "600 12px Inter Variable, sans-serif",
        fillColor: Cesium.Color.fromCssColorString(t.color),
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("#0E1626").withAlpha(0.85),
        pixelOffset: new Cesium.Cartesian2(12, -12),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        show: false,
      });
      labelOf.current.set(t.id, l);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, shownKey, layers.labels]);

  // every render (positions poll ~1 Hz): move spheres and labels with their satellites
  useEffect(() => {
    if (!enabled) return;
    const r = radiusKm * 1000;
    for (const [id, ps] of spheres.current) {
      const pt = index.current.get(id);
      ps.forEach((p) => {
        p.show = !!pt;
        if (pt) p.modelMatrix = Cesium.Matrix4.multiplyByUniformScale(Cesium.Matrix4.fromTranslation(pt.position), r, new Cesium.Matrix4());
      });
    }
    for (const [id, l] of labelOf.current) {
      const pt = index.current.get(id);
      l.show = !!pt;
      if (pt) l.position = pt.position;
    }
  });

  // camera commands
  useEffect(() => {
    const w = widget.current;
    if (!enabled || !w || !camera) return;
    const cam = w.camera;
    const posOf = (id?: number) => (id !== undefined ? index.current.get(id)?.position : undefined);
    if (camera.kind === "reset") cam.flyTo({ destination: DEFAULT_VIEW, duration: 1 });
    else if (camera.kind === "focus") {
      const p = posOf(camera.id);
      if (p) cam.flyToBoundingSphere(new Cesium.BoundingSphere(p, Math.max(radiusKm * 1000 * 3, 150_000)), { duration: 1.2 });
    } else if (camera.kind === "orbit") {
      const o = camera.id !== undefined ? orbits.current.get(camera.id) : undefined;
      if (o) cam.flyToBoundingSphere(Cesium.BoundingSphere.fromPoints(o), { duration: 1.2 });
    } else if (camera.kind === "all") {
      const pts = shown.map((t) => posOf(t.id)).filter((p): p is Cesium.Cartesian3 => !!p);
      const all = pts.concat(...shown.map((t) => orbits.current.get(t.id) ?? []));
      if (all.length) {
        const bs = Cesium.BoundingSphere.fromPoints(all);
        bs.radius = Math.max(bs.radius, 7_000_000);
        cam.flyToBoundingSphere(bs, { duration: 1.2 });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera?.nonce]);
}
