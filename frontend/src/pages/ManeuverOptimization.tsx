import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, Clapperboard, FileText, Fuel, Loader2, Play, Plus, Radar, Search, ShieldAlert, Sparkles, Trash2, XCircle } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState, ErrorState, KV, LoadingState, PageHeader, Panel } from "../components/ui";
import { DvVector, MissDumbbell } from "../components/viz/MissDumbbell";
import { Notice } from "../components/auth/AuthLayout";
import { api, ApiError } from "../services/api";
import { useAsync } from "../services/useAsync";
import { simTimeISO, useApp } from "../stores/app";
import { useCan } from "../stores/auth";
import { fmt, utc } from "../lib/format";
import type { Candidate, Plan, PlanResult } from "../types/mission";
import { SimBadge, tip } from "./DigitalTwin";

interface Synth {
  tca_h: number;
  miss_m: number;
  crossing_deg: number;
  phase_deg: number;
}

const DEMO: Synth[] = [
  { tca_h: 8.3, miss_m: 80, crossing_deg: 70, phase_deg: 10 },
  { tca_h: 14.4, miss_m: 120, crossing_deg: 120, phase_deg: 80 },
  { tca_h: 19.7, miss_m: 300, crossing_deg: 40, phase_deg: 200 },
];

const fmtPc = (p: number) => (p === 0 ? "0" : p < 1e-12 ? "<1e-12" : p.toExponential(1));
const mm = (ms: number) => `${fmt(ms * 1000, 1)} mm/s`;

export function ManeuverOptimization() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const planId = Number(params.get("plan")) || null;
  const plans = useAsync(() => api.plans(), [planId], 5000);
  const open = (id: number) => setParams((p) => { p.set("plan", String(id)); return p; }, { replace: true });
  return (
    <div>
      <PageHeader eyebrow="Simulation" title="MANEUVER OPTIMIZATION" subtitle="Uncertainty-aware multi-threat avoidance: every candidate is propagated, checked against hard constraints, scored, stress-tested and independently validated." />
      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[420px_minmax(0,1fr)]">
        <div className="space-y-4">
          {can("maneuver:plan") ? <PlanSetup onQueued={open} /> : <Panel><p className="text-[12px] text-ink-2">Your role can view plans; running the optimiser needs the maneuver-planning permission.</p></Panel>}
          <Panel title="Plans" bodyClassName="p-0 max-h-[420px] overflow-y-auto">
            {plans.error ? <ErrorState message={plans.error} /> : !plans.data ? <LoadingState /> : plans.data.length === 0 ? <EmptyState title="No plans yet" /> : (
              <ul className="divide-y divide-line-2">
                {plans.data.map((p) => (
                  <li key={p.id}>
                    <button onClick={() => open(p.id)} className={`flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-hover/50 ${p.id === planId ? "bg-elevated" : ""}`}>
                      <StatusDot s={p.status === "succeeded" ? p.result_status ?? "" : p.status} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] text-ink">#{p.id} · {p.twin_name}</span>
                        <span className="text-[10.5px] text-muted">{p.method} · {p.status === "succeeded" ? p.result_status : p.status}{p.dv_ms ? ` · ${mm(p.dv_ms)}` : ""}</span>
                      </span>
                      <span className="num text-[10px] text-muted">{utc(p.created_at, false).slice(5, 16)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
        <div className="min-w-0">{planId ? <PlanView id={planId} /> : <Panel><EmptyState title="Set up a plan or pick one from the list" icon={<Sparkles size={18} />} /></Panel>}</div>
      </div>
    </div>
  );
}

function StatusDot({ s }: { s: string }) {
  const c = s === "selected" ? "bg-ok" : s === "no-maneuver-needed" ? "bg-blue" : s.startsWith("no-") || s === "failed" ? "bg-danger" : "bg-warn animate-pulse";
  return <span className={`h-2 w-2 shrink-0 rounded-full ${c}`} />;
}

// ------------------------------------------------------------------ setup
function PlanSetup({ onQueued }: { onQueued: (id: number) => void }) {
  const [params] = useSearchParams();
  const twins = useAsync(() => api.twins(), []);
  const [twinId, setTwinId] = useState<number | null>(Number(params.get("twin")) || null);
  const [method, setMethod] = useState("proposed");
  const [horizon, setHorizon] = useState(24);
  const [synth, setSynth] = useState<Synth[]>([]);
  const [catalog, setCatalog] = useState<{ norad_id: number; name: string | null; miss_km: number; tca: string }[]>([]);
  const [chosen, setChosen] = useState<number[]>([]);
  const [screening, setScreening] = useState(false);
  const [adv, setAdv] = useState(false);
  const [o, setO] = useState({ pc_limit: 1e-4, d_min_m: 200, p_violation_max: 0.05, w: [0.5, 0.25, 0.15, 0.1] });
  const [u, setU] = useState({ p: [0.1, 0.3, 0.1], s: [0.2, 0.6, 0.2], hbr_m: 20, mc: 64, scale: 1 });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!twinId && twins.data?.length) setTwinId(twins.data[0]!.id);
  }, [twins.data, twinId]);
  const twin = twins.data?.find((t) => t.id === twinId);

  const screen = async () => {
    if (!twinId) return;
    setScreening(true);
    setErr(null);
    try {
      const r = await api.screenTwin(twinId, horizon, 10, simTimeISO());
      setCatalog(r.encounters);
      setChosen(r.encounters.filter((e) => e.miss_km < 2).map((e) => e.norad_id));
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setScreening(false);
    }
  };
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.optimize({
        twin_id: twinId, start: simTimeISO(), horizon_h: horizon, method, catalog_threats: chosen, synthetic_threats: synth,
        optimizer: { pc_limit: o.pc_limit, d_min_m: o.d_min_m, p_violation_max: o.p_violation_max, weights: o.w },
        uncertainty: { primary_sigma_rtn_km: u.p, secondary_sigma_rtn_km: u.s, hbr_m: u.hbr_m, mc_samples: u.mc, scale: u.scale },
      });
      onQueued(r.plan_id);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const n = (v: string) => Number(v);
  return (
    <Panel title="New plan" subtitle="Starts at the simulation clock time">
      {err && <Notice kind="error">{err}</Notice>}
      {twins.data && twins.data.length === 0 ? (
        <EmptyState title="Create a digital twin first"><Link to="/digital-twin" className="text-cyan hover:underline">Digital Twin →</Link></EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="col-span-2 block"><span className="mb-1 block text-[11px] text-ink-2">Simulated satellite</span>
              <select className="input w-full" value={twinId ?? ""} onChange={(e) => setTwinId(n(e.target.value))}>
                {(twins.data ?? []).map((t) => <option key={t.id} value={t.id}>#{t.id} {t.name} · {fmt(t.summary.dv_available_ms, 1)} m/s available</option>)}
              </select>
            </label>
            <label className="block"><span className="mb-1 block text-[11px] text-ink-2">Method</span>
              <select className="input w-full" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="proposed">Uncertainty-aware multi-threat</option>
                <option value="multi-nominal">Multi-threat, nominal only</option>
                <option value="single">Single worst threat (baseline)</option>
              </select>
            </label>
            <label className="block"><span className="mb-1 block text-[11px] text-ink-2">Horizon</span>
              <select className="input w-full" value={horizon} onChange={(e) => setHorizon(n(e.target.value))}>{[12, 24, 48].map((h) => <option key={h} value={h}>{h} h</option>)}</select>
            </label>
          </div>

          <div className="mt-4 flex items-center justify-between"><span className="label-caps">Real threats (catalogue)</span>
            <button className="btn h-7" disabled={!twinId || screening} onClick={screen}>{screening ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />} Screen catalogue</button>
          </div>
          {catalog.length === 0 ? (
            <p className="mt-1 text-[11px] text-muted">Screen the twin's predicted path (numerical, J2 + drag) against every catalogue object within 10 km.</p>
          ) : (
            <ul className="mt-2 max-h-[150px] overflow-y-auto rounded-lg border border-line-2">
              {catalog.map((c) => (
                <li key={c.norad_id}><label className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[11.5px] hover:bg-hover">
                  <input type="checkbox" className="accent-cyan" checked={chosen.includes(c.norad_id)} onChange={(e) => setChosen((x) => (e.target.checked ? [...x, c.norad_id] : x.filter((y) => y !== c.norad_id)))} />
                  <span className="min-w-0 flex-1 truncate text-ink">{c.name ?? c.norad_id}</span>
                  <span className="num text-ink-2">{fmt(c.miss_km, 2)} km</span>
                  <span className="num text-[10px] text-muted">{utc(c.tca).slice(11, 16)}</span>
                </label></li>
              ))}
            </ul>
          )}

          <div className="mt-4 flex items-center justify-between"><span className="label-caps flex items-center gap-1.5">Synthetic test threats <SimBadge>SYNTHETIC</SimBadge></span>
            <div className="flex gap-1">
              <button className="btn h-7 px-2" onClick={() => setSynth(DEMO.filter((d) => d.tca_h < horizon))}>Demo set</button>
              <button className="btn h-7 px-2" onClick={() => setSynth((s) => [...s, { tca_h: Math.min(horizon - 1, 6), miss_m: 100, crossing_deg: 60, phase_deg: 0 }])}><Plus size={12} /></button>
            </div>
          </div>
          <p className="mt-1 text-[10.5px] text-muted">Engineered objects that pass the twin's predicted path at the time and miss distance you set. Use them to exercise the optimiser when the real catalogue has no close approach.</p>
          {synth.length > 0 && (
            <div className="mt-2 space-y-1.5">
              <div className="grid grid-cols-[1fr_1fr_1fr_1fr_24px] gap-1.5 text-[10px] text-muted"><span>TCA (h)</span><span>Miss (m)</span><span>Crossing°</span><span>Phase°</span><span /></div>
              {synth.map((s, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_1fr_1fr_24px] gap-1.5">
                  {(["tca_h", "miss_m", "crossing_deg", "phase_deg"] as const).map((k) => (
                    <input key={k} type="number" step="any" className="input num h-7 px-1.5" value={s[k]} onChange={(e) => setSynth((x) => x.map((y, j) => (j === i ? { ...y, [k]: n(e.target.value) } : y)))} aria-label={k} />
                  ))}
                  <button className="text-muted hover:text-danger" onClick={() => setSynth((x) => x.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          )}

          <button className="mt-4 text-[11.5px] text-cyan hover:underline" onClick={() => setAdv((a) => !a)}>{adv ? "Hide" : "Show"} limits, weights and uncertainty</button>
          {adv && (
            <div className="mt-2 space-y-3 rounded-lg border border-line-2 p-3">
              <div className="grid grid-cols-3 gap-2">
                <F l="Pc limit" v={o.pc_limit} on={(v) => setO({ ...o, pc_limit: v })} />
                <F l="Min miss (m)" v={o.d_min_m} on={(v) => setO({ ...o, d_min_m: v })} />
                <F l="Max P(violation)" v={o.p_violation_max} on={(v) => setO({ ...o, p_violation_max: v })} />
              </div>
              <div>
                <div className="mb-1 text-[11px] text-ink-2">Weights: risk R · fuel F · mission M · robustness U</div>
                <div className="grid grid-cols-4 gap-2">{o.w.map((w, i) => <F key={i} l={"RFMU"[i]!} v={w} on={(v) => setO({ ...o, w: o.w.map((x, j) => (j === i ? v : x)) })} />)}</div>
              </div>
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-[11px] text-ink-2">Assumed 1σ at TCA, RTN (km) <SimBadge>ASSUMED</SimBadge></div>
                <div className="grid grid-cols-[70px_1fr_1fr_1fr] items-center gap-1.5 text-[10.5px] text-muted">
                  <span>Satellite</span>{u.p.map((x, i) => <input key={i} type="number" step="any" className="input num h-7 px-1.5" value={x} onChange={(e) => setU({ ...u, p: u.p.map((y, j) => (j === i ? n(e.target.value) : y)) })} />)}
                  <span>Threats</span>{u.s.map((x, i) => <input key={i} type="number" step="any" className="input num h-7 px-1.5" value={x} onChange={(e) => setU({ ...u, s: u.s.map((y, j) => (j === i ? n(e.target.value) : y)) })} />)}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <F l="Hard-body radius (m)" v={u.hbr_m} on={(v) => setU({ ...u, hbr_m: v })} />
                <F l="MC samples" v={u.mc} on={(v) => setU({ ...u, mc: v })} />
                <F l="Uncertainty scale" v={u.scale} on={(v) => setU({ ...u, scale: v })} />
              </div>
            </div>
          )}
          <button className="btn btn-primary mt-4 h-9 w-full justify-center" disabled={busy || !twinId || (!synth.length && !chosen.length)} onClick={run}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Optimise maneuver{twin ? ` for ${twin.name}` : ""}
          </button>
          <p className="mt-2 text-[10.5px] text-muted">Runs as a background job (typically 10–40 s). Nothing is sent to any spacecraft.</p>
        </>
      )}
    </Panel>
  );
}

function F({ l, v, on }: { l: string; v: number; on: (v: number) => void }) {
  return (
    <label className="block"><span className="mb-1 block text-[10.5px] text-ink-2">{l}</span>
      <input type="number" step="any" className="input num h-7 w-full px-1.5" value={v} onChange={(e) => on(Number(e.target.value))} /></label>
  );
}

// ------------------------------------------------------------------ results
function PlanView({ id }: { id: number }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const load = () =>
      api.plan(id).then((p) => {
        if (!alive) return;
        setPlan(p);
        setErr(null);
        if (p.status === "queued" || p.status === "running") timer = window.setTimeout(load, 1200);
      }).catch((e) => alive && setErr((e as ApiError).message));
    setPlan(null);
    load();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [id]);
  if (err) return <Panel><ErrorState message={err} /></Panel>;
  if (!plan) return <Panel><LoadingState /></Panel>;
  if (plan.status === "queued" || plan.status === "running")
    return (
      <Panel title={`Plan #${plan.id} · ${plan.twin_name}`}>
        <div className="py-8 text-center">
          <Loader2 size={22} className="mx-auto mb-3 animate-spin text-cyan" />
          <div className="text-[13px] text-ink">{plan.stage ?? "queued"}</div>
          <div className="mx-auto mt-3 h-1.5 max-w-[360px] overflow-hidden rounded bg-hover"><div className="h-full bg-cyan transition-all" style={{ width: `${Math.round(plan.progress * 100)}%` }} /></div>
          <div className="num mt-1 text-[11px] text-muted">{Math.round(plan.progress * 100)}% · progress reflects work actually done</div>
        </div>
      </Panel>
    );
  if (plan.status === "failed") return <Panel title={`Plan #${plan.id}`}><Notice kind="error">{plan.message}</Notice></Panel>;
  return <Result plan={plan} res={plan.result!} />;
}

function Result({ plan, res }: { plan: Plan; res: PlanResult }) {
  const can = useCan();
  const nav = useNavigate();
  const select = useApp((s) => s.select);
  const [booked, setBooked] = useState<string | null>(null);
  const sel = res.selected;
  const val = res.validation;
  const banner =
    res.status === "selected" ? { k: "ok" as const, t: "Maneuver selected" } :
    res.status === "no-maneuver-needed" ? { k: "info" as const, t: "No maneuver needed" } :
    { k: "error" as const, t: res.status === "no-robust-candidate" ? "No robust maneuver found" : "No acceptable maneuver found" };
  const rej = Object.entries(res.rejection_summary ?? {}).sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }));
  const book = async () => {
    try {
      await api.applyPlan(plan.twin_id, plan.id);
      setBooked("Propellant booked against the twin (simulated bookkeeping).");
    } catch (e) {
      setBooked((e as ApiError).message);
    }
  };
  return (
    <div className="space-y-4">
      <div className={`panel relative overflow-hidden px-5 py-4 ${banner.k === "ok" ? "border-ok/40" : banner.k === "error" ? "border-danger/40" : "border-blue/40"}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              {banner.k === "ok" ? <CheckCircle2 size={18} className="text-ok" /> : banner.k === "error" ? <XCircle size={18} className="text-danger" /> : <ShieldAlert size={18} className="text-blue" />}
              <h2 className="text-[16px] font-semibold text-ink">{banner.t}</h2>
              <SimBadge />{val && <span className={`rounded px-1.5 py-px text-[10px] font-semibold ${val.status === "passed" ? "bg-ok/15 text-ok" : "bg-danger/15 text-danger"}`}>VALIDATION {String(val.status).toUpperCase()}</span>}
            </div>
            <div className="mt-1 text-[12px] text-ink-2">Plan #{plan.id} · {plan.twin_name} · {plan.method} · {res.candidates_evaluated ?? 0} candidates propagated · {fmt(res.runtime_s, 1)} s</div>
          </div>
          <div className="flex flex-wrap gap-2">
            {can("simulation:run") && res.initial_state && <button className="btn" onClick={() => nav(`/simulation?plan=${plan.id}`)}><Radar size={13} /> Simulation lab</button>}
            {can("simulation:run") && sel && <button className="btn" onClick={() => nav(`/scenario?plan=${plan.id}`)}><Clapperboard size={13} /> Guided replay</button>}
            {can("reports:read") && <a className="btn" href={`/api/v1/reports/${plan.id}`} target="_blank" rel="noreferrer"><FileText size={13} /> Report</a>}
            {sel && can("twin:manage") && !plan.applied_at && <button className="btn" onClick={book}><Fuel size={13} /> Book fuel</button>}
          </div>
        </div>
        {booked && <p className="mt-2 text-[11.5px] text-ok">{booked}</p>}
        <ul className="mt-3 space-y-1 text-[12.5px] text-ink">
          {(res.explanation ?? [res.message ?? ""]).map((x, i) => <li key={i} className="flex gap-2"><span className="text-cyan">›</span>{x}</li>)}
        </ul>
      </div>

      <Panel title="Miss distance: no burn → with burn" subtitle="Log scale. Red band: below the safety distance" accent="var(--color-ok)">
        <MissDumbbell
          dMinKm={res.config.d_min_km ?? 0.2}
          rows={res.nominal.per_threat.map((b, i) => ({ name: b.threat, before: b.miss_km, after: sel?.per_threat[i]?.miss_km ?? null }))}
        />
      </Panel>

      <Panel title="Threats: before → after" subtitle="Deterministic closest approach in the optimisation model; Pc uses the ASSUMED covariance" bodyClassName="p-0 overflow-x-auto">
        <table className="w-full min-w-[720px] text-[12px]">
          <thead><tr className="border-b border-line-2 text-left text-[10px] uppercase tracking-wider text-muted">
            <th className="px-3 py-2 font-semibold">Object</th><th className="px-2 font-semibold">TCA</th><th className="px-2 text-right font-semibold">Miss before</th><th className="px-2 text-right font-semibold">Pc before</th>
            <th className="px-2 text-right font-semibold">Miss after</th><th className="px-2 text-right font-semibold">Pc after</th><th className="px-3 font-semibold">Source</th></tr></thead>
          <tbody>
            {res.nominal.per_threat.map((b, i) => {
              const a = sel?.per_threat[i];
              const th = res.threats[i];
              return (
                <tr key={b.threat} className="border-b border-line-2/70">
                  <td className="px-3 py-2 text-ink">{b.threat}</td>
                  <td className="num px-2 text-[11px] text-ink-2">{utc(b.tca).slice(5, 19)}</td>
                  <td className="num px-2 text-right text-danger">{fmt(b.miss_km * 1000, 0)} m</td>
                  <td className="num px-2 text-right">{fmtPc(b.pc)}</td>
                  <td className={`num px-2 text-right ${a ? "text-ok" : "text-muted"}`}>{a ? `${fmt(a.miss_km * 1000, 0)} m` : "—"}</td>
                  <td className="num px-2 text-right">{a ? fmtPc(a.pc) : "—"}</td>
                  <td className="px-3 text-[10.5px] text-muted">{th?.kind === "synthetic" ? <SimBadge>SYNTHETIC</SimBadge> : `NORAD ${th?.norad_id} (SGP4)`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      {sel && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Panel title="Selected maneuver" accent="#A78BFA">
            <div className="mb-2 flex items-center gap-3">
              <DvVector rtn={sel.dv_rtn_ms} />
              <div>
                <div className="label-caps">|Δv|</div>
                <div className="num text-[26px] leading-tight text-ink">{fmt(sel.dv_ms * 1000, 1)}<span className="ml-1 text-[12px] text-ink-2">mm/s</span></div>
                <div className="text-[10.5px] text-muted">direction in the RTN frame</div>
              </div>
            </div>
            <KV k="Time">{utc(sel.t_m)}</KV>
            <KV k="|Δv|"><span className="num text-ok">{mm(sel.dv_ms)}</span></KV>
            <KV k="Δv R / T / N"><span className="num">{sel.dv_rtn_ms.map((x) => (x * 1000).toFixed(1)).join(" / ")} mm/s</span></KV>
            <KV k="Propellant"><span className="num">{fmt(sel.propellant_kg * 1000, 1)} g</span></KV>
            <KV k="Burn duration"><span className="num">{fmt(sel.burn_s, 1)} s</span></KV>
            <KV k="Δa / Δe / Δi"><span className="num">{fmt(sel.da_km * 1000, 0)} m / {sel.de.toExponential(1)} / {fmt(sel.di_deg, 5)}°</span></KV>
            <KV k="Δ nodal rate"><span className="num">{fmt(sel.raan_rate_change_deg_day, 5)} °/day</span></KV>
          </Panel>
          <Panel title="Objective J = Σ wᵢ·termᵢ" subtitle={`weights ${res.config.weights.join(" · ")}`}>
            {(["R", "F", "M", "U"] as const).map((k, i) => {
              const v = sel.terms[k];
              return (
                <div key={k} className="mb-2">
                  <div className="flex justify-between text-[11.5px]"><span className="text-ink-2">{["Residual risk", "Fuel", "Mission disruption", "Robustness (MC)"][i]}</span><span className="num text-ink">{v === null ? "not run" : fmt(v, 4)}</span></div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded bg-hover"><div className="h-full bg-cyan" style={{ width: `${Math.min(100, (v ?? 0) * 100)}%` }} /></div>
                </div>
              );
            })}
            <div className="mt-3 flex justify-between border-t border-line-2 pt-2 text-[12px]"><span className="text-ink-2">J</span><span className="num text-ink">{fmt(sel.J, 4)}</span></div>
          </Panel>
          <Panel title="Robustness" subtitle="Monte Carlo under ASSUMED errors">
            {res.monte_carlo?.selected ? (
              <>
                <KV k="P(any threat < min miss), before"><span className="num text-danger">{(res.monte_carlo.nominal.p_violation * 100).toFixed(1)}%</span></KV>
                <KV k="… after"><span className="num text-ok">{(res.monte_carlo.selected.p_violation * 100).toFixed(1)}%</span></KV>
                <KV k="95% interval"><span className="num">{res.monte_carlo.selected.p_violation_ci95.map((x: number) => (x * 100).toFixed(1)).join("–")}%</span></KV>
                <KV k="Worst miss p5 / p50"><span className="num">{fmt(res.monte_carlo.selected.worst_miss_km_percentiles.p5 * 1000, 0)} / {fmt(res.monte_carlo.selected.worst_miss_km_percentiles.p50 * 1000, 0)} m</span></KV>
                <KV k="Samples"><span className="num">{res.monte_carlo.selected.samples}</span></KV>
              </>
            ) : <p className="text-[12px] text-ink-2">Not run for the {plan.method} method.</p>}
          </Panel>
        </div>
      )}

      {val && (
        <Panel title="Independent validation" subtitle={val.method}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
            <table className="w-full text-[12px]">
              <thead><tr className="text-left text-[10px] uppercase tracking-wider text-muted"><th className="py-1 font-semibold">Threat</th><th className="text-right font-semibold">Miss before</th><th className="text-right font-semibold">Miss after</th><th className="text-right font-semibold">Pc after</th><th className="text-right font-semibold">Result</th></tr></thead>
              <tbody>{val.threats.map((v: { threat: string; miss_before_km: number; miss_after_km: number; pc_after: number; pass: boolean }) => (
                <tr key={v.threat} className="border-t border-line-2/70"><td className="py-1.5 text-ink">{v.threat}</td><td className="num text-right">{fmt(v.miss_before_km * 1000, 0)} m</td><td className="num text-right">{fmt(v.miss_after_km * 1000, 0)} m</td><td className="num text-right">{fmtPc(v.pc_after)}</td>
                  <td className={`text-right font-semibold ${v.pass ? "text-ok" : "text-danger"}`}>{v.pass ? "PASS" : "FAIL"}</td></tr>
              ))}</tbody>
            </table>
            <div className="text-[11.5px]">
              {Object.entries(val.constraints).map(([k, ok]) => <KV key={k} k={k.replace(/_/g, " ")}><span className={ok ? "text-ok" : "text-danger"}>{ok ? "ok" : "violated"}</span></KV>)}
              <KV k="Catalogue objects re-screened"><span className="num">{val.catalogue_objects_screened}</span></KV>
              <KV k="New / closer conjunctions"><span className={`num ${val.new_or_closer_conjunctions.length ? "text-warn" : ""}`}>{val.new_or_closer_conjunctions.length}</span></KV>
              <KV k="Finite burn"><span className="num">{fmt(val.burn_duration_s, 1)} s</span></KV>
            </div>
          </div>
        </Panel>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Panel title="Why candidates were rejected">
          {rej.length === 0 ? <EmptyState title="No rejections recorded" /> : (
            <div className="h-[220px]">
              <ResponsiveContainer>
                <BarChart data={rej} layout="vertical" margin={{ left: 8, right: 12 }}>
                  <CartesianGrid stroke="#1A2639" horizontal={false} />
                  <XAxis type="number" tick={{ fill: "#64748B", fontSize: 10 }} />
                  <YAxis type="category" dataKey="reason" width={150} tick={{ fill: "#9AAAC0", fontSize: 10 }} />
                  <Tooltip contentStyle={tip} />
                  <Bar dataKey="count" fill="#FF647C" isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="mt-2 space-y-1 text-[11px] text-ink-2">
            {res.stages.map((s, i) => <div key={i} className="num">{s.stage}: {s.candidates ?? ""} {s.feasible !== undefined ? `· ${s.feasible} feasible` : ""}{s.robust !== undefined ? `· ${s.robust} robust` : ""}{s.steps ? `· ${s.steps.map((x: { factor: number; result: string }) => `×${x.factor} ${x.result.split(" ")[0]}`).join(", ")}` : ""}</div>)}
          </div>
        </Panel>
        <Panel title="Best candidates" subtitle="Ranked by feasibility, then objective J" bodyClassName="p-0 overflow-x-auto max-h-[340px]">
          <CandTable rows={res.top_candidates ?? res.shortlist ?? []} />
        </Panel>
      </div>
      <p className="text-[10.5px] text-muted">
        Optimisation model: {res.config.force.join(", ")}; validation: {res.config.validation_force.join(", ")}. Initial state: {res.initial_state?.source}.
        {res.threats.some((t) => t.kind === "catalog") && (
          <> Threat objects can be inspected on <Link to="/environment" className="text-cyan hover:underline" onClick={() => { const c = res.threats.find((t) => t.kind === "catalog"); if (c?.norad_id) select(c.norad_id); }}>Space Environment</Link>.</>
        )}
      </p>
    </div>
  );
}

function CandTable({ rows }: { rows: Candidate[] }) {
  return (
    <table className="w-full min-w-[720px] text-[11.5px]">
      <thead className="sticky top-0 bg-panel"><tr className="border-b border-line-2 text-left text-[10px] uppercase tracking-wider text-muted">
        <th className="px-3 py-2 font-semibold">Time</th><th className="px-2 font-semibold">Δv R/T/N (mm/s)</th><th className="px-2 text-right font-semibold">|Δv|</th><th className="px-2 text-right font-semibold">Worst miss</th><th className="px-2 text-right font-semibold">J</th><th className="px-3 font-semibold">Status</th></tr></thead>
      <tbody>
        {rows.map((c, i) => (
          <tr key={i} className="border-b border-line-2/60">
            <td className="num px-3 py-1.5 text-ink-2">{c.t_m ? utc(c.t_m).slice(11, 19) : "—"}</td>
            <td className="num px-2">{c.dv_rtn_ms.map((x) => (x * 1000).toFixed(1)).join(" / ")}</td>
            <td className="num px-2 text-right">{fmt(c.dv_ms * 1000, 1)}</td>
            <td className="num px-2 text-right">{fmt(Math.min(...c.per_threat.map((p) => p.miss_km)) * 1000, 0)} m</td>
            <td className="num px-2 text-right">{fmt(c.J, 4)}</td>
            <td className="px-3">{c.feasible ? <span className="text-ok">feasible</span> : <span className="text-danger" title={c.reasons.join("; ")}>{c.reasons[0]}</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
