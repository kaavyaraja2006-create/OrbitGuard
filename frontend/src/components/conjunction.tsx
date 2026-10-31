import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ShieldAlert, ShieldCheck } from "lucide-react";
import { api } from "../services/api";
import type { ObjectRow, PcAssessment, Priority } from "../types";

const PRIORITY: Record<Priority, { color: string; icon: typeof ShieldAlert }> = {
  HIGH: { color: "var(--color-danger)", icon: ShieldAlert },
  MEDIUM: { color: "var(--color-warn)", icon: AlertTriangle },
  LOW: { color: "var(--color-ink-2)", icon: ShieldCheck },
};

/** Text + icon + colour, never colour alone. */
export function PriorityBadge({ p }: { p: Priority }) {
  const { color, icon: Icon } = PRIORITY[p];
  return (
    <span
      className="inline-flex h-[20px] items-center gap-1 rounded px-1.5 text-[10.5px] font-semibold tracking-wide"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 35%, transparent)` }}
      title="Geometric priority from miss distance only: HIGH < 1 km, MEDIUM < 5 km, LOW otherwise"
    >
      <Icon size={11} /> {p}
    </span>
  );
}

export function fmtPc(p: number | null | undefined) {
  if (p === null || p === undefined) return "—";
  if (p === 0) return "0";
  if (p >= 1e-3) return p.toFixed(4);
  return p.toExponential(2);
}

export function fmtDistance(km: number) {
  return km < 1 ? `${(km * 1000).toFixed(0)} m` : `${km.toFixed(km < 10 ? 3 : 1)} km`;
}

export function timeToTca(iso: string, nowMs: number) {
  const s = (new Date(iso).getTime() - nowMs) / 1000;
  const a = Math.abs(s);
  const txt = a < 3600 ? `${Math.round(a / 60)} min` : a < 172800 ? `${(a / 3600).toFixed(1)} h` : `${(a / 86400).toFixed(1)} d`;
  return s >= 0 ? `in ${txt}` : `${txt} ago`;
}

/** Search-as-you-type picker over the catalog. */
export function ObjectPicker({ value, onChange }: { value: ObjectRow | null; onChange: (o: ObjectRow | null) => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ObjectRow[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (q.trim().length < 1) return setItems([]);
    const id = setTimeout(() => api.objects({ q, limit: 10 }).then((r) => setItems(r.items)).catch(() => setItems([])), 200);
    return () => clearTimeout(id);
  }, [q]);
  useEffect(() => {
    const h = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div ref={box} className="relative">
      {value ? (
        <div className="input flex items-center justify-between">
          <span className="truncate text-ink">
            {value.name ?? "Unnamed"} <span className="num text-muted">#{value.norad_id}</span>
          </span>
          <button className="text-[11px] text-cyan hover:underline" onClick={() => onChange(null)}>
            Change
          </button>
        </div>
      ) : (
        <input className="input w-full" placeholder="Search primary by name or NORAD ID" value={q} onChange={(e) => (setQ(e.target.value), setOpen(true))} onFocus={() => setOpen(true)} aria-label="Primary object" />
      )}
      {open && !value && q && (
        <div className="absolute z-30 mt-1 max-h-[260px] w-full overflow-y-auto rounded-lg border border-line bg-elevated shadow-2xl">
          {items.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-muted">No match</div>
          ) : (
            items.map((it) => (
              <button
                key={it.norad_id}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] hover:bg-hover"
                onClick={() => {
                  onChange(it);
                  setOpen(false);
                  setQ("");
                }}
              >
                <span className="truncate text-ink">{it.name ?? "Unnamed"}</span>
                <span className="num text-[10.5px] text-muted">
                  #{it.norad_id} · {it.perigee_alt_km.toFixed(0)}–{it.apogee_alt_km.toFixed(0)} km
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Encounter-plane view: miss vector, hard-body circle at the origin, and the
 * 1σ / 3σ ellipses of the combined covariance when one has been supplied.
 */
export function EncounterPlanePlot({ a }: { a: PcAssessment }) {
  const W = 340;
  const H = 260;
  const [mx, my] = a.encounter_plane_miss_km;
  const ell = a.ellipse_1sigma;
  const extent = Math.max(Math.hypot(mx, my) * 1.35, ell ? 3.3 * Math.max(...ell.semi_axes_km) : 0, a.hbr_km * 4, 1e-3);
  const s = Math.min(W, H) / (2 * extent);
  const cx = W / 2;
  const cy = H / 2;
  const X = (x: number) => cx + x * s;
  const Y = (y: number) => cy - y * s;
  const tick = niceTick(extent);
  const ticks = [-2, -1, 1, 2].map((k) => k * tick).filter((v) => Math.abs(v) < extent);
  const hbrPx = Math.max(a.hbr_km * s, 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Encounter plane geometry">
      <rect width={W} height={H} fill="#070B14" rx={6} />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={X(t)} x2={X(t)} y1={0} y2={H} stroke="#1A2639" />
          <line x1={0} x2={W} y1={Y(t)} y2={Y(t)} stroke="#1A2639" />
          <text x={X(t)} y={H - 4} fontSize={9} fill="#64748B" textAnchor="middle" fontFamily="JetBrains Mono Variable">
            {fmtTick(t)}
          </text>
        </g>
      ))}
      <line x1={0} x2={W} y1={cy} y2={cy} stroke="#223149" />
      <line x1={cx} x2={cx} y1={0} y2={H} stroke="#223149" />
      {ell && (
        <g transform={`translate(${X(mx)} ${Y(my)}) rotate(${-ell.angle_deg})`}>
          <ellipse rx={3 * ell.semi_axes_km[1] * s} ry={3 * ell.semi_axes_km[0] * s} fill="none" stroke="#F5B942" strokeDasharray="4 3" opacity={0.7} />
          <ellipse rx={ell.semi_axes_km[1] * s} ry={ell.semi_axes_km[0] * s} fill="color-mix(in srgb, #F5B942 10%, transparent)" stroke="#F5B942" />
        </g>
      )}
      <circle cx={cx} cy={cy} r={hbrPx} fill="color-mix(in srgb, #FF647C 30%, transparent)" stroke="#FF647C" />
      <line x1={cx} y1={cy} x2={X(mx)} y2={Y(my)} stroke="#36D6E8" strokeWidth={1.3} />
      <circle cx={X(mx)} cy={Y(my)} r={4} fill="#36D6E8" />
      <text x={X(mx) > W * 0.6 ? X(mx) - 7 : X(mx) + 7} y={Y(my) - 9} textAnchor={X(mx) > W * 0.6 ? "end" : "start"} fontSize={10} fill="#E8EEF7" fontFamily="JetBrains Mono Variable">
        miss {fmtDistance(Math.hypot(mx, my))}
      </text>
      <text x={8} y={14} fontSize={9.5} fill="#9AAAC0">
        Encounter plane (⊥ relative velocity) · grid {fmtTick(tick)}
      </text>
      <text x={cx + hbrPx + 4} y={cy + 12} fontSize={9} fill="#FF647C">
        HBR {Math.round(a.hbr_km * 1000)} m{hbrPx <= 2 ? " (enlarged)" : ""}
      </text>
    </svg>
  );
}

function niceTick(extent: number) {
  const raw = extent / 2.2;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 2 ? 1 : m < 5 ? 2 : 5) * p;
}

function fmtTick(km: number) {
  return Math.abs(km) < 1 ? `${Math.round(km * 1000)} m` : `${km} km`;
}
