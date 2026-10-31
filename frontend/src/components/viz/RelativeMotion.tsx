import { useEffect, useMemo, useState } from "react";
import { useReducedMotion } from "motion/react";

type Plane = "TR" | "TN" | "RN";
const AXES: Record<Plane, [keyof Tr, keyof Tr, string, string]> = {
  TR: ["T_km", "R_km", "along-track T", "radial R"],
  TN: ["T_km", "N_km", "along-track T", "cross-track N"],
  RN: ["R_km", "N_km", "radial R", "cross-track N"],
};
interface Tr {
  t_s: number[];
  R_km: number[];
  T_km: number[];
  N_km: number[];
}

/**
 * Closest-approach animation in the primary's RTN frame: the secondary's SGP4 relative positions
 * (from the screening) are replayed around TCA, with the miss vector and the hard-body radius.
 * Nothing is extrapolated: the marker only moves along the stored samples.
 */
export function RelativeMotion({ tr, hbrM, missKm }: { tr: Tr; hbrM: number; missKm: number }) {
  const reduce = useReducedMotion();
  const [plane, setPlane] = useState<Plane>("TR");
  const [zoom, setZoom] = useState(1); // 1 = auto window
  const [k, setK] = useState(0);
  const [x, y, xl, yl] = AXES[plane];
  const n = tr.t_s.length;
  const i0 = useMemo(() => {
    let b = 0;
    for (let i = 0; i < n; i++) if (Math.hypot(tr.R_km[i]!, tr.T_km[i]!, tr.N_km[i]!) < Math.hypot(tr.R_km[b]!, tr.T_km[b]!, tr.N_km[b]!)) b = i;
    return b;
  }, [tr, n]);

  // visible window: samples whose range is within ~8x the miss (at least 3 samples each side), scaled by zoom
  const [lo, hi] = useMemo(() => {
    const lim = Math.max(missKm * 8, 0.05) * zoom;
    let a = i0, b = i0;
    while (a > 0 && (Math.hypot(tr.R_km[a - 1]!, tr.T_km[a - 1]!, tr.N_km[a - 1]!) < lim || i0 - a < 3)) a--;
    while (b < n - 1 && (Math.hypot(tr.R_km[b + 1]!, tr.T_km[b + 1]!, tr.N_km[b + 1]!) < lim || b - i0 < 3)) b++;
    return [a, b];
  }, [tr, i0, n, missKm, zoom]);

  useEffect(() => {
    if (reduce) {
      setK(i0);
      return;
    }
    setK(lo);
    let raf = 0, last = performance.now(), acc = lo;
    const span = Math.max(1, hi - lo);
    const loop = (now: number) => {
      acc += ((now - last) / 1000) * (span / 4.5); // one pass in ~4.5 s
      last = now;
      if (acc > hi + span * 0.25) acc = lo;
      setK(Math.min(hi, acc));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [lo, hi, i0, reduce]);

  const W = 420, H = 280, P = 34;
  const pts = useMemo(() => tr.t_s.slice(lo, hi + 1).map((_, j) => [tr[x][lo + j]!, tr[y][lo + j]!] as [number, number]), [tr, lo, hi, x, y]);
  const ext = Math.max(1e-6, ...pts.map(([a, b]) => Math.max(Math.abs(a), Math.abs(b)))) * 1.12;
  const sx = (v: number) => W / 2 + (v / ext) * (W / 2 - P);
  const sy = (v: number) => H / 2 - (v / ext) * (H / 2 - P);
  const kk = Math.floor(k), f = k - kk;
  const at = (arr: number[]) => (kk >= n - 1 ? arr[n - 1]! : arr[kk]! + (arr[kk + 1]! - arr[kk]!) * f);
  const cur: [number, number] = [at(tr[x]), at(tr[y])];
  const curT = at(tr.t_s), curR = Math.hypot(at(tr.R_km), at(tr.T_km), at(tr.N_km));
  const tca: [number, number] = [tr[x][i0]!, tr[y][i0]!];
  const hbrPx = Math.max(1.5, ((hbrM / 1000) / ext) * (W / 2 - P));
  const path = pts.map(([a, b], j) => `${j ? "L" : "M"}${sx(a).toFixed(1)},${sy(b).toFixed(1)}`).join(" ");
  const done = pts.slice(0, Math.max(0, Math.floor(k) - lo + 1)).map(([a, b], j) => `${j ? "L" : "M"}${sx(a).toFixed(1)},${sy(b).toFixed(1)}`).join(" ");
  const tick = niceTick(ext);

  return (
    <div className="rounded-lg border border-line-2 bg-app p-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-line-2 p-0.5" role="group" aria-label="Projection plane">
          {(Object.keys(AXES) as Plane[]).map((p) => (
            <button key={p} onClick={() => setPlane(p)} aria-pressed={plane === p} className={`num rounded px-2 py-0.5 text-[10.5px] ${plane === p ? "bg-cyan/15 text-cyan" : "text-ink-2 hover:text-ink"}`}>
              {p[0]}–{p[1]}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-[10.5px] text-ink-2">
          window
          <input type="range" min={0.3} max={4} step={0.1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-20" aria-label="Time window" />
        </label>
        <span className="num ml-auto text-[10.5px] text-muted">
          TCA{curT >= 0 ? "+" : ""}{curT.toFixed(1)} s · range <span className="text-ink">{curR < 1 ? `${(curR * 1000).toFixed(0)} m` : `${curR.toFixed(2)} km`}</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Relative motion of the secondary around the primary">
        <defs>
          <linearGradient id="rm-path" x1="0" x2="1">
            <stop offset="0%" stopColor="#FF9F43" stopOpacity="0.15" />
            <stop offset="50%" stopColor="#FF9F43" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#FF9F43" stopOpacity="0.15" />
          </linearGradient>
          <radialGradient id="rm-glow">
            <stop offset="0%" stopColor="#36D6E8" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#36D6E8" stopOpacity="0" />
          </radialGradient>
        </defs>
        {/* grid */}
        {[-2, -1, 1, 2].map((g) => (
          <g key={g} stroke="#1A2639">
            <line x1={sx(g * tick)} x2={sx(g * tick)} y1={P / 2} y2={H - P / 2} />
            <line y1={sy(g * tick)} y2={sy(g * tick)} x1={P / 2} x2={W - P / 2} />
          </g>
        ))}
        <line x1={P / 2} x2={W - P / 2} y1={H / 2} y2={H / 2} stroke="#223149" />
        <line y1={P / 2} y2={H - P / 2} x1={W / 2} x2={W / 2} stroke="#223149" />
        <text x={W - P / 2} y={H / 2 - 6} fill="#64748B" fontSize="9.5" textAnchor="end" fontFamily="JetBrains Mono Variable">{xl}</text>
        <text x={W / 2 + 6} y={P / 2 + 8} fill="#64748B" fontSize="9.5" fontFamily="JetBrains Mono Variable">{yl}</text>
        <text x={sx(tick)} y={H / 2 + 13} fill="#64748B" fontSize="9" textAnchor="middle" fontFamily="JetBrains Mono Variable">{fmtTick(tick)}</text>
        {/* primary and hard-body radius */}
        <circle cx={W / 2} cy={H / 2} r={18} fill="url(#rm-glow)" />
        <circle cx={W / 2} cy={H / 2} r={hbrPx} fill="#FF647C" fillOpacity="0.12" stroke="#FF647C" strokeOpacity="0.7" strokeDasharray="2 2" />
        <rect x={W / 2 - 4} y={H / 2 - 4} width="8" height="8" fill="#36D6E8" transform={`rotate(45 ${W / 2} ${H / 2})`} />
        {/* path, traversed part, miss vector */}
        <path d={path} fill="none" stroke="url(#rm-path)" strokeWidth="1.5" />
        <path d={done} fill="none" stroke="#FF9F43" strokeWidth="2.2" />
        <line x1={W / 2} y1={H / 2} x2={sx(tca[0])} y2={sy(tca[1])} stroke="#FF647C" strokeDasharray="4 3" />
        <circle cx={sx(tca[0])} cy={sy(tca[1])} r="3.5" fill="#FF647C" />
        <text x={sx(tca[0]) + 7} y={sy(tca[1]) - 7} fill="#FF647C" fontSize="10" fontFamily="JetBrains Mono Variable">
          TCA · {missKm < 1 ? `${(missKm * 1000).toFixed(0)} m` : `${missKm.toFixed(2)} km`}
        </text>
        <circle cx={sx(cur[0])} cy={sy(cur[1])} r="9" fill="#FF9F43" opacity="0.18" />
        <circle cx={sx(cur[0])} cy={sy(cur[1])} r="4" fill="#FF9F43" stroke="#070B14" strokeWidth="1" />
      </svg>
      <p className="mt-1 text-[10.5px] text-muted">
        Secondary (orange) passing the primary (cyan) in the primary's RTN frame, replayed from the SGP4 samples. Red dashed circle: hard-body radius {hbrM} m{hbrPx <= 1.5 ? " (enlarged to stay visible)" : ""}.
      </p>
    </div>
  );
}

function niceTick(extent: number) {
  const raw = extent / 2;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}
function fmtTick(km: number) {
  return km < 1 ? `${+(km * 1000).toPrecision(3)} m` : `${+km.toPrecision(3)} km`;
}
