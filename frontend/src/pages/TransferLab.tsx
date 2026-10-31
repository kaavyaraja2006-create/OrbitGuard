import { useMemo, useState } from "react";
import { Loader2, Play } from "lucide-react";
import { EmptyState, KV, PageHeader, Panel } from "../components/ui";
import { Notice } from "../components/auth/AuthLayout";
import { api, ApiError } from "../services/api";
import { fmt } from "../lib/format";

const KINDS: [string, string][] = [
  ["hohmann", "Hohmann (raise / lower)"],
  ["combined", "Hohmann + plane change (optimal split)"],
  ["bielliptic", "Bi-elliptic"],
  ["plane-change", "Pure plane change"],
  ["raise-apogee", "Circular → elliptical (raise apogee)"],
];
const PRESETS: { label: string; v: Record<string, number | string | null> }[] = [
  { label: "LEO raise 400→800 km", v: { kind: "hohmann", alt1_km: 400, alt2_km: 800, inc1_deg: 51.6, inc2_deg: null } },
  { label: "LEO lower 800→400 km", v: { kind: "hohmann", alt1_km: 800, alt2_km: 400, inc1_deg: 51.6, inc2_deg: null } },
  { label: "LEO → MEO (GPS altitude)", v: { kind: "hohmann", alt1_km: 500, alt2_km: 20200, inc1_deg: 55, inc2_deg: null } },
  { label: "LEO → GEO from 28.5°", v: { kind: "combined", alt1_km: 300, alt2_km: 35786, inc1_deg: 28.5, inc2_deg: 0 } },
  { label: "LEO → GTO", v: { kind: "raise-apogee", alt1_km: 250, alt2_km: 35786, inc1_deg: 28.5, inc2_deg: null } },
  { label: "1° plane change at 700 km", v: { kind: "plane-change", alt1_km: 700, alt2_km: null, inc1_deg: 98, inc2_deg: 97 } },
  { label: "Bi-elliptic (Vallado 6-2)", v: { kind: "bielliptic", alt1_km: 191.34411, alt2_km: 376310, inc1_deg: 0, inc2_deg: null, alt_b_km: 503873 } },
];
const LEG_COLORS = ["#4DA3FF", "#F5B942", "#A78BFA", "#35D39A", "#36D6E8"];

export function TransferLab() {
  const [f, setF] = useState<Record<string, number | string | null>>({ ...PRESETS[0]!.v, mass_kg: 1000, isp_s: 300 });
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<"plane" | "edge">("plane");
  const run = async (body = f) => {
    setBusy(true);
    setErr(null);
    try {
      const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null && v !== ""));
      setRes(await api.transfer(clean));
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const num = (k: string) => (f[k] === null || f[k] === undefined ? "" : String(f[k]));
  const setN = (k: string, v: string) => setF((x) => ({ ...x, [k]: v === "" ? null : Number(v) }));
  const kind = String(f.kind);
  return (
    <div>
      <PageHeader eyebrow="Simulation" title="ORBIT TRANSFER LAB" subtitle="Idealised impulsive transfers: analytical Δv and time of flight, checked by flying the same burns numerically." />
      <div className="mb-4 rounded-lg border border-line-2 bg-panel px-3 py-2 text-[12px] text-ink-2">
        <b className="text-ink">Orbit transfer is not collision avoidance.</b> These are large planned orbit changes (km/s); an avoidance burn is typically millimetres to centimetres per second.
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Panel title="Transfer">
          <div className="mb-3 flex flex-wrap gap-1.5">
            {PRESETS.map((p) => <button key={p.label} className="btn h-7 px-2 text-[11px]" onClick={() => { const nf = { ...f, alt_b_km: null, ...p.v }; setF(nf); run(nf); }}>{p.label}</button>)}
          </div>
          <label className="mb-2.5 block"><span className="mb-1 block text-[11px] text-ink-2">Type</span>
            <select className="input w-full" value={kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </label>
          <div className="grid grid-cols-2 gap-2.5">
            <In l="Initial altitude (km)" v={num("alt1_km")} on={(v) => setN("alt1_km", v)} />
            {kind !== "plane-change" && <In l={kind === "raise-apogee" ? "New apogee alt (km)" : "Final altitude (km)"} v={num("alt2_km")} on={(v) => setN("alt2_km", v)} />}
            <In l="Initial inclination (°)" v={num("inc1_deg")} on={(v) => setN("inc1_deg", v)} />
            {(kind === "combined" || kind === "plane-change") && <In l="Final inclination (°)" v={num("inc2_deg")} on={(v) => setN("inc2_deg", v)} />}
            {kind === "bielliptic" && <In l="Intermediate apoapsis alt (km)" v={num("alt_b_km")} on={(v) => setN("alt_b_km", v)} />}
            <In l="Spacecraft mass (kg)" v={num("mass_kg")} on={(v) => setN("mass_kg", v)} />
            <In l="Isp (s)" v={num("isp_s")} on={(v) => setN("isp_s", v)} />
          </div>
          {err && <div className="mt-3"><Notice kind="error">{err}</Notice></div>}
          <button className="btn btn-primary mt-4 w-full justify-center" disabled={busy} onClick={() => run()}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Compute & fly</button>
        </Panel>
        {!res ? <Panel><EmptyState title="Choose a preset or set up a transfer" /></Panel> : (
          <div className="min-w-0 space-y-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
              <Panel title="Trajectory" subtitle={view === "plane" ? "Projected onto the initial orbital plane" : "Edge-on (out-of-plane exaggerated ×1)"} actions={
                <div className="flex gap-1">{(["plane", "edge"] as const).map((v) => <button key={v} className={`h-7 rounded px-2 text-[11px] ${view === v ? "bg-cyan/15 text-cyan" : "text-ink-2"}`} onClick={() => setView(v)}>{v === "plane" ? "Orbit plane" : "Edge-on"}</button>)}</div>
              }>
                <OrbitPlot res={res} view={view} />
              </Panel>
              <Panel title="Result">
                <KV k="Total Δv (analytical)"><span className="num text-ok">{fmt(res.analytical.dv_total_kms * 1000, 1)} m/s</span></KV>
                <KV k="Total Δv (flown)"><span className="num">{fmt(res.numerical_dv_total_kms * 1000, 1)} m/s</span></KV>
                {res.analytical.tof_s > 0 && <KV k="Time of flight"><span className="num">{fmt(res.analytical.tof_s / 3600, 3)} h</span></KV>}
                {res.analytical.optimal_split_at_departure !== undefined && <KV k="Plane change at departure"><span className="num">{fmt(res.analytical.optimal_split_at_departure * 100, 1)} %</span></KV>}
                {res.analytical.alternatives && <>
                  <KV k="All plane change at apoapsis"><span className="num">{fmt(res.analytical.alternatives.all_at_apoapsis_kms * 1000, 1)} m/s</span></KV>
                  <KV k="Hohmann + separate plane change"><span className="num">{fmt(res.analytical.alternatives.hohmann_then_separate_plane_change_kms * 1000, 1)} m/s</span></KV>
                </>}
                {res.propellant && <KV k="Propellant (rocket equation)"><span className="num">{fmt(res.propellant.propellant_kg, 1)} kg ({fmt(res.propellant.fraction * 100, 1)} %)</span></KV>}
                <div className="label-caps mb-1 mt-3">Orbit reached (numerical) vs target</div>
                <KV k="a"><span className="num">{fmt(res.reached.a_km, 3)} km {res.reached.target_r_km && <span className="text-muted">/ {fmt(res.reached.target_r_km, 3)}</span>}</span></KV>
                <KV k="e"><span className="num">{res.reached.e.toExponential(2)}</span></KV>
                <KV k="i"><span className="num">{fmt(res.reached.i_deg, 4)}° <span className="text-muted">/ {fmt(res.reached.target_i_deg, 4)}°</span></span></KV>
                <p className="mt-2 text-[10.5px] text-muted">{res.label}</p>
              </Panel>
            </div>
            <Panel title="Burns" bodyClassName="p-0 overflow-x-auto">
              <table className="w-full min-w-[560px] text-[12px]">
                <thead><tr className="border-b border-line-2 text-left text-[10px] uppercase tracking-wider text-muted"><th className="px-3 py-2 font-semibold">Burn</th><th className="px-2 text-right font-semibold">|Δv| (m/s)</th><th className="px-3 font-semibold">Δv R / T / N (m/s)</th></tr></thead>
                <tbody>{res.burns.map((b: { label: string; dv_kms: number; dv_rtn_kms: number[] }, i: number) => (
                  <tr key={i} className="border-b border-line-2/70"><td className="px-3 py-2 text-ink">{b.label}</td><td className="num px-2 text-right">{fmt(b.dv_kms * 1000, 2)}</td><td className="num px-3">{b.dv_rtn_kms.map((x) => (x * 1000).toFixed(2)).join(" / ")}</td></tr>
                ))}</tbody>
              </table>
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}

function In({ l, v, on }: { l: string; v: string; on: (v: string) => void }) {
  return <label className="block"><span className="mb-1 block text-[11px] text-ink-2">{l}</span><input type="number" step="any" className="input num w-full" value={v} onChange={(e) => on(e.target.value)} /></label>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function OrbitPlot({ res, view }: { res: any; view: "plane" | "edge" }) {
  const { legs, scale, basis } = useMemo(() => {
    const first: number[][] = res.legs[0].r_km;
    const r0 = first[0]!, r1 = first[Math.min(5, first.length - 1)]!;
    const norm = (a: number[]) => Math.hypot(a[0]!, a[1]!, a[2]!);
    const e1 = r0.map((x) => x / norm(r0));
    const n = [r0[1]! * r1[2]! - r0[2]! * r1[1]!, r0[2]! * r1[0]! - r0[0]! * r1[2]!, r0[0]! * r1[1]! - r0[1]! * r1[0]!];
    const e3 = n.map((x) => x / norm(n));
    const e2 = [e3[1]! * e1[2]! - e3[2]! * e1[1]!, e3[2]! * e1[0]! - e3[0]! * e1[2]!, e3[0]! * e1[1]! - e3[1]! * e1[0]!];
    const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const L = res.legs.map((leg: any) => ({ label: leg.label, pts: leg.r_km.map((p: number[]) => [dot(p, e1), view === "plane" ? dot(p, e2) : dot(p, e3)]) }));
    const max = Math.max(...L.flatMap((l: { pts: number[][] }) => l.pts.map((p) => Math.max(Math.abs(p[0]!), Math.abs(p[1]!)))), 6378);
    return { legs: L, scale: 230 / max, basis: { e1, e2, e3, dot } };
  }, [res, view]);
  const S = 520;
  const c = S / 2;
  const burns = res.burns.map((b: { r_km: number[]; label: string }) => [basis.dot(b.r_km, basis.e1), view === "plane" ? basis.dot(b.r_km, basis.e2) : basis.dot(b.r_km, basis.e3)]);
  return (
    <div>
      <svg viewBox={`0 0 ${S} ${S}`} className="mx-auto block w-full max-w-[520px]">
        <defs><radialGradient id="tl-earth" cx="40%" cy="35%" r="70%"><stop offset="0%" stopColor="#2b6cb0" /><stop offset="100%" stopColor="#0a2346" /></radialGradient></defs>
        {view === "plane" ? <circle cx={c} cy={c} r={6378.137 * scale} fill="url(#tl-earth)" /> : <rect x={c - 6378.137 * scale} y={c - 6356.75 * scale} width={2 * 6378.137 * scale} height={2 * 6356.75 * scale} rx={6378 * scale} fill="url(#tl-earth)" />}
        {legs.map((l: { label: string; pts: number[][] }, i: number) => (
          <polyline key={i} fill="none" stroke={LEG_COLORS[i % LEG_COLORS.length]} strokeWidth={i === 0 || i === legs.length - 1 ? 1.8 : 2.4} strokeDasharray={i > 0 && i < legs.length - 1 ? "6 4" : undefined}
            points={l.pts.map((p) => `${c + p[0]! * scale},${c - p[1]! * scale}`).join(" ")} />
        ))}
        {burns.map((p: number[], i: number) => <circle key={i} cx={c + p[0]! * scale} cy={c - p[1]! * scale} r={5} fill="#F5B942" stroke="#070B14" strokeWidth={1.5} />)}
      </svg>
      <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-[11px] text-ink-2">
        {legs.map((l: { label: string }, i: number) => <span key={i} className="flex items-center gap-1.5"><span className="h-[3px] w-4 rounded" style={{ background: LEG_COLORS[i % LEG_COLORS.length] }} />{l.label}</span>)}
        <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-warn" />burn</span>
      </div>
    </div>
  );
}
