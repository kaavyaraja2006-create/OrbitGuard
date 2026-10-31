import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Calculator, Play } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { RelativeMotion } from "../components/viz/RelativeMotion";
import { EncounterPlanePlot, ObjectPicker, PriorityBadge, fmtDistance, fmtPc, timeToTca } from "../components/conjunction";
import { EmptyState, ErrorState, KV, LoadingState, PageHeader, Panel, ScientificValue, StatusIndicator } from "../components/ui";
import { api } from "../services/api";
import { useAsync } from "../services/useAsync";
import { simTimeISO, useApp } from "../stores/app";
import type { ConjunctionDetail, ObjectRow, PcAssessment, ScreeningRun } from "../types";
import { utc } from "../lib/format";

const tip = { background: "#121D30", border: "1px solid #223149", fontSize: 11 };

function ScreeningForm({ onStarted }: { onStarted: (id: number) => void }) {
  const [primary, setPrimary] = useState<ObjectRow | null>(null);
  const [horizon, setHorizon] = useState(24);
  const [step, setStep] = useState(60);
  const [threshold, setThreshold] = useState(10);
  const [hbr, setHbr] = useState(20);
  const [useSim, setUseSim] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!primary) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.screen({
        primary_norad_id: primary.norad_id,
        start: useSim ? simTimeISO() : undefined,
        horizon_h: horizon,
        step_s: step,
        threshold_km: threshold,
        hbr_m: hbr,
      });
      onStarted(r.run_id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="New screening" subtitle="One primary against every other catalog object">
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-[11px] text-ink-2">Primary object</span>
          <ObjectPicker value={primary} onChange={setPrimary} />
        </label>
        <div className="grid grid-cols-2 gap-2.5">
          <label>
            <span className="mb-1 block text-[11px] text-ink-2">Horizon</span>
            <select className="input w-full" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
              {[6, 12, 24, 72, 168].map((h) => (
                <option key={h} value={h}>
                  {h < 24 ? `${h} h` : `${h / 24} d`}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[11px] text-ink-2">Grid step</span>
            <select className="input w-full" value={step} onChange={(e) => setStep(Number(e.target.value))}>
              {[30, 60, 120, 300].map((s) => (
                <option key={s} value={s}>
                  {s} s
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[11px] text-ink-2">Report miss ≤ (km)</span>
            <input className="input w-full num" type="number" min={0.1} max={200} step={0.5} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          </label>
          <label>
            <span className="mb-1 block text-[11px] text-ink-2" title="Combined radius of both objects">
              Hard-body radius (m)
            </span>
            <input className="input w-full num" type="number" min={1} max={500} value={hbr} onChange={(e) => setHbr(Number(e.target.value))} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-[11.5px] text-ink-2">
          <input type="checkbox" className="accent-cyan" checked={useSim} onChange={(e) => setUseSim(e.target.checked)} />
          Start at the simulation clock time (default: now)
        </label>
        {err && <p className="rounded-md border border-danger/40 bg-danger/5 p-2 text-[11.5px] text-danger">{err}</p>}
        <button className="btn btn-primary w-full justify-center" disabled={!primary || busy || threshold <= 0 || hbr <= 0} onClick={run}>
          <Play size={13} /> Run screening
        </button>
        <p className="text-[10.5px] leading-relaxed text-muted">
          TLE positions are typically accurate to about 1 km near epoch and degrade over days. Treat sub-kilometre miss distances as a signal to look closer, not as precise predictions.
        </p>
      </div>
    </Panel>
  );
}

function RunList({ runs, selected, onSelect }: { runs: ScreeningRun[]; selected: number | null; onSelect: (id: number) => void }) {
  if (!runs.length) return <EmptyState title="No screenings yet">Choose a primary object and run a screening.</EmptyState>;
  return (
    <ul className="divide-y divide-line-2">
      {runs.map((r) => (
        <li key={r.id}>
          <button onClick={() => onSelect(r.id)} className={`w-full px-4 py-2.5 text-left hover:bg-hover ${selected === r.id ? "bg-elevated" : ""}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[12px] text-ink">
                #{r.id} · {r.primary_name ?? r.primary_norad_id}
              </span>
              <StatusIndicator status={r.status} />
            </div>
            <div className="num mt-0.5 text-[10.5px] text-muted">
              {utc(r.start, false)} · {r.horizon_h} h · ≤ {r.threshold_km} km
            </div>
            {r.status === "running" && (
              <div className="mt-1.5 h-1 overflow-hidden rounded bg-line-2">
                <div className="h-full bg-cyan transition-all" style={{ width: `${Math.round(r.progress * 100)}%` }} />
              </div>
            )}
            {r.stats && (
              <div className="mt-1 text-[10.5px] text-ink-2">
                <span className="num text-ink">{r.stats.events}</span> events · {r.stats.candidates_after_shell_filter}/{r.stats.candidates_total} after shell filter ·{" "}
                {r.stats.runtime_s.toFixed(1)} s
              </div>
            )}
            {r.message && <div className="mt-1 text-[10.5px] text-danger">{r.message}</div>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function SigmaRow({ label, v, set }: { label: string; v: string[]; set: (x: string[]) => void }) {
  return (
    <div className="grid grid-cols-[88px_repeat(3,minmax(0,1fr))] items-center gap-1.5">
      <span className="text-[11px] text-ink-2">{label}</span>
      {["R", "T", "N"].map((ax, i) => (
        <input
          key={ax}
          className="input num w-full"
          placeholder={`σ${ax} km`}
          aria-label={`${label} sigma ${ax} in km`}
          type="number"
          min={0}
          step="any"
          value={v[i]}
          onChange={(e) => set(v.map((x, k) => (k === i ? e.target.value : x)))}
        />
      ))}
    </div>
  );
}

function RiskCalculator({ d, onResult }: { d: ConjunctionDetail; onResult: (a: PcAssessment) => void }) {
  const [hbr, setHbr] = useState(d.hbr_m);
  const [p, setP] = useState(["", "", ""]);
  const [s, setS] = useState(["", "", ""]);
  const [res, setRes] = useState<PcAssessment | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const bump = useApp((st) => st.bumpData);

  useEffect(() => setRes(null), [d.id]);
  const nums = (a: string[]) => a.map(Number);
  const valid = [...p, ...s].every((x) => x !== "" && Number(x) > 0);

  const go = async () => {
    setErr(null);
    try {
      const r = await api.risk(d.id, { hbr_m: hbr, primary_sigma_rtn_km: nums(p), secondary_sigma_rtn_km: nums(s) });
      setRes(r);
      onResult(r);
      bump();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const shown = res ?? d.assessment;
  const sens = (res?.sensitivity ?? []).filter((x) => x.pc > 1e-30).map((x) => ({ scale: `×${x.scale}`, pc: x.pc }));

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-line-2 bg-app p-3">
        <div className="flex items-center justify-between">
          <span className="label-caps">Collision probability</span>
          {shown.status === "computed" ? (
            <span className="rounded bg-warn/15 px-1.5 py-px text-[9.5px] font-semibold tracking-wider text-warn">ASSUMED COVARIANCE</span>
          ) : (
            <span className="rounded bg-line-2 px-1.5 py-px text-[9.5px] font-semibold tracking-wider text-ink-2">NO COVARIANCE</span>
          )}
        </div>
        {shown.status === "computed" ? (
          <>
            <div className="num mt-1.5 text-[26px] text-ink">{fmtPc(shown.pc)}</div>
            <div className="text-[11px] text-ink-2">
              Mahalanobis distance <span className="num text-ink">{shown.mahalanobis?.toFixed(2)}</span> · {shown.covariance_source}
            </div>
          </>
        ) : (
          <>
            <div className="mt-1.5 text-[12.5px] text-ink">Not computed: TLE data carries no covariance.</div>
            <div className="mt-2 text-[11px] text-ink-2">
              Worst case over spherical covariances: <span className="num text-ink">{fmtPc(shown.pc_max_isotropic)}</span> at σ ={" "}
              <span className="num">{fmtDistance(shown.pc_max_sigma_km)}</span>. Elongated covariances can exceed this; it is a reference, not a bound.
            </div>
          </>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="label-caps">Assumed 1σ position uncertainty (RTN)</div>
        <SigmaRow label="Primary" v={p} set={setP} />
        <SigmaRow label="Secondary" v={s} set={setS} />
        <div className="flex items-center gap-2 pt-1">
          <label className="flex items-center gap-1.5 text-[11px] text-ink-2">
            HBR
            <input className="input num w-[80px]" type="number" min={1} value={hbr} onChange={(e) => setHbr(Number(e.target.value))} aria-label="Hard-body radius in metres" />
            m
          </label>
          <button className="btn btn-primary ml-auto" disabled={!valid || hbr <= 0} onClick={go}>
            <Calculator size={13} /> Compute Pc
          </button>
        </div>
        <p className="text-[10.5px] text-muted">You supply these values; they are stored with the result and labelled as assumptions.</p>
        {err && <p className="text-[11px] text-danger">{err}</p>}
      </div>

      {sens.length > 0 && (
        <div>
          <div className="label-caps mb-1">Sensitivity: Pc vs covariance scale</div>
          {(res?.sensitivity.length ?? 0) > sens.length && <p className="mb-1 text-[10px] text-muted">Scales giving Pc below 1e-30 are omitted.</p>}
          <div className="h-[150px]">
            <ResponsiveContainer>
              <LineChart data={sens} margin={{ left: 4, right: 8, top: 6 }}>
                <CartesianGrid stroke="#1A2639" />
                <XAxis dataKey="scale" tick={{ fill: "#64748B", fontSize: 10 }} />
                <YAxis scale="log" domain={["auto", "auto"]} tick={{ fill: "#64748B", fontSize: 10 }} tickFormatter={(v) => Number(v).toExponential(0)} width={44} />
                <Tooltip contentStyle={tip} formatter={(v) => [fmtPc(Number(v)), "Pc"]} />
                <Line dataKey="pc" stroke="#F5B942" dot isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      <details className="text-[10.5px] text-muted">
        <summary className="cursor-pointer text-ink-2">Model assumptions ({shown.algorithm_version})</summary>
        <ul className="mt-1 list-disc pl-4">
          {shown.assumptions.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function EventDetail({ id }: { id: number }) {
  const dataVersion = useApp((s) => s.dataVersion);
  const { data: d, error, reload } = useAsync(() => api.conjunction(id), [id, dataVersion]);
  const [planeA, setPlaneA] = useState<PcAssessment | null>(null);
  // Reset the plot only when a different event is opened, not on refetch after a Pc computation.
  useEffect(() => setPlaneA(d?.assessment ?? null), [d?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!d) return <LoadingState />;
  const tr = d.relative_trajectory_rtn;
  const series = tr.t_s.map((t, i) => ({
    t,
    range: Math.hypot(tr.R_km[i], tr.T_km[i], tr.N_km[i]),
    R: tr.R_km[i],
    T: tr.T_km[i],
    N: tr.N_km[i],
  }));
  const latestSaved = d.saved_assessments[0];

  return (
    <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <PriorityBadge p={d.priority} />
          <span className="text-[14px] font-semibold text-ink">
            {d.primary_name ?? d.primary_norad_id} <span className="text-muted">×</span> {d.secondary_name ?? d.secondary_norad_id}
          </span>
          <span className="num text-[11px] text-muted">
            #{d.primary_norad_id} / #{d.secondary_norad_id}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            ["TCA", <span className="text-[13px]">{utc(d.tca)}</span>],
            ["Miss distance", fmtDistance(d.miss_distance_km)],
            ["Relative speed", `${d.relative_speed_kms.toFixed(3)} km/s`],
            ["Approach angle", `${d.approach_angle_deg.toFixed(1)}°`],
          ].map(([k, v]) => (
            <div key={String(k)} className="rounded-lg border border-line-2 bg-app px-3 py-2">
              <div className="label-caps">{k}</div>
              <div className="num mt-1 text-[17px] text-ink">{v}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <div className="label-caps mb-1">Separation around TCA</div>
            <div className="h-[230px] rounded-lg border border-line-2 bg-app p-2">
              <ResponsiveContainer>
                <LineChart data={series} margin={{ left: 4, right: 8, top: 8, bottom: 4 }}>
                  <CartesianGrid stroke="#1A2639" />
                  <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tick={{ fill: "#64748B", fontSize: 10 }} unit=" s" />
                  <YAxis tick={{ fill: "#64748B", fontSize: 10 }} width={64} unit=" km" />
                  <Tooltip contentStyle={tip} formatter={(v, n) => [`${Number(v).toFixed(3)} km`, String(n)]} labelFormatter={(t) => `TCA ${Number(t) >= 0 ? "+" : ""}${Number(t).toFixed(1)} s`} />
                  <Legend wrapperStyle={{ fontSize: 10.5 }} />
                  <Line dataKey="range" name="range" stroke="#36D6E8" dot={false} strokeWidth={2} isAnimationActive={false} />
                  <Line dataKey="R" name="radial" stroke="#4DA3FF" dot={false} isAnimationActive={false} />
                  <Line dataKey="T" name="along-track" stroke="#A78BFA" dot={false} isAnimationActive={false} />
                  <Line dataKey="N" name="cross-track" stroke="#35D39A" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-1 text-[10.5px] text-muted">Secondary relative to primary, in the primary's RTN frame, from SGP4.</p>
          </div>
          <div>
            <div className="label-caps mb-1">Encounter plane</div>
            {planeA && <EncounterPlanePlot a={planeA} />}
            <p className="mt-1 text-[10.5px] text-muted">{planeA?.status === "computed" ? "Amber: assumed 1σ (solid) and 3σ (dashed) combined covariance." : "No covariance to draw."}</p>
          </div>
        </div>

        <div>
          <div className="label-caps mb-1">Closest approach, animated</div>
          <RelativeMotion tr={tr} hbrM={d.hbr_m} missKm={d.miss_distance_km} />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="divide-y divide-line-2">
            <div className="label-caps pb-1">Miss components (primary RTN)</div>
            <KV k="Radial"><ScientificValue value={d.miss_rtn_km[0]} unit="km" /></KV>
            <KV k="Along-track"><ScientificValue value={d.miss_rtn_km[1]} unit="km" /></KV>
            <KV k="Cross-track"><ScientificValue value={d.miss_rtn_km[2]} unit="km" /></KV>
          </div>
          <div className="divide-y divide-line-2">
            <div className="label-caps pb-1">Data quality</div>
            <KV k="Primary elements"><span className="num">{utc(d.element_sets.primary.epoch, false)}</span></KV>
            <KV k="Secondary elements"><span className="num">{utc(d.element_sets.secondary.epoch, false)}</span></KV>
            <KV k="Longest prediction span">
              <span className={d.data_confidence === "adequate" ? "text-ok" : d.data_confidence === "reduced" ? "text-warn" : "text-danger"}>
                {d.prediction_span_days?.toFixed(1)} d · {d.data_confidence}
              </span>
            </KV>
            <KV k="Covariance"><span className="text-muted">NOT AVAILABLE (TLE)</span></KV>
          </div>
        </div>
        {latestSaved && (
          <p className="text-[11px] text-ink-2">
            Last saved assessment #{latestSaved.id}: Pc {fmtPc(latestSaved.pc)} ({latestSaved.covariance_source}), {utc(latestSaved.created_at)}
          </p>
        )}
      </div>
      <div className="panel p-3">
        <RiskCalculator d={d} onResult={setPlaneA} />
      </div>
    </div>
  );
}

export function CollisionAssessment() {
  const [params, setParams] = useSearchParams();
  const eventParam = params.get("event");
  const [runId, setRunId] = useState<number | null>(params.get("run") ? Number(params.get("run")) : null);
  const [eventId, setEventId] = useState<number | null>(eventParam ? Number(eventParam) : null);
  const runs = useAsync(() => api.screeningRuns(30), []);
  const active = (runs.data ?? []).some((r) => r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!active) return;
    const id = setInterval(runs.reload, 1000);
    return () => clearInterval(id);
  }, [active, runs.reload]);
  useEffect(() => {
    if (runId === null && runs.data?.length) setRunId(runs.data[0].id);
  }, [runs.data, runId]);

  const selRun = runs.data?.find((r) => r.id === runId) ?? null;
  const events = useAsync(() => (runId ? api.conjunctions({ run_id: runId }) : Promise.resolve([])), [runId, selRun?.status]);
  const now = Date.now();

  const chooseEvent = (id: number) => {
    setEventId(id);
    setParams({ run: String(runId), event: String(id) });
  };

  return (
    <div>
      <PageHeader eyebrow="Safety analysis" title="COLLISION ASSESSMENT" subtitle="Conjunction screening with SGP4, TCA refinement to 1 ms, and collision probability only where covariance is supplied." />
      <div className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        <div className="space-y-4">
          <ScreeningForm
            onStarted={(id) => {
              setRunId(id);
              setEventId(null);
              runs.reload();
            }}
          />
          <Panel title="Screening runs" bodyClassName="p-0 max-h-[420px] overflow-y-auto">
            {runs.error ? <ErrorState message={runs.error} onRetry={runs.reload} /> : !runs.data ? <LoadingState /> : <RunList runs={runs.data} selected={runId} onSelect={(id) => (setRunId(id), setEventId(null))} />}
          </Panel>
        </div>

        <Panel
          title={selRun ? `Conjunction events · run #${selRun.id}` : "Conjunction events"}
          subtitle={selRun ? `${selRun.primary_name ?? selRun.primary_norad_id} · ${utc(selRun.start, false)} + ${selRun.horizon_h} h · miss ≤ ${selRun.threshold_km} km` : undefined}
          bodyClassName="p-0 overflow-x-auto"
        >
          {!selRun ? (
            <EmptyState title="No screening selected" />
          ) : selRun.status === "running" || selRun.status === "queued" ? (
            <LoadingState label={`Screening ${Math.round(selRun.progress * 100)}%`} />
          ) : selRun.status === "failed" ? (
            <ErrorState message={selRun.message ?? "Screening failed"} />
          ) : events.error ? (
            <ErrorState message={events.error} onRetry={events.reload} />
          ) : !events.data ? (
            <LoadingState />
          ) : events.data.length === 0 ? (
            <EmptyState title="No conjunctions within the threshold">
              No object came within {selRun.threshold_km} km of the primary over the horizon. {selRun.stats && `${selRun.stats.pair_intervals_evaluated.toLocaleString()} pair-intervals were checked.`}
            </EmptyState>
          ) : (
            <>
              {selRun.warnings.map((w) => (
                <p key={w} className="border-b border-line-2 px-4 py-2 text-[11px] text-warn">
                  {w}
                </p>
              ))}
              <table className="w-full min-w-[980px] whitespace-nowrap text-[12px]">
                <thead className="bg-panel">
                  <tr className="border-b border-line-2 text-left text-[10px] uppercase tracking-wider text-muted">
                    <th className="px-3 py-2 font-semibold">Priority</th>
                    <th className="px-3 font-semibold">Secondary</th>
                    <th className="px-3 font-semibold">TCA</th>
                    <th className="px-3 text-right font-semibold">Miss</th>
                    <th className="px-3 text-right font-semibold">Rel. speed</th>
                    <th className="px-3 text-right font-semibold">R / T / N (km)</th>
                    <th className="px-3 font-semibold">Pc</th>
                    <th className="px-3 font-semibold">Data</th>
                  </tr>
                </thead>
                <tbody>
                  {events.data.map((e) => (
                    <tr key={e.id} onClick={() => chooseEvent(e.id)} className={`cursor-pointer border-b border-line-2/70 hover:bg-hover ${eventId === e.id ? "bg-elevated" : ""}`}>
                      <td className="px-3 py-2"><PriorityBadge p={e.priority} /></td>
                      <td className="max-w-[200px] truncate px-3 text-ink">
                        {e.secondary_name ?? "Unnamed"} <span className="num text-[10.5px] text-muted">#{e.secondary_norad_id}</span>
                      </td>
                      <td className="num px-3 text-[11.5px]">
                        {utc(e.tca)} <span className="block text-[10px] text-muted">{timeToTca(e.tca, now)}</span>
                      </td>
                      <td className="num px-3 text-right text-ink">{fmtDistance(e.miss_distance_km)}</td>
                      <td className="num px-3 text-right">{e.relative_speed_kms.toFixed(2)} km/s</td>
                      <td className="num px-3 text-right text-[11px] text-ink-2">{e.miss_rtn_km.map((x) => x.toFixed(2)).join(" / ")}</td>
                      <td className="px-3 text-[11px] text-muted">needs covariance</td>
                      <td className="px-3">
                        <StatusIndicator status={e.data_confidence === "adequate" ? "ok" : e.data_confidence === "reduced" ? "degraded" : "failed"} label={e.data_confidence ?? "—"} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Panel>
      </div>

      {eventId !== null && (
        <Panel title="Event analysis">
          <EventDetail id={eventId} />
        </Panel>
      )}
    </div>
  );
}
