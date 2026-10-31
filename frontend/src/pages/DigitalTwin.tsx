import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Box, Fuel, Gauge, Loader2, Play, Plus, Rocket, Save } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState, ErrorState, KV, LoadingState, MetricCard, PageHeader, Panel } from "../components/ui";
import { Modal, Tabs } from "../components/Tabs";
import { Notice } from "../components/auth/AuthLayout";
import { api, ApiError } from "../services/api";
import { useAsync } from "../services/useAsync";
import { simTimeISO } from "../stores/app";
import { useCan } from "../stores/auth";
import { fmt, utc } from "../lib/format";
import type { CatalogItem } from "../types/proximity";
import type { SpacecraftConfig, Twin } from "../types/mission";
import { FuelGauge } from "../components/viz/FuelGauge";
import { OrbitLoader } from "../components/ui";

const SpacecraftModel = lazy(() => import("../components/viz/SpacecraftModel").then((m) => ({ default: m.SpacecraftModel })));

export const tip = { background: "#121D30", border: "1px solid #223149", borderRadius: 8, fontSize: 11 };
const DIRS = ["+R", "-R", "+T", "-T", "+N", "-N"];

export function SimBadge({ children = "SIMULATED" }: { children?: React.ReactNode }) {
  return <span className="rounded bg-warn/15 px-1.5 py-px text-[10px] font-semibold tracking-wider text-warn">{children}</span>;
}

export function DigitalTwin() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const twins = useAsync(() => api.twins(), []);
  const [creating, setCreating] = useState(false);
  const selId = Number(params.get("twin")) || twins.data?.[0]?.id || null;
  const select = (id: number) => setParams((p) => { p.set("twin", String(id)); return p; }, { replace: true });

  return (
    <div>
      <PageHeader
        eyebrow="Simulation"
        title="SATELLITE DIGITAL TWIN"
        subtitle="Configurable simulated spacecraft: structure, propulsion, fuel, attitude and mission limits, propagated numerically."
        actions={can("twin:manage") ? <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={13} /> New twin</button> : undefined}
      />
      <div className="mb-4 rounded-lg border border-warn/30 bg-warn/[0.05] px-3 py-2 text-[12px] text-ink-2">
        <SimBadge /> A twin is a simulated copy of a satellite. Public orbital data has no mass, thruster or fuel information, so those values are
        <b className="text-ink"> configured by you</b>. Nothing here changes the real catalogue record.
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <Panel title="Twins" bodyClassName="p-2">
          {twins.error ? <ErrorState message={twins.error} /> : !twins.data ? <LoadingState /> : twins.data.length === 0 ? (
            <EmptyState title="No digital twins yet" icon={<Box size={18} />}>{can("twin:manage") ? "Create one from a catalogue satellite or from orbital elements." : "Your role can view twins created in your organisation."}</EmptyState>
          ) : (
            <ul className="space-y-1.5">
              {twins.data.map((t) => {
                const f = t.config.fuel;
                const pct = f.propellant_initial_kg > 0 ? (100 * f.propellant_remaining_kg) / f.propellant_initial_kg : 0;
                return (
                  <li key={t.id}>
                    <button onClick={() => select(t.id)} className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${t.id === selId ? "border-cyan/50 bg-cyan/[0.06]" : "border-line-2 hover:bg-hover"}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[12.5px] font-medium text-ink">{t.name}</span>
                        <span className="num text-[10px] text-muted">#{t.id}</span>
                      </div>
                      <div className="mt-0.5 truncate text-[10.5px] text-muted">{t.source_norad_id ? `from NORAD ${t.source_norad_id} ${t.source_name ?? ""}` : "user-defined orbit"}</div>
                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded bg-hover"><div className="h-full bg-ok" style={{ width: `${pct}%` }} /></div>
                        <span className="num text-[10px] text-ink-2">{fmt(t.summary.dv_available_ms, 1)} m/s</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        {selId ? <TwinDetail id={selId} onChange={twins.reload} /> : <Panel><EmptyState title="Select or create a twin" /></Panel>}
      </div>
      {creating && <CreateTwin onClose={() => setCreating(false)} onCreated={(t) => { setCreating(false); twins.reload(); select(t.id); }} />}
    </div>
  );
}

function TwinDetail({ id, onChange }: { id: number; onChange: () => void }) {
  const can = useCan();
  const tw = useAsync(() => api.twin(id), [id]);
  if (tw.error) return <Panel><ErrorState message={tw.error} /></Panel>;
  if (!tw.data) return <Panel><LoadingState /></Panel>;
  const t = tw.data;
  const s = t.summary;
  return (
    <div className="min-w-0">
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Wet mass" value={fmt(s.wet_mass_kg, 1)} unit="kg" icon={<Box size={15} />} hint={`dry ${fmt(t.config.structure.dry_mass_kg, 0)} kg`} />
        <MetricCard label="Δv available" value={fmt(s.dv_available_ms, 2)} unit="m/s" accent="var(--color-ok)" icon={<Rocket size={15} />} hint={`usable ${fmt(s.usable_propellant_kg, 2)} kg (reserve excluded)`} />
        <MetricCard label="Max single burn" value={fmt(s.max_single_burn_dv_ms * 1000, 0)} unit="mm/s" accent="var(--color-cyan)" icon={<Gauge size={15} />} hint={`10 cm/s = ${fmt(s.burn_s_per_10_cm_s, 1)} s burn`} />
        <MetricCard label="Propellant left" value={fmt(t.config.fuel.propellant_remaining_kg, 2)} unit="kg" accent="var(--color-warn)" icon={<Fuel size={15} />} hint="SIMULATED bookkeeping" />
      </div>
      {s.validation_errors.length > 0 && <Notice kind="error">{s.validation_errors.join("; ")}</Notice>}
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Panel title={<>Spacecraft <SimBadge>SCHEMATIC</SimBadge></>} subtitle="Drag to rotate · scroll to zoom" bodyClassName="p-0" accent="#A78BFA">
          <div className="relative h-[300px] overflow-hidden rounded-b-xl bg-[radial-gradient(70%_80%_at_50%_45%,#0f1d33,#070B14)]">
            <Suspense fallback={<div className="flex h-full items-center justify-center"><OrbitLoader size={24} /></div>}>
              <SpacecraftModel config={t.config} />
            </Suspense>
            <div className="pointer-events-none absolute bottom-2 left-3 flex gap-3 text-[10px] text-ink-2">
              <span><span className="text-blue">R</span> radial</span>
              <span><span className="text-violet">T</span> along-track</span>
              <span><span className="text-ok">N</span> orbit normal</span>
              <span className="text-muted">faint arrows: directions not allowed</span>
            </div>
          </div>
        </Panel>
        <Panel title="Propellant & Δv budget" accent="var(--color-ok)">
          <FuelGauge
            initialKg={t.config.fuel.propellant_initial_kg}
            remainingKg={t.config.fuel.propellant_remaining_kg}
            reserveKg={t.config.fuel.reserve_kg}
            dvAvailableMs={s.dv_available_ms}
          />
          <div className="mt-4 grid grid-cols-2 gap-x-4">
            <KV k="Thruster"><span className="text-ink">{t.config.propulsion.kind}</span></KV>
            <KV k="Thrust · Isp"><span className="num">{fmt(t.config.propulsion.thrust_n, 2)} N · {fmt(t.config.propulsion.isp_s, 0)} s</span></KV>
            <KV k="C_D·A/m"><span className="num">{fmt(s.ballistic_coefficient_m2_kg, 4)} m²/kg</span></KV>
            <KV k="Area / mass"><span className="num">{fmt(s.area_to_mass_m2_kg, 4)} m²/kg</span></KV>
            <KV k="Per 10 cm/s"><span className="num">{fmt(s.propellant_g_per_10_cm_s, 1)} g · {fmt(s.burn_s_per_10_cm_s, 1)} s</span></KV>
            <KV k="Allowed burns"><span className="num">{t.config.attitude.allowed_directions.join(" ")}</span></KV>
          </div>
          <p className="mt-3 text-[10.5px] leading-relaxed text-muted">Δv = I<sub>sp</sub> g₀ ln(m₀/m_f) on the usable propellant (reserve excluded). Values are configured, not measured.</p>
        </Panel>
      </div>
      <Tabs
        tabs={[
          { id: "config", label: "Configuration", content: <ConfigEditor twin={t} editable={can("twin:manage")} onSaved={() => { tw.reload(); onChange(); }} /> },
          { id: "orbit", label: "Orbit & propagation", content: <OrbitTab twin={t} /> },
          {
            id: "history",
            label: "Plans & fuel log",
            content: (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Panel title="Maneuver plans" bodyClassName="p-0">
                  {!t.plans?.length ? <EmptyState title="No plans yet"><Link to={`/maneuvers?twin=${t.id}`} className="text-cyan hover:underline">Plan a maneuver →</Link></EmptyState> : (
                    <ul className="divide-y divide-line-2">
                      {t.plans.map((p) => (
                        <li key={p.id} className="flex items-center justify-between px-4 py-2 text-[12px]">
                          <Link to={`/maneuvers?plan=${p.id}`} className="text-cyan hover:underline">Plan #{p.id}</Link>
                          <span className="text-ink-2">{p.method}</span>
                          <span className="text-ink">{p.result_status ?? p.status}</span>
                          <span className="num text-[10.5px] text-muted">{utc(p.created_at, false)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
                <Panel title="Simulated fuel log" bodyClassName="p-0">
                  {!t.fuel_log.length ? <EmptyState title="No maneuvers booked" /> : (
                    <ul className="divide-y divide-line-2">
                      {t.fuel_log.map((f, i) => (
                        <li key={i} className="num flex justify-between px-4 py-2 text-[11.5px]">
                          <span>plan #{f.plan_id}</span><span>{fmt(f.dv_ms * 1000, 1)} mm/s</span><span>−{fmt(f.propellant_kg * 1000, 1)} g</span><span className="text-ink-2">left {fmt(f.remaining_kg, 3)} kg</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

// ------------------------------------------------------------------ config
function Num({ label, value, onChange, step = "any", unit, disabled }: { label: string; value: number; onChange: (v: number) => void; step?: string; unit?: string; disabled?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-ink-2">{label}{unit && <span className="text-muted"> ({unit})</span>}</span>
      <input type="number" step={step} className="input num w-full" value={Number.isFinite(value) ? value : ""} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function ConfigEditor({ twin, editable, onSaved }: { twin: Twin; editable: boolean; onSaved: () => void }) {
  const [c, setC] = useState<SpacecraftConfig>(twin.config);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const presets = useAsync(() => api.twinPresets(), []);
  useEffect(() => setC(twin.config), [twin]);
  const set = <K extends keyof SpacecraftConfig>(k: K, field: string, v: unknown) => setC((x) => ({ ...x, [k]: { ...(x[k] as object), [field]: v } }));
  const dirty = JSON.stringify(c) !== JSON.stringify(twin.config);
  const save = async () => {
    try {
      await api.updateTwin(twin.id, { config: c });
      setMsg({ kind: "ok", text: "Saved. New values apply to the next propagation and plan." });
      onSaved();
    } catch (e) {
      setMsg({ kind: "error", text: (e as ApiError).message });
    }
  };
  const d = !editable;
  return (
    <div>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        <Panel title="Structure">
          <div className="grid grid-cols-2 gap-2.5">
            <Num label="Dry mass" unit="kg" value={c.structure.dry_mass_kg} onChange={(v) => set("structure", "dry_mass_kg", v)} disabled={d} />
            <Num label="Reference area" unit="m²" value={c.structure.area_m2} onChange={(v) => set("structure", "area_m2", v)} disabled={d} />
            <Num label="Drag coefficient Cd" value={c.structure.cd} onChange={(v) => set("structure", "cd", v)} disabled={d} />
            <Num label="Reflectivity Cr" value={c.structure.cr} onChange={(v) => set("structure", "cr", v)} disabled={d} />
          </div>
        </Panel>
        <Panel title="Propulsion" actions={editable && presets.data ? (
          <select className="input h-7" value="" onChange={(e) => { const p = presets.data!.propulsion.find((x) => x.key === e.target.value); if (p) setC((x) => ({ ...x, propulsion: { kind: p.name, thrust_n: p.thrust_n, isp_s: p.isp_s, max_burn_s: p.max_burn_s, max_dv_per_burn_ms: p.max_dv_per_burn_ms, min_impulse_dv_ms: p.min_impulse_dv_ms, power_w: p.power_w } })); }} aria-label="Propulsion template">
            <option value="">Load template…</option>
            {presets.data.propulsion.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
          </select>
        ) : undefined}>
          <label className="mb-2.5 block"><span className="mb-1 block text-[11px] text-ink-2">Type</span><input className="input w-full" value={c.propulsion.kind} disabled={d} onChange={(e) => set("propulsion", "kind", e.target.value)} /></label>
          <div className="grid grid-cols-2 gap-2.5">
            <Num label="Thrust" unit="N" value={c.propulsion.thrust_n} onChange={(v) => set("propulsion", "thrust_n", v)} disabled={d} />
            <Num label="Specific impulse" unit="s" value={c.propulsion.isp_s} onChange={(v) => set("propulsion", "isp_s", v)} disabled={d} />
            <Num label="Max burn duration" unit="s" value={c.propulsion.max_burn_s} onChange={(v) => set("propulsion", "max_burn_s", v)} disabled={d} />
            <Num label="Max Δv per burn" unit="m/s" value={c.propulsion.max_dv_per_burn_ms} onChange={(v) => set("propulsion", "max_dv_per_burn_ms", v)} disabled={d} />
            <Num label="Min impulse Δv" unit="m/s" value={c.propulsion.min_impulse_dv_ms} onChange={(v) => set("propulsion", "min_impulse_dv_ms", v)} disabled={d} />
            <Num label="Thruster power" unit="W" value={c.propulsion.power_w} onChange={(v) => set("propulsion", "power_w", v)} disabled={d} />
          </div>
        </Panel>
        <Panel title="Fuel" subtitle="Δv = Isp·g₀·ln(m₀/m_f)">
          <div className="grid grid-cols-2 gap-2.5">
            <Num label="Initial propellant" unit="kg" value={c.fuel.propellant_initial_kg} onChange={(v) => set("fuel", "propellant_initial_kg", v)} disabled={d} />
            <Num label="Remaining (simulated)" unit="kg" value={c.fuel.propellant_remaining_kg} onChange={(v) => set("fuel", "propellant_remaining_kg", v)} disabled={d} />
            <Num label="Reserve (not for avoidance)" unit="kg" value={c.fuel.reserve_kg} onChange={(v) => set("fuel", "reserve_kg", v)} disabled={d} />
          </div>
        </Panel>
        <Panel title="Attitude & execution">
          <div className="mb-2.5">
            <span className="mb-1 block text-[11px] text-ink-2">Allowed burn directions (RTN)</span>
            <div className="flex flex-wrap gap-1.5">
              {DIRS.map((x) => {
                const on = c.attitude.allowed_directions.includes(x);
                return (
                  <button key={x} disabled={d} className={`num h-7 rounded-md border px-2.5 text-[11.5px] ${on ? "border-cyan/60 bg-cyan/10 text-cyan" : "border-line-2 text-muted"}`}
                    onClick={() => set("attitude", "allowed_directions", on ? c.attitude.allowed_directions.filter((y) => y !== x) : [...c.attitude.allowed_directions, x])}>{x}</button>
                );
              })}
            </div>
            <p className="mt-1 text-[10.5px] text-muted">R radial · T along-track · N cross-track</p>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Num label="Pointing error 1σ" unit="deg" value={c.attitude.pointing_accuracy_deg} onChange={(v) => set("attitude", "pointing_accuracy_deg", v)} disabled={d} />
            <Num label="Magnitude error 1σ" unit="fraction" value={c.attitude.magnitude_error_frac} onChange={(v) => set("attitude", "magnitude_error_frac", v)} disabled={d} />
            <Num label="Earliest burn after now" unit="s" value={c.attitude.min_lead_time_s} onChange={(v) => set("attitude", "min_lead_time_s", v)} disabled={d} />
            <Num label="Latest burn before 1st TCA" unit="s" value={c.attitude.min_time_before_tca_s} onChange={(v) => set("attitude", "min_time_before_tca_s", v)} disabled={d} />
          </div>
        </Panel>
        <Panel title="Mission constraints">
          <div className="grid grid-cols-2 gap-2.5">
            <Num label="Altitude min" unit="km" value={c.mission.alt_min_km} onChange={(v) => set("mission", "alt_min_km", v)} disabled={d} />
            <Num label="Altitude max" unit="km" value={c.mission.alt_max_km} onChange={(v) => set("mission", "alt_max_km", v)} disabled={d} />
            <Num label="Inclination min" unit="deg" value={c.mission.inc_min_deg} onChange={(v) => set("mission", "inc_min_deg", v)} disabled={d} />
            <Num label="Inclination max" unit="deg" value={c.mission.inc_max_deg} onChange={(v) => set("mission", "inc_max_deg", v)} disabled={d} />
            <Num label="Max eccentricity" value={c.mission.ecc_max} onChange={(v) => set("mission", "ecc_max", v)} disabled={d} />
            <Num label="SSO nodal-rate tolerance" unit="°/day" value={c.mission.sso_rate_tol_deg_day} onChange={(v) => set("mission", "sso_rate_tol_deg_day", v)} disabled={d} />
          </div>
          <label className="mt-2.5 flex items-center gap-2 text-[12px] text-ink">
            <input type="checkbox" className="accent-cyan" checked={c.mission.preserve_sso} disabled={d} onChange={(e) => set("mission", "preserve_sso", e.target.checked)} />
            Preserve Sun-synchronous nodal rate
          </label>
        </Panel>
        <Panel title="Power & operations">
          <div className="grid grid-cols-2 gap-2.5">
            <Num label="Available power" unit="W" value={c.power.available_power_w} onChange={(v) => set("power", "available_power_w", v)} disabled={d} />
            <Num label="Max burns per orbit" value={c.power.max_burns_per_orbit} step="1" onChange={(v) => set("power", "max_burns_per_orbit", v)} disabled={d} />
          </div>
          <p className="mt-2 text-[10.5px] text-muted">A thruster that needs more power than is available can't fire; the twin is flagged invalid.</p>
        </Panel>
      </div>
      {editable && (
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn" disabled={!dirty} onClick={() => setC(twin.config)}>Discard</button>
          <button className="btn btn-primary" disabled={!dirty} onClick={save}><Save size={13} /> Save configuration</button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ orbit
const FORCES: [string, string][] = [["j2", "J2"], ["j3", "J3"], ["j4", "J4"], ["drag", "Drag"], ["sun", "Sun"], ["moon", "Moon"], ["srp", "SRP"]];

function OrbitTab({ twin }: { twin: Twin }) {
  const [force, setForce] = useState<Record<string, boolean>>({ j2: true, j3: true, j4: true, drag: true, sun: true, moon: true, srp: true });
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setRes(await api.propagateTwin(twin.id, { start: twin.epoch, horizon_h: hours, step_s: 300, force }));
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const data = useMemo(
    () => (res ? res.t_h.map((t: number, i: number) => ({ t, alt: res.alt_km[i], diff: res.sgp4_comparison?.position_difference_km?.[i] ?? null })) : []),
    [res],
  );
  const o = twin.osculating_elements;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
      <Panel title="Initial state" subtitle={utc(twin.epoch)}>
        <KV k="Source">{twin.source_norad_id ? `NORAD ${twin.source_norad_id}` : "user elements"}</KV>
        <p className="mb-2 text-[10.5px] leading-relaxed text-muted">{twin.state_source}</p>
        <KV k="a"><span className="num">{fmt(o.a_km, 3)} km</span></KV>
        <KV k="e"><span className="num">{fmt(o.e, 6)}</span></KV>
        <KV k="i"><span className="num">{fmt(o.i_deg, 4)}°</span></KV>
        <KV k="RAAN"><span className="num">{fmt(o.raan_deg, 3)}°</span></KV>
        <KV k="Perigee / apogee alt"><span className="num">{fmt(o.perigee_alt_km, 1)} / {fmt(o.apogee_alt_km, 1)} km</span></KV>
        <KV k="r (TEME)"><span className="num text-[10.5px]">{twin.state_teme.r_km.map((x) => x.toFixed(3)).join(", ")}</span></KV>
        <KV k="v (TEME)"><span className="num text-[10.5px]">{twin.state_teme.v_kms.map((x) => x.toFixed(6)).join(", ")}</span></KV>
        <p className="mt-2 text-[10.5px] text-muted">Osculating elements of the Cartesian state (EGM-96 μ), not TLE mean elements.</p>
      </Panel>
      <Panel title="Numerical propagation" subtitle="Cowell, DOP853 · force model below" actions={
        <button className="btn btn-primary h-7" onClick={run} disabled={busy}>{busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Propagate</button>
      }>
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {FORCES.map(([k, l]) => (
            <button key={k} onClick={() => setForce((f) => ({ ...f, [k]: !f[k] }))} className={`h-7 rounded-md border px-2.5 text-[11.5px] ${force[k] ? "border-cyan/60 bg-cyan/10 text-cyan" : "border-line-2 text-muted"}`}>{l}</button>
          ))}
          <select className="input ml-auto h-7" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Horizon">
            {[6, 12, 24, 48, 72].map((h) => <option key={h} value={h}>{h} h</option>)}
          </select>
        </div>
        {err && <Notice kind="error">{err}</Notice>}
        {!res ? <EmptyState title="Run a propagation">Altitude over time and, for catalogue-based twins, the difference from SGP4 of the source object.</EmptyState> : (
          <>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Chart title="Altitude (km, spherical)" data={data} k="alt" color="#36D6E8" />
              {res.sgp4_comparison ? <Chart title="|numerical − SGP4| (km)" data={data} k="diff" color="#F5B942" /> : <EmptyState title="No SGP4 reference (elements-defined twin)" />}
            </div>
            <div className="mt-3 grid grid-cols-1 gap-x-6 text-[11.5px] sm:grid-cols-2">
              <KV k="RHS evaluations"><span className="num">{res.stats.rhs_evaluations}</span></KV>
              <KV k="Runtime"><span className="num">{fmt(res.stats.runtime_s, 2)} s</span></KV>
              <KV k="rtol"><span className="num">{res.stats.rtol}</span></KV>
              {res.sgp4_comparison && <KV k="Max |Δr| vs SGP4"><span className="num">{fmt(res.sgp4_comparison.max_km, 3)} km</span></KV>}
            </div>
            <p className="mt-2 text-[10.5px] text-muted">{res.force_model.join(" · ")}. {res.sgp4_comparison?.note}</p>
          </>
        )}
      </Panel>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function Chart({ title, data, k, color }: { title: string; data: any[]; k: string; color: string }) {
  return (
    <div>
      <div className="label-caps mb-1">{title}</div>
      <div className="h-[200px] rounded-lg border border-line-2 bg-app p-2">
        <ResponsiveContainer>
          <LineChart data={data} margin={{ left: 0, right: 10, top: 6 }}>
            <CartesianGrid stroke="#1A2639" />
            <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tick={{ fill: "#64748B", fontSize: 10 }} tickFormatter={(v) => `${v}h`} />
            <YAxis tick={{ fill: "#64748B", fontSize: 10 }} width={52} domain={["auto", "auto"]} tickFormatter={(v) => Number(v).toFixed(1)} />
            <Tooltip contentStyle={tip} formatter={(v) => [Number(v).toFixed(3), title]} labelFormatter={(t) => `t = ${Number(t).toFixed(2)} h`} />
            <Line dataKey={k} stroke={color} dot={false} isAnimationActive={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ create
function CreateTwin({ onClose, onCreated }: { onClose: () => void; onCreated: (t: Twin) => void }) {
  const [name, setName] = useState("");
  const [source, setSource] = useState<"catalog" | "elements">("catalog");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CatalogItem[]>([]);
  const [pick, setPick] = useState<CatalogItem | null>(null);
  const [el, setEl] = useState({ alt_km: 700, ecc: 0.001, inc_deg: 98.19, raan_deg: 0, argp_deg: 0, nu_deg: 0 });
  const [preset, setPreset] = useState("monoprop");
  const [useSim, setUseSim] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const presets = useAsync(() => api.twinPresets(), []);
  useEffect(() => {
    if (q.trim().length < 2) return setHits([]);
    const t = setTimeout(() => api.search({ q, limit: 8 }).then((r) => setHits(r.items)).catch(() => setHits([])), 200);
    return () => clearTimeout(t);
  }, [q]);
  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = { name: name.trim(), source, norad_id: pick?.norad_id, epoch: useSim ? simTimeISO() : new Date().toISOString(), propulsion_preset: preset, ...(source === "elements" ? el : {}) };
      onCreated(await api.createTwin(body));
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="New digital twin" onClose={onClose} width={560}>
      {err && <Notice kind="error">{err}</Notice>}
      <label className="mb-3 block"><span className="mb-1 block text-[11px] text-ink-2">Name</span><input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cartosat-3 twin" /></label>
      <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg border border-line-2 p-1">
        {(["catalog", "elements"] as const).map((s) => (
          <button key={s} onClick={() => setSource(s)} className={`rounded-md py-1.5 text-[12px] ${source === s ? "bg-elevated text-ink" : "text-ink-2"}`}>{s === "catalog" ? "From a catalogue satellite" : "From orbital elements"}</button>
        ))}
      </div>
      {source === "catalog" ? (
        <div className="mb-3">
          {pick ? (
            <div className="flex items-center justify-between rounded-lg border border-cyan/40 bg-cyan/5 px-3 py-2 text-[12px]">
              <span className="text-ink">{pick.name} <span className="num text-muted">{pick.norad_id}</span></span>
              <button className="text-ink-2 hover:text-ink" onClick={() => setPick(null)}>Change</button>
            </div>
          ) : (
            <>
              <input className="input w-full" placeholder="Search name or NORAD ID" value={q} onChange={(e) => setQ(e.target.value)} />
              {hits.length > 0 && (
                <ul className="mt-1 max-h-[200px] overflow-y-auto rounded-lg border border-line-2">
                  {hits.map((h) => (
                    <li key={h.norad_id}><button className="flex w-full justify-between px-3 py-1.5 text-left text-[12px] hover:bg-hover" onClick={() => { setPick(h); if (!name) setName(`${h.name ?? h.norad_id} twin`); }}>
                      <span className="text-ink">{h.name}</span><span className="num text-muted">{h.norad_id}</span>
                    </button></li>
                  ))}
                </ul>
              )}
            </>
          )}
          <p className="mt-1.5 text-[10.5px] text-muted">The initial state is the SGP4 position and velocity of this object at the chosen time. Operators can only pick satellites assigned to them.</p>
        </div>
      ) : (
        <div className="mb-3 grid grid-cols-3 gap-2">
          <Num label="Perigee alt" unit="km" value={el.alt_km} onChange={(v) => setEl({ ...el, alt_km: v })} />
          <Num label="Eccentricity" value={el.ecc} onChange={(v) => setEl({ ...el, ecc: v })} />
          <Num label="Inclination" unit="deg" value={el.inc_deg} onChange={(v) => setEl({ ...el, inc_deg: v })} />
          <Num label="RAAN" unit="deg" value={el.raan_deg} onChange={(v) => setEl({ ...el, raan_deg: v })} />
          <Num label="Arg. perigee" unit="deg" value={el.argp_deg} onChange={(v) => setEl({ ...el, argp_deg: v })} />
          <Num label="True anomaly" unit="deg" value={el.nu_deg} onChange={(v) => setEl({ ...el, nu_deg: v })} />
        </div>
      )}
      <label className="mb-3 block"><span className="mb-1 block text-[11px] text-ink-2">Propulsion template (editable later)</span>
        <select className="input w-full" value={preset} onChange={(e) => setPreset(e.target.value)}>
          {(presets.data?.propulsion ?? []).map((p) => <option key={p.key} value={p.key}>{p.name} · {p.thrust_n} N · Isp {p.isp_s} s</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 text-[12px] text-ink-2"><input type="checkbox" className="accent-cyan" checked={useSim} onChange={(e) => setUseSim(e.target.checked)} /> Epoch = simulation clock (otherwise wall clock)</label>
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || name.trim().length < 2 || (source === "catalog" && !pick)} onClick={create}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Create twin</button>
      </div>
    </Modal>
  );
}

