import { useMemo } from "react";

/**
 * Decorative orbital scene for the sign-in screens (pure SVG + SMIL, no data).
 * Satellites move along tilted ellipses; the inner orbit is fastest, as Kepler requires.
 */
export function OrbitalScene({ accent = "#36D6E8" }: { accent?: string }) {
  const stars = useMemo(() => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    return Array.from({ length: 140 }, () => ({ x: rnd() * 800, y: rnd() * 800, r: rnd() * 1.1 + 0.2, o: rnd() * 0.6 + 0.15 }));
  }, []);
  const orbits = [
    { rx: 190, ry: 70, rot: -24, dur: 9, color: accent, sat: 3.6 },
    { rx: 255, ry: 105, rot: 32, dur: 15, color: "#4DA3FF", sat: 3 },
    { rx: 330, ry: 120, rot: -8, dur: 24, color: "#A78BFA", sat: 3.2 },
    { rx: 300, ry: 300, rot: 0, dur: 38, color: "#9AAAC0", sat: 2.4 },
  ];
  return (
    <svg viewBox="0 0 800 800" className="h-full w-full" aria-hidden>
      <defs>
        <radialGradient id="og-earth" cx="38%" cy="34%" r="70%">
          <stop offset="0%" stopColor="#2b6cb0" />
          <stop offset="45%" stopColor="#123a6b" />
          <stop offset="100%" stopColor="#06142a" />
        </radialGradient>
        <radialGradient id="og-glow" cx="50%" cy="50%" r="50%">
          <stop offset="60%" stopColor={accent} stopOpacity="0.18" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </radialGradient>
        <linearGradient id="og-night" x1="0" x2="1" y1="0" y2="0">
          <stop offset="45%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      {stars.map((s, i) => (
        <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#E8EEF7" opacity={s.o} />
      ))}
      <g transform="translate(400 400)">
        <circle r="150" fill="url(#og-glow)" />
        {orbits.map((o, i) => (
          <g key={i} transform={`rotate(${o.rot})`}>
            <ellipse rx={o.rx} ry={o.ry} fill="none" stroke={o.color} strokeOpacity="0.28" strokeWidth="1" strokeDasharray={i === 3 ? "2 6" : undefined} />
          </g>
        ))}
        <circle r="96" fill="url(#og-earth)" />
        <g opacity="0.35" stroke="#8fc1ff" strokeWidth="0.6" fill="none">
          <ellipse rx="96" ry="30" />
          <ellipse rx="96" ry="62" />
          <ellipse rx="40" ry="96" />
          <ellipse rx="76" ry="96" />
          <line x1="-96" x2="96" />
        </g>
        <circle r="96" fill="url(#og-night)" />
        {orbits.map((o, i) => (
          <g key={`s${i}`} transform={`rotate(${o.rot})`}>
            <circle r={o.sat} fill={o.color}>
              <animateMotion dur={`${o.dur}s`} repeatCount="indefinite" path={`M ${o.rx} 0 A ${o.rx} ${o.ry} 0 1 1 ${-o.rx} 0 A ${o.rx} ${o.ry} 0 1 1 ${o.rx} 0`} />
            </circle>
            <circle r={o.sat * 3.2} fill={o.color} opacity="0.18">
              <animateMotion dur={`${o.dur}s`} repeatCount="indefinite" path={`M ${o.rx} 0 A ${o.rx} ${o.ry} 0 1 1 ${-o.rx} 0 A ${o.rx} ${o.ry} 0 1 1 ${o.rx} 0`} />
            </circle>
          </g>
        ))}
      </g>
    </svg>
  );
}
