import { useMemo, useState } from "react";

/**
 * Perigee altitude x inclination count grid as a heat map (log colour scale).
 * Cells with no objects stay empty, so gaps in the catalogue remain visible.
 */
export function DensityHeatmap({ altEdges, incEdges, counts }: { altEdges: number[]; incEdges: number[]; counts: number[][] }) {
  const [hover, setHover] = useState<{ i: number; j: number } | null>(null);
  const max = useMemo(() => Math.max(1, ...counts.flat()), [counts]);
  const W = 1120, H = 340, L = 56, B = 30, T = 8, R = 12;
  const nA = counts.length, nI = counts[0]?.length ?? 0;
  const cw = (W - L - R) / nI, ch = (H - T - B) / nA;
  const color = (c: number) => {
    if (!c) return null;
    const f = Math.log1p(c) / Math.log1p(max); // 0..1
    // dark blue -> cyan -> amber -> red
    const stops = [[18, 40, 80], [54, 214, 232], [245, 185, 66], [255, 100, 124]];
    const x = f * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(x)), u = x - k;
    const a = stops[k]!, b = stops[k + 1]!;
    return `rgb(${a.map((v, q) => Math.round(v + (b[q]! - v) * u)).join(",")})`;
  };
  const altTicks = altEdges.filter((_, i) => i % Math.max(1, Math.round(nA / 8)) === 0);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Perigee altitude versus inclination density">
        <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="#070B14" stroke="#1A2639" />
        {counts.map((row, i) =>
          row.map((c, j) => {
            const fill = color(c);
            if (!fill) return null;
            return (
              <rect
                key={`${i}-${j}`}
                x={L + j * cw + 0.5}
                y={H - B - (i + 1) * ch + 0.5}
                width={Math.max(0.5, cw - 1)}
                height={Math.max(0.5, ch - 1)}
                rx={1.5}
                fill={fill}
                onMouseEnter={() => setHover({ i, j })}
                onMouseLeave={() => setHover(null)}
              />
            );
          }),
        )}
        {[0, 30, 60, 90, 120, 150, 180].map((d) => (
          <g key={d}>
            <line x1={L + (d / 180) * (W - L - R)} x2={L + (d / 180) * (W - L - R)} y1={H - B} y2={H - B + 4} stroke="#223149" />
            <text x={L + (d / 180) * (W - L - R)} y={H - B + 15} fill="#64748B" fontSize="10" textAnchor="middle" fontFamily="JetBrains Mono Variable">{d}°</text>
          </g>
        ))}
        {altTicks.map((a) => {
          const i = altEdges.indexOf(a);
          return (
            <text key={a} x={L - 6} y={H - B - i * ch + 3} fill="#64748B" fontSize="10" textAnchor="end" fontFamily="JetBrains Mono Variable">{a}</text>
          );
        })}
        <text x={L + (W - L - R) / 2} y={H - 2} fill="#9AAAC0" fontSize="10.5" textAnchor="middle">inclination</text>
        <text x={10} y={T + (H - T - B) / 2} fill="#9AAAC0" fontSize="10.5" textAnchor="middle" transform={`rotate(-90 10 ${T + (H - T - B) / 2})`}>perigee altitude (km)</text>
        <line x1={L + (98 / 180) * (W - L - R)} x2={L + (98 / 180) * (W - L - R)} y1={T} y2={H - B} stroke="#35D39A" strokeOpacity="0.35" strokeDasharray="3 4" />
        <text x={L + (98 / 180) * (W - L - R) + 4} y={T + 12} fill="#35D39A" fillOpacity="0.7" fontSize="9.5">≈ SSO band</text>
      </svg>
      {hover && (
        <div className="glass pointer-events-none absolute right-2 top-2 rounded-lg px-2.5 py-1.5 text-[11px] text-ink-2">
          <span className="num text-ink">{counts[hover.i]![hover.j]}</span> objects · {altEdges[hover.i]}–{altEdges[hover.i + 1]} km · {incEdges[hover.j]}–{incEdges[hover.j + 1]}°
        </div>
      )}
      <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
        <span>1</span>
        <span className="h-2 w-40 rounded-full" style={{ background: "linear-gradient(90deg, rgb(18,40,80), rgb(54,214,232), rgb(245,185,66), rgb(255,100,124))" }} />
        <span>{max} objects per cell (log scale)</span>
      </div>
    </div>
  );
}
