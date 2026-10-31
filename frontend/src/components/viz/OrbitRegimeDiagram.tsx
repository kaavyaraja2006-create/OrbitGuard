import { useReducedMotion } from "motion/react";

const R_E = 6378.137;
/** radius scale: compress so LEO, MEO and GEO all fit (power 0.6 of r - 0.6 R_E) */
const sc = (r_km: number, px: number) => px * Math.pow(Math.max(0, r_km - 0.6 * R_E) / (50000 - 0.6 * R_E), 0.6);

interface Props {
  byLabel: Record<string, number>;
  incEdges?: number[];
  incCounts?: number[];
}

/**
 * Orbit regimes on a compressed radial scale with the catalogue counts from /stats, and an
 * inclination rose from the stored inclination histogram. The moving dots illustrate Kepler's
 * third law: their angular speeds follow T ∝ a^1.5 (sped up), not individual objects.
 */
export function OrbitRegimeDiagram({ byLabel, incEdges, incCounts }: Props) {
  const reduce = useReducedMotion();
  const S = 300, C = S / 2, PX = C - 8;
  const rings = [
    { k: "LEO", r: R_E + 1000, band: [R_E + 160, R_E + 2000], c: "#4DA3FF" },
    { k: "MEO", r: R_E + 20200, band: [R_E + 2000, R_E + 35586], c: "#36D6E8" },
    { k: "GEO", r: 42164, band: [42164 - 200, 42164 + 200], c: "#A78BFA" },
  ];
  const T = (a: number) => 6 * Math.pow(a / (R_E + 1000), 1.5); // seconds per lap, LEO = 6 s
  const maxInc = Math.max(1, ...(incCounts ?? [0]));
  return (
    <div className="grid grid-cols-1 items-center gap-6 md:grid-cols-2">
      <svg viewBox={`0 0 ${S} ${S}`} className="mx-auto w-full max-w-[340px]" role="img" aria-label="Orbit regimes to scale">
        <defs>
          <radialGradient id="ord-earth" cx="38%" cy="34%" r="70%">
            <stop offset="0%" stopColor="#5aa3ff" />
            <stop offset="55%" stopColor="#1d5aa8" />
            <stop offset="100%" stopColor="#0b2346" />
          </radialGradient>
        </defs>
        {rings.map((g) => (
          <g key={g.k}>
            <circle cx={C} cy={C} r={(sc(g.band[0]!, PX) + sc(g.band[1]!, PX)) / 2} fill="none" stroke={g.c} strokeOpacity={0.09} strokeWidth={Math.max(2, sc(g.band[1]!, PX) - sc(g.band[0]!, PX))} />
            <circle cx={C} cy={C} r={sc(g.r, PX)} fill="none" stroke={g.c} strokeOpacity="0.55" strokeDasharray="2 5" />
          </g>
        ))}
        {/* HEO: a Molniya-like ellipse, perigee 600 km, apogee 39,700 km */}
        {(() => {
          const rp = sc(R_E + 600, PX), ra = sc(R_E + 39700, PX);
          const a = (rp + ra) / 2, cOff = a - rp, b = Math.sqrt(rp * ra);
          return <ellipse cx={C - cOff} cy={C} rx={a} ry={b} fill="none" stroke="#F5B942" strokeOpacity="0.5" strokeDasharray="4 4" transform={`rotate(-35 ${C} ${C})`} />;
        })()}
        <circle cx={C} cy={C} r={sc(R_E, PX)} fill="url(#ord-earth)" />
        {rings.map((g, i) => {
          const r = sc(g.r, PX);
          return (
            <g key={`m${g.k}`}>
              <circle r="3.2" fill={g.c}>
                {!reduce && <animateMotion dur={`${T(g.r).toFixed(2)}s`} repeatCount="indefinite" path={`M ${C + r} ${C} A ${r} ${r} 0 1 1 ${C - r} ${C} A ${r} ${r} 0 1 1 ${C + r} ${C}`} begin={`${-i * 1.3}s`} />}
              </circle>
              <text x={C + r * 0.71 + 4} y={C - r * 0.71 - 4} fill={g.c} fontSize="10.5" fontFamily="JetBrains Mono Variable">
                {g.k} {byLabel[g.k] ?? 0}
              </text>
            </g>
          );
        })}
        <text x={C - sc(R_E + 39700, PX) * 0.55} y={S - 14} fill="#F5B942" fontSize="10.5" fontFamily="JetBrains Mono Variable">HEO {byLabel["HEO"] ?? 0}</text>
      </svg>
      {incEdges && incCounts && (
        <div className="mx-auto w-full max-w-[440px]">
          <svg viewBox="-12 0 324 170" className="w-full" role="img" aria-label="Inclination distribution">
            {[0.33, 0.66, 1].map((f) => (
              <path key={f} d={`M ${150 - 130 * f} 150 A ${130 * f} ${130 * f} 0 0 1 ${150 + 130 * f} 150`} fill="none" stroke="#1A2639" />
            ))}
            {incCounts.map((c, i) => {
              const a0 = (incEdges[i]! * Math.PI) / 180, a1 = (incEdges[i + 1]! * Math.PI) / 180;
              const r = 12 + (118 * Math.sqrt(c)) / Math.sqrt(maxInc);
              const p = (a: number, rr: number) => `${150 - rr * Math.cos(a)} ${150 - rr * Math.sin(a)}`;
              const col = incEdges[i]! >= 95 && incEdges[i]! < 105 ? "#35D39A" : incEdges[i]! >= 80 && incEdges[i]! < 100 ? "#9AAAC0" : "#4DA3FF";
              return c ? <path key={i} d={`M 150 150 L ${p(a0, r)} A ${r} ${r} 0 0 1 ${p(a1, r)} Z`} fill={col} fillOpacity={0.55} stroke="#070B14" strokeWidth="0.8"><title>{`${incEdges[i]}–${incEdges[i + 1]}°: ${c}`}</title></path> : null;
            })}
            {[0, 45, 90, 135, 180].map((d) => {
              const a = (d * Math.PI) / 180;
              return <text key={d} x={150 - 142 * Math.cos(a)} y={154 - 142 * Math.sin(a)} fill="#64748B" fontSize="9.5" textAnchor="middle" fontFamily="JetBrains Mono Variable">{d}°</text>;
            })}
          </svg>
          <p className="text-center text-[10.5px] text-muted">Inclination rose: wedge length ∝ √count per 10° bin. Green: sun-synchronous band.</p>
        </div>
      )}
    </div>
  );
}
