import { useEffect, useState } from "react";
import { Database, Download, FlaskConical, GitCompare, Play } from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { EncounterPlanePlot, fmtPc } from "../components/conjunction";
import { EmptyState, ErrorState, KV, LoadingState, MetricCard, PageHeader, Panel, StatusIndicator } from "../components/ui";
import { api } from "../services/api";
import { useCan } from "../stores/auth";
import { useAsync } from "../services/useAsync";
import type { DatasetJob, KelvinsEventRow } from "../types";
import { utc } from "../lib/format";

const tip = { background: "#121D30", border: "1px solid #223149", fontSize: 11 };
const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${x.toFixed(1)} %`);

function JobBar({ job }: { job: DatasetJob | null | undefined }) {
  if (!job) return null;
  return (
    <div className="rounded-md border border-line-2 bg-app px-3 py-2 text-[11.5px]">
      <div className="flex items-center justify-between">
        <span className="text-ink-2">
          {job.kind} #{job.id} · {utc(job.created_at)}
        </span>
        <StatusIndicator status={job.status} />
      </div>
      {(job.status === "running" || job.status === "queued") && (
        <div className="mt-1.5 h-1 overflow-hidden rounded bg-line-2">
          <div className="h-full bg-cyan transition-all" style={{ width: `${Math.round(job.progress * 100)}%` }} />
        </div>
      )}
      {job.message && <p className={`mt-1 ${job.status === "failed" ? "text-danger" : "text-ink-2"}`}>{job.message}</p>}
    </div>
  );
}

function useJobs() {
  const jobs = useAsync(() => api.datasetJobs(30), []);
  const active = (jobs.data ?? []).some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    if (!active) return;
    const id = setInterval(jobs.reload, 1200);
    return () => clearInterval(id);
  }, [active, jobs.reload]);
  return jobs;
}

// ------------------------------------------------------------------ Kelvins
function KelvinsEventView({ ev }: { ev: KelvinsEventRow }) {
  const d = useAsync(() => api.kelvinsEvent(ev.split, ev.event_id), [ev.split, ev.event_id]);
  if (d.error) return <ErrorState message={d.error} />;
  if (!d.data) return <LoadingState />;
  const series = d.data.series.map((s) => ({ t: s.time_to_tca_d, esa: s.esa_risk !== null && s.esa_risk > -30 ? s.esa_risk : null, ours: s.our_log10_pc }));
  const last = d.data.series[d.data.series.length - 1];
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div>
        <div className="label-caps mb-1">Risk evolution over the CDM sequence (log₁₀ Pc)</div>
        <div className="h-[250px] rounded-lg border border-line-2 bg-app p-2">
          <ResponsiveContainer>
            <LineChart data={series} margin={{ left: 4, right: 12, top: 8 }}>
              <CartesianGrid stroke="#1A2639" />
              <XAxis dataKey="t" type="number" reversed domain={["dataMax", 0]} tick={{ fill: "#64748B", fontSize: 10 }} label={{ value: "days to TCA", fill: "#64748B", fontSize: 10, position: "insideBottomRight", offset: -2 }} />
              <YAxis tick={{ fill: "#64748B", fontSize: 10 }} width={40} domain={["auto", "auto"]} />
              <Tooltip contentStyle={tip} formatter={(v, n) => [Number(v).toFixed(3), String(n)]} labelFormatter={(t) => `${Number(t).toFixed(2)} d to TCA`} />
              <Legend wrapperStyle={{ fontSize: 10.5 }} />
              <Line dataKey="esa" name="ESA risk" stroke="#F5B942" dot isAnimationActive={false} connectNulls />
              <Line dataKey="ours" name="ORBITGUARD (mission HBR)" stroke="#36D6E8" strokeDasharray="4 3" dot isAnimationActive={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-3 divide-y divide-line-2">
          <KV k="Mission / chaser type">
            <span className="num">
              {d.data.mission_id} · {d.data.chaser_type ?? "UNKNOWN"}
            </span>
          </KV>
          <KV k="Mission median inferred HBR">
            <span className="num">{d.data.mission_median_hbr_m?.toFixed(2) ?? "—"} m</span>
          </KV>
          <KV k="Last CDM: miss / Mahalanobis (ESA vs ours)">
            <span className="num">
              {last.miss_m?.toFixed(0)} m · {last.esa_mahalanobis?.toFixed(2)} vs {last.our_mahalanobis?.toFixed(2) ?? "—"}
            </span>
          </KV>
          <KV k="Last CDM: ESA risk vs ours">
            <span className="num">
              {last.esa_risk?.toFixed(3)} vs {last.our_log10_pc?.toFixed(3) ?? "—"}
            </span>
          </KV>
        </div>
      </div>
      <div>
        <div className="label-caps mb-1">Last CDM: encounter plane with real ESA covariance</div>
        {d.data.last_cdm_plane ? (
          <>
            <EncounterPlanePlot a={d.data.last_cdm_plane} />
            <p className="mt-1 text-[10.5px] text-muted">
              Pc {fmtPc(d.data.last_cdm_plane.pc)} with HBR {d.data.mission_median_hbr_m?.toFixed(2)} m. Amber: 1σ (solid) and 3σ (dashed) combined covariance from the CDM.
            </p>
          </>
        ) : (
          <EmptyState title="No valid covariance in the last CDM" />
        )}
      </div>
    </div>
  );
}

function KelvinsTab() {
  const canRun = useCan()("validation:run");
  const files = useAsync(() => api.datasetFiles(), []);
  const jobs = useJobs();
  const latestImport = (jobs.data ?? []).find((j) => j.kind === "kelvins-import");
  const summaryJob = useAsync(() => api.kelvinsSummary(), [latestImport?.status]);
  const scatter = useAsync(() => api.kelvinsScatter(3000), [summaryJob.data?.id]);
  const [split, setSplit] = useState("");
  const events = useAsync(() => api.kelvinsEvents({ split: split || undefined, limit: 50 }), [summaryJob.data?.id, split]);
  const [sel, setSel] = useState<KelvinsEventRow | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const k = files.data?.kelvins ?? {};
  const has = Object.keys(k).length > 0;
  const sm = summaryJob.data?.summary;
  const busy = latestImport?.status === "running" || latestImport?.status === "queued";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
        <Panel title="ESA Kelvins CDM dataset" subtitle="Real CDMs with covariance (ESA, 2015–2019, CC BY 4.0)">
          {files.error ? (
            <ErrorState message={files.error} />
          ) : !files.data ? (
            <LoadingState />
          ) : (
            <div className="space-y-3">
              <p className="break-all text-[10.5px] text-muted">Data folder: {files.data.data_dir}</p>
              {(["train", "test", "test_private"] as const).map((s) => (
                <KV key={s} k={s}>
                  {k[s] ? (
                    <span className="num text-ink">
                      {k[s]!.path} · {mb(k[s]!.bytes)}
                    </span>
                  ) : (
                    <span className="text-muted">not found</span>
                  )}
                </KV>
              ))}
              <button
                className="btn btn-primary w-full justify-center"
                title={canRun ? undefined : "Your role can view results but not run imports"}
                disabled={!canRun || !has || busy}
                onClick={async () => {
                  setErr(null);
                  try {
                    await api.kelvinsImport();
                    jobs.reload();
                  } catch (e) {
                    setErr((e as Error).message);
                  }
                }}
              >
                <Download size={13} /> {sm ? "Re-import and recompute" : "Import and validate"}
              </button>
              {err && <p className="text-[11px] text-danger">{err}</p>}
              <JobBar job={latestImport} />
              <p className="text-[10.5px] leading-relaxed text-muted">
                Processing all ~190,000 CDMs takes a few minutes. Files are read locally and never uploaded or redistributed. Cite: Uriot, Izzo et al., ESA, doi:10.5281/zenodo.4463683.
              </p>
            </div>
          )}
        </Panel>

        {!sm ? (
          <Panel title="Results">
            <EmptyState title="Not imported yet" icon={<FlaskConical size={22} strokeWidth={1.5} />}>
              Import the dataset to compare ORBITGUARD's collision probability with ESA's on every CDM.
            </EmptyState>
          </Panel>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <MetricCard label="CDMs / events" value={sm.cdms.toLocaleString()} hint={`${sm.events.toLocaleString()} events · ${sm.cdms_with_inferred_hbr.toLocaleString()} with HBR`} />
              <MetricCard label="Mahalanobis within 1 %" value={pct(sm.mahalanobis_rel_error.within_1pct)} accent="var(--color-ok)" hint={`median rel. error ${(100 * (sm.mahalanobis_rel_error.median ?? 0)).toFixed(2)} %`} />
              <MetricCard label="Pc within 0.1 dex" value={pct(sm.pc_agreement.within_0_1_dex_pct)} accent="var(--color-cyan)" hint={`median |Δ| ${sm.pc_agreement.median_abs_dex?.toFixed(3)} dex, n=${sm.pc_agreement.n.toLocaleString()}`} />
              <MetricCard label="High-risk (≥ 1e-6) within 0.1 dex" value={pct(sm.pc_agreement.high_risk_within_0_1_dex_pct)} accent="var(--color-warn)" hint={`n=${sm.pc_agreement.high_risk_n.toLocaleString()}`} />
            </div>
            <Panel title="ORBITGUARD Pc vs ESA risk (log₁₀)" subtitle={scatter.data ? `${scatter.data.shown.toLocaleString()} of ${scatter.data.total.toLocaleString()} CDMs, fixed random sample` : undefined}>
              {!scatter.data ? (
                <LoadingState />
              ) : (
                <div className="h-[300px]">
                  <ResponsiveContainer>
                    <ScatterChart margin={{ left: 4, right: 12, top: 8, bottom: 8 }}>
                      <CartesianGrid stroke="#1A2639" />
                      <XAxis type="number" dataKey="esa" name="ESA" domain={[-30, 0]} tick={{ fill: "#64748B", fontSize: 10 }} label={{ value: "ESA risk", fill: "#64748B", fontSize: 10, position: "insideBottomRight", offset: -4 }} />
                      <YAxis type="number" dataKey="ours" name="ORBITGUARD" domain={[-30, 0]} tick={{ fill: "#64748B", fontSize: 10 }} width={40} />
                      <ReferenceLine segment={[{ x: -30, y: -30 }, { x: 0, y: 0 }]} stroke="#64748B" strokeDasharray="4 4" />
                      <Tooltip contentStyle={tip} formatter={(v) => Number(v).toFixed(3)} />
                      <Scatter data={scatter.data.points} fill="#36D6E8" fillOpacity={0.45} isAnimationActive={false} />
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              )}
              <p className="mt-2 text-[11px] leading-relaxed text-ink-2">{sm.method}</p>
            </Panel>
          </div>
        )}
      </div>

      {sm && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
          <Panel title="Inferred hard-body radius by mission" subtitle="Small spread = consistent with ESA's model" bodyClassName="p-0 max-h-[420px] overflow-y-auto">
            <table className="w-full text-[11.5px]">
              <thead className="sticky top-0 bg-panel">
                <tr className="border-b border-line-2 text-left text-[10px] uppercase tracking-wider text-muted">
                  <th className="px-3 py-2 font-semibold">Mission</th>
                  <th className="px-3 text-right font-semibold">CDMs</th>
                  <th className="px-3 text-right font-semibold">Median HBR</th>
                  <th className="px-3 text-right font-semibold">IQR / median</th>
                </tr>
              </thead>
              <tbody>
                {(sm.missions as { mission_id: number; cdms_with_hbr: number; median_hbr_m: number; relative_spread: number | null }[]).map((m) => (
                  <tr key={m.mission_id} className="border-b border-line-2/70">
                    <td className="num px-3 py-1.5">{m.mission_id}</td>
                    <td className="num px-3 text-right text-ink-2">{m.cdms_with_hbr.toLocaleString()}</td>
                    <td className="num px-3 text-right text-ink">{m.median_hbr_m.toFixed(2)} m</td>
                    <td className={`num px-3 text-right ${m.relative_spread !== null && m.relative_spread < 0.05 ? "text-ok" : "text-warn"}`}>
                      {m.relative_spread === null ? "—" : `${(100 * m.relative_spread).toFixed(1)} %`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel
            title="Event explorer"
            subtitle="Highest ESA risk first (latest CDM per event)"
            bodyClassName="p-0"
            actions={
              <select className="input h-7" value={split} onChange={(e) => (setSplit(e.target.value), setSel(null))} aria-label="Dataset split">
                <option value="">All splits</option>
                <option value="train">train</option>
                <option value="test">test</option>
                <option value="test_private">test_private</option>
              </select>
            }
          >
            {!events.data ? (
              <LoadingState />
            ) : (
              <div className="max-h-[420px] overflow-auto">
                <table className="w-full min-w-[620px] whitespace-nowrap text-[11.5px]">
                  <thead className="sticky top-0 bg-panel">
                    <tr className="border-b border-line-2 text-left text-[10px] uppercase tracking-wider text-muted">
                      <th className="px-3 py-2 font-semibold">Event</th>
                      <th className="px-3 font-semibold">Mission</th>
                      <th className="px-3 text-right font-semibold">CDMs</th>
                      <th className="px-3 text-right font-semibold">Miss</th>
                      <th className="px-3 text-right font-semibold">ESA risk</th>
                      <th className="px-3 text-right font-semibold">Ours</th>
                      <th className="px-3 font-semibold">Chaser</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.data.map((e) => (
                      <tr key={`${e.split}-${e.event_id}`} onClick={() => setSel(e)} className={`cursor-pointer border-b border-line-2/70 hover:bg-hover ${sel?.event_id === e.event_id && sel.split === e.split ? "bg-elevated" : ""}`}>
                        <td className="num px-3 py-1.5">
                          {e.split}/{e.event_id}
                        </td>
                        <td className="num px-3">{e.mission_id}</td>
                        <td className="num px-3 text-right">{e.cdm_count}</td>
                        <td className="num px-3 text-right">{e.miss_m?.toFixed(0)} m</td>
                        <td className="num px-3 text-right text-warn">{e.esa_risk?.toFixed(3)}</td>
                        <td className="num px-3 text-right text-cyan">{e.our_log10_pc?.toFixed(3) ?? "—"}</td>
                        <td className="px-3 text-ink-2">{e.chaser_type}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      )}
      {sel && (
        <Panel title={`Kelvins event ${sel.split}/${sel.event_id}`}>
          <KelvinsEventView ev={sel} />
        </Panel>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ SOCRATES
function SocratesTab() {
  const canRun = useCan()("validation:run");
  const files = useAsync(() => api.datasetFiles(), []);
  const jobs = useJobs();
  const imports = (jobs.data ?? []).filter((j) => j.kind === "socrates-import");
  const lastImport = imports[0];
  const okImport = imports.find((j) => j.status === "succeeded");
  const lastCompare = (jobs.data ?? []).find((j) => j.kind === "socrates-compare");
  const [limit, setLimit] = useState(200);
  const [err, setErr] = useState<string | null>(null);
  const rows = useAsync(() => (okImport ? api.socratesRows(okImport.id, true, 500) : Promise.resolve([])), [okImport?.id, lastCompare?.status]);
  const stats = lastCompare?.status === "succeeded" ? lastCompare.summary : null;
  const busy = [lastImport, lastCompare].some((j) => j && (j.status === "running" || j.status === "queued"));

  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      jobs.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
        <Panel title="CelesTrak SOCRATES report" subtitle="Independent TLE-based screening (STK/CAT, SGP4)">
          {!files.data ? (
            <LoadingState />
          ) : (
            <div className="space-y-3">
              {files.data.socrates.length === 0 ? (
                <p className="text-[11.5px] text-muted">No SOCRATES CSV found in {files.data.data_dir}</p>
              ) : (
                files.data.socrates.map((f) => (
                  <KV key={f.path} k="File">
                    <span className="num text-ink">
                      {f.path} · {mb(f.bytes)}
                    </span>
                  </KV>
                ))
              )}
              <button className="btn btn-primary w-full justify-center" title={canRun ? undefined : "Your role can view results but not run imports"} disabled={!canRun || !files.data.socrates.length || busy} onClick={() => act(() => api.socratesImport())}>
                <Database size={13} /> Import newest SOCRATES file
              </button>
              {okImport?.summary && (
                <div className="divide-y divide-line-2">
                  <KV k="Rows imported"><span className="num">{okImport.summary.rows.toLocaleString()}</span></KV>
                  <KV k="TCA span"><span className="num text-[11px]">{utc(okImport.summary.tca_first, false)} → {utc(okImport.summary.tca_last, false)}</span></KV>
                </div>
              )}
              <div className="flex items-center gap-2 pt-1">
                <label className="text-[11px] text-ink-2">
                  Compare closest
                  <input className="input num mx-1.5 w-[80px]" type="number" min={1} max={5000} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
                  events
                </label>
                <button className="btn ml-auto" disabled={!canRun || !okImport || busy} onClick={() => okImport && act(() => api.socratesCompare(okImport.id, limit))}>
                  <GitCompare size={13} /> Compare
                </button>
              </div>
              {err && <p className="text-[11px] text-danger">{err}</p>}
              <JobBar job={lastCompare && lastCompare.created_at > (lastImport?.created_at ?? "") ? lastCompare : lastImport} />
              <p className="text-[10.5px] leading-relaxed text-muted">
                For a fair comparison, ingest CelesTrak "All active satellites" plus debris groups on the same day you downloaded the CSV. Rows whose element-set epochs differ from SOCRATES' (derived from DSE) are reported separately.
              </p>
            </div>
          )}
        </Panel>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {(["same element sets", "different element sets"] as const).map((k) => (
              <MetricCard
                key={k}
                label={`${k}: |Δ TCA| median`}
                value={stats?.[k]?.median_abs_dt_s === undefined || stats?.[k]?.median_abs_dt_s === null ? "—" : stats[k].median_abs_dt_s.toFixed(3)}
                unit={stats?.[k]?.median_abs_dt_s != null ? "s" : undefined}
                accent={k.startsWith("same") ? "var(--color-ok)" : "var(--color-warn)"}
                hint={stats ? `n=${stats[k]?.n ?? 0} · p95 ${stats[k]?.p95_abs_dt_s?.toFixed(2) ?? "—"} s` : "Run a comparison"}
              />
            ))}
            {(["same element sets", "different element sets"] as const).map((k) => (
              <MetricCard
                key={`r-${k}`}
                label={`${k}: |Δ range| median`}
                value={stats?.[k]?.median_abs_drange_m == null ? "—" : stats[k].median_abs_drange_m.toFixed(1)}
                unit={stats?.[k]?.median_abs_drange_m != null ? "m" : undefined}
                accent={k.startsWith("same") ? "var(--color-ok)" : "var(--color-warn)"}
                hint={stats ? `p95 ${stats[k]?.p95_abs_drange_m?.toFixed(1) ?? "—"} m` : " "}
              />
            ))}
          </div>
          {stats?.status_counts && (
            <p className="text-[11px] text-ink-2">
              Compared {stats.compared}:{" "}
              {Object.entries(stats.status_counts as Record<string, number>)
                .map(([k, v]) => `${v} ${k}`)
                .join(" · ")}
            </p>
          )}
        </div>
      </div>

      <Panel title="Compared conjunctions" bodyClassName="p-0 overflow-x-auto max-h-[520px]">
        {!rows.data ? (
          <LoadingState />
        ) : rows.data.length === 0 ? (
          <EmptyState title="Nothing compared yet" icon={<Play size={20} strokeWidth={1.5} />}>
            Import the SOCRATES file, ingest matching CelesTrak data, then press Compare.
          </EmptyState>
        ) : (
          <table className="w-full min-w-[1100px] whitespace-nowrap text-[11.5px]">
            <thead className="sticky top-0 bg-panel">
              <tr className="border-b border-line-2 text-left text-[10px] uppercase tracking-wider text-muted">
                <th className="px-3 py-2 font-semibold">Pair</th>
                <th className="px-3 font-semibold">SOCRATES TCA</th>
                <th className="px-3 text-right font-semibold">SOCRATES range</th>
                <th className="px-3 text-right font-semibold">Our range</th>
                <th className="px-3 text-right font-semibold">Δ range</th>
                <th className="px-3 text-right font-semibold">Δ TCA</th>
                <th className="px-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.data.map((r) => (
                <tr key={r.id} className="border-b border-line-2/70">
                  <td className="max-w-[300px] truncate px-3 py-1.5 text-ink">
                    {r.name_1} × {r.name_2}{" "}
                    <span className="num text-[10px] text-muted">
                      #{r.norad_1}/#{r.norad_2}
                    </span>
                  </td>
                  <td className="num px-3">{utc(r.tca)}</td>
                  <td className="num px-3 text-right">{(r.range_km * 1000).toFixed(0)} m</td>
                  <td className="num px-3 text-right">{r.our_range_km === null ? "—" : `${(r.our_range_km * 1000).toFixed(0)} m`}</td>
                  <td className="num px-3 text-right">{r.our_range_km === null ? "—" : `${((r.our_range_km - r.range_km) * 1000).toFixed(1)} m`}</td>
                  <td className="num px-3 text-right">{r.dt_s === null ? "—" : `${r.dt_s.toFixed(3)} s`}</td>
                  <td className="px-3">
                    <StatusIndicator
                      status={r.compare_status === "same element sets" ? "ok" : r.compare_status === "different element sets" ? "degraded" : "failed"}
                      label={r.compare_status ?? "—"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

export function Validation() {
  const [tab, setTab] = useState<"kelvins" | "socrates">("kelvins");
  return (
    <div>
      <PageHeader eyebrow="Research" title="VALIDATION" subtitle="ORBITGUARD's calculations checked against independent external references." />
      <div className="mb-4 flex gap-1 border-b border-line-2" role="tablist">
        {[
          ["kelvins", "ESA Kelvins: collision probability"],
          ["socrates", "CelesTrak SOCRATES: screening"],
        ].map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k as "kelvins" | "socrates")}
            className={`-mb-px border-b-2 px-3 py-2 text-[12.5px] ${tab === k ? "border-cyan text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "kelvins" ? <KelvinsTab /> : <SocratesTab />}
    </div>
  );
}
