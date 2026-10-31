import { motion, useReducedMotion } from "motion/react";
import { EASE } from "../fx/motion";

/**
 * Before → after miss distance for each threat on a log axis, with the safety distance marked.
 * A line from the red dot (no burn) to the green dot (with the burn) shows how far each threat moved.
 */
export function MissDumbbell({ rows, dMinKm }: { rows: { name: string; before: number; after: number | null }[]; dMinKm: number }) {
  const reduce = useReducedMotion();
  const vals = rows.flatMap((r) => [r.before, r.after ?? r.before, dMinKm]).filter((v) => v > 0);
  const lo = Math.pow(10, Math.floor(Math.log10(Math.min(...vals)))), hi = Math.pow(10, Math.ceil(Math.log10(Math.max(...vals))));
  const W = 980, L = 110, R = 60, rowH = 30, T = 18, H = T + rows.length * rowH + 26;
  const x = (v: number) => L + ((Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * (W - L - R);
  const decades: number[] = [];
  for (let d = lo; d <= hi * 1.0001; d *= 10) decades.push(d);
  const fmtD = (km: number) => (km < 1 ? `${+(km * 1000).toPrecision(2)} m` : `${+km.toPrecision(2)} km`);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Miss distance before and after the maneuver">
      <rect x={L} y={T - 6} width={x(dMinKm) - L} height={rows.length * rowH + 6} fill="#FF647C" fillOpacity="0.06" />
      {decades.map((d) => (
        <g key={d}>
          <line x1={x(d)} x2={x(d)} y1={T - 6} y2={T + rows.length * rowH} stroke="#1A2639" />
          <text x={x(d)} y={H - 8} fill="#64748B" fontSize="10" textAnchor="middle" fontFamily="JetBrains Mono Variable">{fmtD(d)}</text>
        </g>
      ))}
      <line x1={x(dMinKm)} x2={x(dMinKm)} y1={T - 8} y2={T + rows.length * rowH} stroke="#FF647C" strokeDasharray="4 3" />
      <text x={x(dMinKm) + 4} y={T - 1} fill="#FF647C" fontSize="9.5">safety distance {fmtD(dMinKm)}</text>
      {rows.map((r, i) => {
        const y = T + i * rowH + rowH / 2 + 4;
        const a = r.after ?? r.before;
        return (
          <g key={r.name}>
            <text x={L - 10} y={y + 3.5} fill="#E8EEF7" fontSize="11.5" textAnchor="end">{r.name}</text>
            <motion.line
              x1={x(r.before)} y1={y} y2={y}
              initial={reduce ? false : { x2: x(r.before) }}
              animate={{ x2: x(a) }}
              transition={{ duration: 0.9, ease: EASE, delay: 0.15 + i * 0.08 }}
              stroke="#35D39A" strokeOpacity="0.45" strokeWidth="3" strokeLinecap="round"
            />
            <circle cx={x(r.before)} cy={y} r="5" fill="#FF647C" />
            {r.after !== null && (
              <motion.circle
                cy={y} r="5.5" fill="#35D39A" stroke="#070B14" strokeWidth="1.5"
                initial={reduce ? false : { cx: x(r.before), opacity: 0 }}
                animate={{ cx: x(a), opacity: 1 }}
                transition={{ duration: 0.9, ease: EASE, delay: 0.15 + i * 0.08 }}
              />
            )}
            <text x={Math.max(x(a), x(r.before)) + 10} y={y + 3.5} fill="#9AAAC0" fontSize="10" fontFamily="JetBrains Mono Variable">
              {fmtD(r.before)}{r.after !== null && ` → ${fmtD(r.after)}`}
            </text>
          </g>
        );
      })}
      <defs>
        <linearGradient id="md-grad" x1="0" x2="1">
          <stop offset="0%" stopColor="#FF647C" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#35D39A" stopOpacity="0.9" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** Δv vector in the RTN frame drawn as a small isometric glyph (R up, T right, N out of the page). */
export function DvVector({ rtn }: { rtn: number[] }) {
  const [r, t, n] = rtn.map((v) => v * 1000);
  const m = Math.max(1e-9, Math.hypot(r!, t!, n!));
  const S = 120, C = S / 2, L = 44;
  const iso = (R: number, T: number, N: number) => [C + T * L - N * L * 0.55, C - R * L + N * L * 0.32] as const;
  const [ex, ey] = iso(r! / m, t! / m, n! / m);
  const axes: [string, [number, number, number], string][] = [["R", [1, 0, 0], "#4DA3FF"], ["T", [0, 1, 0], "#A78BFA"], ["N", [0, 0, 1], "#35D39A"]];
  return (
    <svg viewBox={`0 0 ${S} ${S}`} className="h-[120px] w-[120px] shrink-0" role="img" aria-label="Burn direction in the RTN frame">
      {axes.map(([k, v, c]) => {
        const [ax, ay] = iso(...v);
        return (
          <g key={k}>
            <line x1={C} y1={C} x2={ax} y2={ay} stroke={c} strokeOpacity="0.4" />
            <text x={ax + (k === "N" ? -10 : 4)} y={ay + (k === "R" ? -3 : 4)} fill={c} fontSize="10" fontFamily="JetBrains Mono Variable">{k}</text>
          </g>
        );
      })}
      <line x1={C} y1={C} x2={ex} y2={ey} stroke="#A78BFA" strokeWidth="3" strokeLinecap="round" />
      <circle cx={ex} cy={ey} r="4" fill="#A78BFA" />
      <circle cx={C} cy={C} r="3" fill="#E8EEF7" />
    </svg>
  );
}
