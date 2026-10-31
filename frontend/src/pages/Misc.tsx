import { Link, useLocation } from "react-router-dom";
import { CheckCircle2, CircleDashed } from "lucide-react";
import { ALL_ITEMS } from "../nav";
import { ErrorState, LoadingState, PageHeader, Panel, PhaseTag } from "../components/ui";
import { RunsTable } from "./DataSources";
import { api } from "../services/api";
import { useAsync } from "../services/useAsync";
import { utc } from "../lib/format";
import { useCan } from "../stores/auth";

const PHASES = [
  { n: 1, name: "Foundation", items: "Monorepo, FastAPI, React shell, database, 3D globe, CI" },
  { n: 2, name: "Orbit intelligence", items: "Orbital elements, six-label classification, SSO detection" },
  { n: 3, name: "Real data and tracking", items: "CelesTrak ingestion, TLE parsing, SGP4, tracking tables" },
  { n: 4, name: "Collision assessment", items: "Broad-phase screening, TCA refinement, covariance, Pc" },
  { n: 5, name: "Digital twin", items: "Spacecraft model, propulsion, fuel, numerical propagation" },
  { n: 6, name: "Optimisation", items: "Candidates, constraints, multi-threat evaluation, validation" },
  { n: 7, name: "Simulation", items: "Before/after trajectories, playback, orbit transfer lab" },
  { n: 8, name: "Research and deployment", items: "Baselines, ablations, benchmarks, reports" },
];
const DONE = new Set([1, 2, 3, 4, 5, 6, 7, 8]);

export function PlannedModule() {
  const loc = useLocation();
  const item = ALL_ITEMS.find((i) => i.path === loc.pathname);
  if (!item) return <NotFound />;
  return (
    <div className="max-w-3xl">
      <PageHeader title={item.label.toUpperCase()} subtitle={item.summary} />
      <Panel title={<span className="flex items-center gap-2">Module status <PhaseTag phase={item.phase} /></span>}>
        <p className="text-[12.5px] leading-relaxed text-ink-2">
          This module is scheduled for <span className="text-ink">Phase {item.phase}</span> and is not functional yet. ORBITGUARD only shows results it has calculated, so
          this page deliberately contains no sample data or inactive controls.
        </p>
      </Panel>
      <Panel title="Build roadmap" className="mt-4">
        <ol className="space-y-2.5">
          {PHASES.map((p) => (
            <li key={p.n} className="flex gap-3">
              {DONE.has(p.n) ? <CheckCircle2 size={16} className="mt-px shrink-0 text-ok" /> : <CircleDashed size={16} className={`mt-px shrink-0 ${p.n === item.phase ? "text-cyan" : "text-muted"}`} />}
              <span>
                <span className={`text-[12.5px] ${p.n === item.phase ? "text-cyan" : "text-ink"}`}>
                  Phase {p.n} — {p.name}
                </span>
                <span className="block text-[11.5px] text-muted">{p.items}</span>
              </span>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}

function ManeuverReports() {
  const can = useCan();
  const plans = useAsync(() => (can("reports:read") && can("twin:read") ? api.plans() : Promise.resolve(null)), []);
  if (!can("reports:read") || !can("twin:read")) return null;
  const done = (plans.data ?? []).filter((p) => p.status === "succeeded");
  return (
    <Panel title="Technical maneuver reports" subtitle="Inputs, provenance, models, candidates, selection, validation and limitations: one printable page per plan" className="mb-4" bodyClassName="p-0">
      {plans.error ? <ErrorState message={plans.error} /> : !plans.data ? <LoadingState /> : done.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-ink-2">No finished maneuver plans yet. <Link to="/maneuvers" className="text-cyan hover:underline">Plan one →</Link></p>
      ) : (
        <ul className="divide-y divide-line-2">
          {done.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-[12px]">
              <span className="num text-ink-2">#{p.id}</span>
              <span className="min-w-[160px] flex-1 text-ink">{p.twin_name}</span>
              <span className="text-ink-2">{p.method}</span>
              <span className={p.result_status === "selected" ? "text-ok" : "text-warn"}>{p.result_status}</span>
              <span className="num text-[11px] text-muted">{utc(p.finished_at ?? p.created_at, false)}</span>
              <a className="text-cyan hover:underline" href={`/api/v1/reports/${p.id}`} target="_blank" rel="noreferrer">Open report ↗</a>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function ReportsAudit() {
  const runs = useAsync(() => api.runs(200), [], 15000);
  const activity = useAsync(() => api.activity(100), [], 15000);
  return (
    <div>
      <PageHeader eyebrow="Research" title="REPORTS & AUDIT" subtitle="Reproducible maneuver reports, every ingestion and its outcome, and the audit trail." />
      <ManeuverReports />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel title="Data ingestion history" bodyClassName="p-0 overflow-x-auto max-h-[70vh]">
          {runs.error ? <ErrorState message={runs.error} onRetry={runs.reload} /> : !runs.data ? <LoadingState /> : <RunsTable runs={runs.data} />}
        </Panel>
        <Panel title="Audit trail" bodyClassName="p-4 max-h-[70vh] overflow-y-auto">
          {activity.error ? (
            <ErrorState message={activity.error} />
          ) : !activity.data ? (
            <LoadingState />
          ) : (
            <ol className="space-y-3">
              {activity.data.map((a) => (
                <li key={a.id} className="border-l-2 border-line pl-3">
                  <div className="num text-[10.5px] text-muted">{utc(a.at)} · {a.kind}</div>
                  <div className="text-[11.5px] text-ink">{a.message}</div>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>
    </div>
  );
}

export function NotFound() {
  return (
    <div className="panel p-8 text-center">
      <p className="text-ink">Page not found.</p>
      <Link to="/" className="mt-2 inline-block text-cyan hover:underline">
        Back to Mission Overview
      </Link>
    </div>
  );
}
