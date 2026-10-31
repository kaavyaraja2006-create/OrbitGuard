/**
 * Small Cesium toolkit shared by every 3D view: one globe set-up, satellite marker icons and
 * trajectory materials. Only styling lives here; every position comes from the backend.
 */
import * as Cesium from "cesium";

export const COLORS = {
  original: "#4DA3FF", // original trajectories: blue
  modified: "#35D39A", // modified trajectories: green
  alternative: "#A78BFA",
  threat: "#FF9F43", // threats: orange
  tca: "#FF647C", // closest approach: red
  selected: "#36D6E8", // selected satellites: cyan
  burn: "#A78BFA", // maneuver markers: purple
} as const;

export const NATURAL_EARTH = () =>
  Cesium.ImageryLayer.fromProviderAsync(Cesium.TileMapServiceImageryProvider.fromUrl(Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII")));

export interface GlobeOptions {
  /** transparent canvas (unreliable on some GPUs; prefer `stars`) */
  transparent?: boolean;
  /** number of faint background stars drawn in the scene (decorative) */
  stars?: number;
  /** render only on demand (static views) */
  onDemand?: boolean;
  lighting?: boolean;
  background?: string;
}

/** Creates a CesiumWidget with the ORBITGUARD look: atmosphere, day/night lighting, no default chrome. */
export function createGlobe(host: HTMLElement, opts: GlobeOptions = {}): Cesium.CesiumWidget {
  const w = new Cesium.CesiumWidget(host, {
    baseLayer: NATURAL_EARTH(),
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    skyBox: false,
    shouldAnimate: false,
    requestRenderMode: !!opts.onDemand,
    contextOptions: opts.transparent ? { webgl: { alpha: true } } : undefined,
  });
  const sc = w.scene;
  sc.backgroundColor = opts.transparent ? Cesium.Color.TRANSPARENT : Cesium.Color.fromCssColorString(opts.background ?? "#070B14");
  sc.globe.enableLighting = opts.lighting ?? true;
  sc.globe.baseColor = Cesium.Color.fromCssColorString("#0B1A2E");
  sc.globe.showGroundAtmosphere = true;
  sc.globe.dynamicAtmosphereLighting = true;
  sc.globe.dynamicAtmosphereLightingFromSun = true;
  // soften the terminator so the night side stays legible
  sc.globe.nightFadeOutDistance = 1.0e7;
  sc.globe.nightFadeInDistance = 5.0e7;
  if (sc.skyAtmosphere) {
    sc.skyAtmosphere.show = true;
    sc.skyAtmosphere.brightnessShift = 0.05;
  }
  if (sc.sun) sc.sun.show = false;
  if (sc.moon) sc.moon.show = false;
  sc.fog.enabled = false;
  sc.highDynamicRange = false;
  if (opts.stars) {
    // decorative star field on a far sphere, so it turns with the camera
    const stars = sc.primitives.add(new Cesium.PointPrimitiveCollection());
    let seed = 99;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < opts.stars; i++) {
      const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u), R = 2.5e8;
      const b = 0.25 + rnd() * 0.6;
      stars.add({
        position: new Cesium.Cartesian3(R * r * Math.cos(th), R * r * Math.sin(th), R * u),
        pixelSize: rnd() < 0.08 ? 2 : 1.2,
        color: new Cesium.Color(0.85, 0.9, 1, b),
      });
    }
  }
  return w;
}

const iconCache = new Map<string, HTMLCanvasElement>();

/** A small satellite glyph (bus + two solar wings) with a soft glow, drawn once per colour. */
export function satelliteIcon(color: string, opts: { hollow?: boolean; size?: number } = {}): HTMLCanvasElement {
  const size = opts.size ?? 40;
  const key = `${color}|${opts.hollow ? 1 : 0}|${size}`;
  const hit = iconCache.get(key);
  if (hit) return hit;
  const cv = document.createElement("canvas");
  const dpr = 2;
  cv.width = cv.height = size * dpr;
  const g = cv.getContext("2d")!;
  g.scale(dpr, dpr);
  const c = size / 2;
  const grad = g.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, color + "66");
  grad.addColorStop(1, color + "00");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  g.save();
  g.translate(c, c);
  g.rotate(-Math.PI / 4);
  g.lineWidth = 1.2;
  g.strokeStyle = color;
  g.fillStyle = opts.hollow ? "rgba(7,11,20,0.85)" : color;
  // solar wings
  const wingW = size * 0.24, wingH = size * 0.13;
  for (const s of [-1, 1]) {
    g.beginPath();
    g.rect(s > 0 ? size * 0.11 : -size * 0.11 - wingW, -wingH / 2, wingW, wingH);
    g.globalAlpha = opts.hollow ? 1 : 0.85;
    g.fill();
    g.stroke();
    g.globalAlpha = 1;
    g.beginPath();
    g.moveTo(s * size * 0.07, 0);
    g.lineTo(s * size * 0.11, 0);
    g.stroke();
  }
  // bus
  const b = size * 0.14;
  g.beginPath();
  g.rect(-b / 2, -b / 2, b, b);
  g.fillStyle = opts.hollow ? "rgba(7,11,20,0.9)" : "#E8EEF7";
  g.fill();
  g.strokeStyle = color;
  g.stroke();
  g.restore();
  iconCache.set(key, cv);
  return cv;
}

/** Billboard options for a satellite marker at a position (metres, Earth-fixed). */
export function SatelliteMarker(position: Cesium.Cartesian3, color: string, opts: { hollow?: boolean; scale?: number; id?: unknown } = {}) {
  return {
    position,
    image: satelliteIcon(color, { hollow: opts.hollow }),
    scale: opts.scale ?? 0.9,
    id: opts.id,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  };
}

/** Polyline material for a trajectory: solid, dashed, or glowing. */
export function OrbitTrajectory(color: string, opts: { dashed?: boolean; glow?: boolean; alpha?: number } = {}): Cesium.Material {
  const c = Cesium.Color.fromCssColorString(color).withAlpha(opts.alpha ?? 0.9);
  if (opts.dashed) return Cesium.Material.fromType("PolylineDash", { color: c, gapColor: Cesium.Color.TRANSPARENT, dashLength: 18 });
  if (opts.glow) return Cesium.Material.fromType("PolylineGlow", { color: c, glowPower: 0.18, taperPower: 1.0 });
  return Cesium.Material.fromType("Color", { color: c });
}

export const km = (p: ArrayLike<number | null>, k = 0) => new Cesium.Cartesian3((p[k] as number) * 1000, (p[k + 1] as number) * 1000, (p[k + 2] as number) * 1000);

export const labelStyle = (color: string): Partial<Cesium.Label.ConstructorOptions> => ({
  font: "600 11.5px Inter Variable, sans-serif",
  fillColor: Cesium.Color.fromCssColorString(color),
  showBackground: true,
  backgroundColor: Cesium.Color.fromCssColorString("#0E1626").withAlpha(0.88),
  backgroundPadding: new Cesium.Cartesian2(6, 4),
  disableDepthTestDistance: Number.POSITIVE_INFINITY,
  horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
  verticalOrigin: Cesium.VerticalOrigin.CENTER,
});

export function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
