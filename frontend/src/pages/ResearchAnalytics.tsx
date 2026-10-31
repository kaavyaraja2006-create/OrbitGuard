import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, FlaskConical, Loader2, Play } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ErrorBar, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui";
import { Notice } from "../components/auth/AuthLayout";
import { api, ApiError } from "../services/api";
import { useAsync } from "../services/useAsync";
import { useCan } from "../stores/auth";
import { fmt, utc } from "../lib/format";
import type { ExperimentRun } from "../types/mission";
import { SimBadge, tip } from "./DigitalTwin";

const METHOD_COLOR: Record<string, string> = { none: "#64748B", fixed: "#A78BFA", single: "#F5B942", "multi-nominal": "#4DA3FF", proposed: "#35D39A" };
const METRICS: [string, string, (v: number) => string][] = [
  ["success", "Success rate", (v) => `${(v * 100).toFixed(0)}%`],
  ["dv_ms", "Δv (mm/s)", (v) => (v * 1000).toFixed(1)],
  ["p_violation_independent", "Independent MC P(violation)", (v) => `${(v * 100).toFixed(1)}%`],
  ["violations_after", "Unsafe objects after", (v) => v.toFixed(2)],
  ["new_violations", "Newly created violations", (v) => v.toFixed(2)],
  ["min_sep_m", "Worst miss (m)", (v) => v.toFixed(0)],
  ["runtime_s", "Runtime (s)", (v) => v.toFixed(1)],
  ["raan_rate_change_deg_day", "Δ nodal rate (°/day)", (v) => v.toExponential(1)],
];

export function ResearchAnalytics() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const runId = Number(params.get("run")) || null;
  const catalog = useAsync(() => api.experimentCatalog(), []);
  const runs = useAsync(() => api.experiments(), [], 4000);
  const [seeds, setSeeds] = useState(3);
  const [profile, setProfile] = useState("fast");
  const [err, setErr] = useState<string | null>(null);
  const open = (id: number) => setParams((p) => { p.set("run", String(id)); return p; }, { replace: true });
  const start = async (name: string) => {
    setErr(null);
    try {
      const r = await api.startExperiment(name, seeds, profile);
      runs.reload();
      open(r.experiment_id);
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };
  useEffect(() => {
    if (!runId && runs.data?.length) {
      const done = runs.data.find((r) => r.status === "succeeded");
      if (done) open(done.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs.data, runId]);
  return (
    <div>
      <PageHeader eyebrow="Research" title="RESEARCH ANALYTICS" subtitle="Reproducible experiments E1–E8: the proposed optimiser against four baselines on seeded synthetic scenarios." />
      <div className="mb-4 rounded-lg border border-line-2 bg-panel px-3 py-2 text-[12px] text-ink-2">
        <SimBadge>SYNTHETIC SCENARIOS</SimBadge> Every number below comes from a run stored here, with its configuration, seeds and software versions. Nothing is tuned or typed in by hand.
      </div>
      {err && <Notice kind="error">{err}</Notice>}
      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[380px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Panel title="Experiments" subtitle="Spec §18" actions={can("research:run") ? (
            <div className="flex items-center gap-1.5 text-[11px]">
              <select className="input h-7" value={seeds} onChange={(e) => setSeeds(Number(e.target.value))} aria-label="Seeds">{[1, 3, 5, 10].map((s) => <option key={s} value={s}>{s} seed{s > 1 ? "s" : ""}</option>)}</select>
              <select className="input h-7" value={profile} onChange={(e) => setProfile(e.target.value)} aria-label="Profile"><option value="fast">fast (12 h)</option><option value="full">full (24 h)</option></select>
            </div>
          ) : undefined}>
            {!catalog.data ? <LoadingState /> : (
              <ul className="space-y-2">
                {catalog.data.map((e) => (
                  <li key={e.name} className="rounded-lg border border-line-2 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12.5px] font-medium text-ink"><span className="num text-cyan">{e.name}</span> {e.title}</span>
                      {can("research:run") && <button className="btn h-7 px-2" onClick={() => start(e.name)}><Play size={11} /> Run</button>}
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted">{e.question}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Runs" bodyClassName="p-0 max-h-[360px] overflow-y-auto">
            {runs.error ? <ErrorState message={runs.error} /> : !runs.data ? <LoadingState /> : runs.data.length === 0 ? <EmptyState title="No experiment runs yet" /> : (
              <ul className="divide-y divide-line-2">
                {runs.data.map((r) => (
                  <li key={r.id}>
                    <button onClick={() => open(r.id)} className={`w-full px-3 py-2 text-left hover:bg-hover/50 ${r.id === runId ? "bg-elevated" : ""}`}>
                      <div className="flex items-center justify-between text-[12px]"><span className="text-ink"><span className="num text-cyan">{r.name}</span> #{r.id} · {r.seeds} seeds · {r.profile}</span>
                        <span className={r.status === "succeeded" ? "text-ok" : r.status === "failed" ? "text-danger" : "text-warn"}>{r.status}</span></div>
                      {(r.status === "running" || r.status === "queued") && <div className="mt-1.5 h-1 overflow-hidden rounded bg-hover"><div className="h-full bg-cyan" style={{ width: `${r.progress * 100}%` }} /></div>}
                      <div className="mt-0.5 truncate text-[10.5px] text-muted">{r.status === "running" ? r.stage : utc(r.created_at)}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
        <div className="min-w-0">{runId ? <RunView id={runId} /> : <Panel><EmptyState title="Run or pick an experiment" icon={<FlaskConical size={18} />} /></Panel>}</div>
      </div>
    </div>
  );
}

function RunView({ id }: { id: number }) {
  const [run, setRun] = useState<ExperimentRun | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [metric, setMetric] = useState("success");
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const load = () => api.experiment(id).then((r) => {
      if (!alive) return;
      setRun(r);
      if (r.status === "queued" || r.status === "running") timer = window.setTimeout(load, 2000);
    }).catch((e) => setErr((e as ApiError).message));
    setRun(null);
    load();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [id]);
  const res = run?.result;
  const chart = useMemo(() => {
    if (!res) return { data: [], methods: [] as string[] };
    const groups = [...new Set(res.summary.map((s: { group: string }) => s.group))] as string[];
    const methods = res.methods as string[];
    const data = groups.map((g) => {
      const row: Record<string, number | string | number[]> = { group: g };
      for (const m of methods) {
        const s = res.summary.find((x: { group: string; method: string }) => x.group === g && x.method === m);
        if (s && s[`${metric}_mean`] !== undefined) {
          row[m] = s[`${metric}_mean`];
          row[`${m}_err`] = s[`${metric}_std`] ?? 0;
        }
      }
      return row;
    });
    return { data, methods };
  }, [res, metric]);
  if (err) return <Panel><ErrorState message={err} /></Panel>;
  if (!run) return <Panel><LoadingState /></Panel>;
  if (run.status !== "succeeded")
    return <Panel title={`${run.name} · ${run.title}`}>{run.status === "failed" ? <Notice kind="error">{run.message}</Notice> : (
      <div className="py-8 text-center"><Loader2 size={20} className="mx-auto mb-3 animate-spin text-cyan" /><div className="text-[12.5px] text-ink">{run.stage ?? "queued"}</div>
        <div className="mx-auto mt-3 h-1.5 max-w-[360px] overflow-hidden rounded bg-hover"><div className="h-full bg-cyan" style={{ width: `${run.progress * 100}%` }} /></div></div>
    )}</Panel>;
  const fmtM = METRICS.find((m) => m[0] === metric)![2];
  return (
    <div className="space-y-4">
      <Panel title={`${res.experiment} · ${res.title}`} subtitle={res.question} actions={
        <>
          <a className="btn h-7" href={`/api/v1/research/experiments/${run.id}/csv`}><Download size={12} /> CSV</a>
          <button className="btn h-7" onClick={() => { const b = new Blob([JSON.stringify(res, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `orbitguard_${res.experiment}_${run.id}.json`; a.click(); }}><Download size={12} /> JSON</button>
        </>
      }>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11.5px] text-ink-2">
          <span>{res.runs.length} runs · {res.seeds} seeds · profile {res.profile}</span>
          <span>{fmt(res.runtime_s, 0)} s total</span>
          <span className="num">engine {res.versions.engine} · {res.versions.experiments} · numpy {res.versions.numpy}</span>
        </div>
        <p className="mt-1.5 text-[10.5px] text-muted">{res.label} {res.config.scenario}.</p>
      </Panel>

      <Panel title="Comparison" actions={
        <select className="input h-7" value={metric} onChange={(e) => setMetric(e.target.value)} aria-label="Metric">{METRICS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      }>
        <div className="h-[280px]">
          <ResponsiveContainer>
            <BarChart data={chart.data} margin={{ left: 4, right: 12, top: 8 }}>
              <CartesianGrid stroke="#1A2639" vertical={false} />
              <XAxis dataKey="group" tick={{ fill: "#9AAAC0", fontSize: 11 }} />
              <YAxis tick={{ fill: "#64748B", fontSize: 10 }} width={56} domain={[0, (max: number) => (max > 0 ? max * 1.15 : 1)]} tickFormatter={(v) => fmtM(Number(v))} />
              <Tooltip contentStyle={tip} formatter={(v, n) => [fmtM(Number(v)), String(n)]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {chart.methods.map((m) => (
                <Bar key={m} dataKey={m} fill={METHOD_COLOR[m] ?? "#36D6E8"} isAnimationActive={false}>
                  <ErrorBar dataKey={`${m}_err`} stroke="#E8EEF7" strokeWidth={1} width={4} />
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-1 text-[10.5px] text-muted">Bars: mean over seeds; whiskers: ±1 standard deviation.</p>
      </Panel>

      <Panel title="Summary table" bodyClassName="p-0 overflow-x-auto">
        <table className="w-full min-w-[900px] text-[11.5px]">
          <thead><tr className="border-b border-line-2 text-left text-[10px] uppercase tracking-wider text-muted">
            <th className="px-3 py-2 font-semibold">Group</th><th className="px-2 font-semibold">Method</th><th className="px-2 text-right font-semibold">n</th>
            {METRICS.map(([k, l]) => <th key={k} className="px-2 text-right font-semibold">{l}</th>)}</tr></thead>
          <tbody>{res.summary.map((s: Record<string, number | string>, i: number) => (
            <tr key={i} className="border-b border-line-2/60">
              <td className="px-3 py-1.5 text-ink">{s.group}</td>
              <td className="px-2"><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: METHOD_COLOR[String(s.method)] }} />{s.method}</span></td>
              <td className="num px-2 text-right">{s.n}</td>
              {METRICS.map(([k, , f]) => <td key={k} className="num px-2 text-right">{s[`${k}_mean`] === undefined ? "—" : f(Number(s[`${k}_mean`]))}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </Panel>

      {res.detail && (
        <Panel title="E1 detail: the selected maneuver, independently validated">
          <ul className="space-y-1 text-[12px] text-ink">{(res.detail.explanation ?? []).map((x: string, i: number) => <li key={i} className="flex gap-2"><span className="text-cyan">›</span>{x}</li>)}</ul>
        </Panel>
      )}

      <Panel title="All runs" bodyClassName="p-0 overflow-x-auto max-h-[360px]">
        <table className="w-full min-w-[860px] text-[11px]">
          <thead className="sticky top-0 bg-panel"><tr className="border-b border-line-2 text-left text-[10px] uppercase tracking-wider text-muted">
            <th className="px-3 py-2 font-semibold">Group</th><th className="px-2 font-semibold">Method</th><th className="px-2 font-semibold">Seed</th><th className="px-2 font-semibold">Outcome</th>
            <th className="px-2 text-right font-semibold">Δv mm/s</th><th className="px-2 text-right font-semibold">Worst miss before → after (m)</th><th className="px-2 text-right font-semibold">P(viol.)</th><th className="px-2 text-right font-semibold">Unsafe after</th><th className="px-2 text-right font-semibold">s</th></tr></thead>
          <tbody>{res.runs.map((r: Record<string, number | string | boolean>, i: number) => (
            <tr key={i} className="border-b border-line-2/50">
              <td className="px-3 py-1 text-ink-2">{r.group}</td><td className="px-2">{r.method}</td><td className="num px-2">{r.seed}</td>
              <td className={`px-2 ${r.success ? "text-ok" : "text-danger"}`}>{r.success ? "safe" : String(r.status)}</td>
              <td className="num px-2 text-right">{fmt(Number(r.dv_ms) * 1000, 1)}</td>
              <td className="num px-2 text-right">{fmt(Number(r.min_sep_before_m), 0)} → {fmt(Number(r.min_sep_m), 0)}</td>
              <td className="num px-2 text-right">{(Number(r.p_violation_independent) * 100).toFixed(1)}%</td>
              <td className="num px-2 text-right">{r.violations_after}</td>
              <td className="num px-2 text-right">{fmt(Number(r.runtime_s), 1)}</td>
            </tr>
          ))}</tbody>
        </table>
      </Panel>
    </div>
  );
}

