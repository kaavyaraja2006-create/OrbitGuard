import { Link, useNavigate } from "react-router-dom";
import { Box, Database, Orbit, Radar, ShieldAlert, Trash2 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { GlobeViewer } from "../components/GlobeViewer";
import { ObjectInspector } from "../components/ObjectInspector";
import { TimelineControls } from "../components/TimelineControls";
import { EmptyState, ErrorState, LoadingState, MetricCard, PageHeader, Panel, StatusIndicator } from "../components/ui";
import { api } from "../services/api";
import { useAsync } from "../services/useAsync";
import { useApp } from "../stores/app";
import { useCan } from "../stores/auth";
import { ORBIT_LABELS } from "../types";
import { PriorityBadge, fmtDistance, timeToTca } from "../components/conjunction";
import { utc } from "../lib/format";
import { ago, fmtInt } from "../lib/format";

const LABEL_FILL: Record<string, string> = { LEO: "#4DA3FF", MEO: "#36D6E8", GEO: "#A78BFA", POLAR: "#9AAAC0", SSO: "#35D39A", HEO: "#F5B942" };

export function MissionOverview() {
  const dataVersion = useApp((s) => s.dataVersion);
  const selectedId = useApp((s) => s.selectedId);
  const select = useApp((s) => s.select);
  const stats = useAsync(() => api.stats(), [dataVersion], 30000);
  const sources = useAsync(() => api.sources(), [dataVersion], 10000);
  const can = useCan();
  const canAudit = can("audit:read");
  const canConj = can("conjunction:read");
  // Only ask for what this role may see; the server would refuse the rest.
  const activity = useAsync(() => (canAudit ? api.activity(8) : Promise.resolve(null)), [dataVersion, canAudit], 10000);
  const threats = useAsync(() => (canConj ? api.conjunctions({ upcoming_only: true, latest_run_per_primary: true, limit: 500 }) : Promise.resolve(null)), [dataVersion, canConj], 30000);
  const nav = useNavigate();

  const st = stats.data;
  const empty = st && st.tracked_objects === 0;
  const debris = st ? (st.by_type["DEBRIS"] ?? 0) : null;
  const rb = st ? (st.by_type["ROCKET BODY"] ?? 0) : null;
  const active = st ? (st.by_type["PAYLOAD"] ?? 0) : null;
  const freshPct = st && st.tracked_objects ? Math.round((100 * st.freshness.fresh) / st.tracked_objects) : null;

  return (
    <div>
      <PageHeader
        eyebrow="Mission control"
        title="MISSION OVERVIEW"
        subtitle="Orbital environment from ingested catalog data, propagated with SGP4 at the simulation clock."
        actions={
          can("data:read") ? (
            <Link to="/data" className="btn">
              <Database size={13} /> Manage data
            </Link>
          ) : undefined
        }
      />

      {stats.error && (
        <div className="panel mb-4">
          <ErrorState message={stats.error} onRetry={stats.reload} />
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <MetricCard label="Tracked objects" value={st ? st.tracked_objects : null} icon={<Radar size={15} />} hint={st ? `${fmtInt(st.element_sets_stored)} element sets stored` : " "} />
        <MetricCard label="Payloads" value={active} accent="var(--color-blue)" icon={<Orbit size={15} />} hint="Type from name / group evidence" />
        <MetricCard label="Debris + rocket bodies" value={debris === null ? null : debris + (rb ?? 0)} accent="#C8D3E3" icon={<Trash2 size={15} />} hint={rb !== null ? `${fmtInt(debris)} debris · ${fmtInt(rb)} R/B` : " "} />
        <MetricCard
          label="Fresh element sets"
          value={freshPct}
          unit={freshPct === null ? undefined : "%"}
          accent="var(--color-ok)"
          icon={<Database size={15} />}
          hint={st?.newest_epoch ? `Newest epoch ${ago(st.newest_epoch)}` : "No data yet"}
        />
        <MetricCard
          label="Upcoming conjunctions"
          value={threats.data ? threats.data.length : null}
          accent="var(--color-danger)"
          icon={<ShieldAlert size={15} />}
          hint={threats.data ? `${threats.data.filter((t) => t.priority === "HIGH").length} high priority (< 1 km)` : " "}
        />
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-3">
          <Panel
            title="Space environment"
            subtitle="Click any object to inspect it"
            bodyClassName="p-0"
            actions={
              <Link to="/environment" className="text-[11px] text-cyan hover:underline">
                Full view →
              </Link>
            }
          >
            <div className="tech-grid h-[480px] p-0">
              {empty ? (
                <EmptyState title="No objects to display" icon={<Box size={22} strokeWidth={1.5} />}>
                  Ingest a CelesTrak group (for example <span className="num text-ink">stations</span>) or upload a TLE file from{" "}
                  <Link className="text-cyan hover:underline" to="/data">
                    Data Sources
                  </Link>
                  .
                </EmptyState>
              ) : (
                <GlobeViewer className="h-full" />
              )}
            </div>
          </Panel>
          <TimelineControls />
        </div>

        <div className="flex min-h-[540px] flex-col gap-4">
          <Panel
            title="Conjunction events"
            subtitle="Latest screening per primary, upcoming only"
            bodyClassName="p-0"
            actions={
              <Link to="/threats" className="text-[11px] text-cyan hover:underline">
                All threats →
              </Link>
            }
          >
            {!canConj ? (
              <EmptyState title="Not available for your role">Conjunction screening results are shown to operator, scientist and mission accounts.</EmptyState>
            ) : threats.error ? (
              <ErrorState message={threats.error} onRetry={threats.reload} />
            ) : !threats.data ? (
              <LoadingState />
            ) : threats.data.length === 0 ? (
              <EmptyState title="No upcoming conjunctions" icon={<ShieldAlert size={20} strokeWidth={1.5} />}>
                Run a screening from{" "}
                <Link className="text-cyan hover:underline" to="/collision">
                  Collision Assessment
                </Link>
                . Events appear here once they are calculated.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line-2">
                {threats.data
                  .slice()
                  .sort((a, b) => a.miss_distance_km - b.miss_distance_km)
                  .slice(0, 5)
                  .map((t) => (
                    <li key={t.id}>
                      <button className="w-full px-4 py-2 text-left hover:bg-hover" onClick={() => nav(`/collision?run=${t.run_id}&event=${t.id}`)}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[12px] text-ink">
                            {t.primary_name ?? t.primary_norad_id} × {t.secondary_name ?? t.secondary_norad_id}
                          </span>
                          <PriorityBadge p={t.priority} />
                        </div>
                        <div className="num mt-0.5 text-[10.5px] text-muted">
                          {fmtDistance(t.miss_distance_km)} · {utc(t.tca, false)} · {timeToTca(t.tca, Date.now())}
                        </div>
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </Panel>
          <Panel title="Selected object" className="min-h-[300px] flex-1" bodyClassName="p-0">
            {selectedId === null ? (
              <EmptyState title="Nothing selected">Click an object on the globe or search for one in the top bar.</EmptyState>
            ) : (
              <ObjectInspector id={selectedId} variant="panel" onClose={() => select(null)} />
            )}
          </Panel>
        </div>
      </div>

      {canConj && threats.data && threats.data.length > 0 && (
        <Panel title="Conjunction activity" subtitle="Upcoming events by time to closest approach (latest screening per primary)" className="mb-4" accent="var(--color-danger)">
          <ConjunctionActivity events={threats.data} />
        </Panel>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel
          title="Orbit classification"
          subtitle="Multi-label: one object can count in several bars"
          actions={
            <Link to="/orbits" className="text-[11px] text-cyan hover:underline">
              Details →
            </Link>
          }
        >
          {!st ? (
            <LoadingState />
          ) : empty ? (
            <EmptyState title="No classified objects" />
          ) : (
            <div className="h-[200px]">
              <ResponsiveContainer>
                <BarChart data={ORBIT_LABELS.map((l) => ({ label: l, count: st.by_label[l] ?? 0 }))} margin={{ left: -12, right: 4, top: 6 }}>
                  <CartesianGrid stroke="#1A2639" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: "#9AAAC0", fontSize: 11 }} axisLine={{ stroke: "#223149" }} tickLine={false} />
                  <YAxis tick={{ fill: "#64748B", fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip cursor={{ fill: "#18243A" }} contentStyle={{ background: "#121D30", border: "1px solid #223149", fontSize: 11 }} />
                  <Bar dataKey="count" radius={[3, 3, 0, 0]} animationDuration={900}>
                    {ORBIT_LABELS.map((l) => (
                      <Cell key={l} fill={LABEL_FILL[l]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel title="Data source health" actions={<Link to="/data" className="text-[11px] text-cyan hover:underline">Sources →</Link>}>
          {sources.error ? (
            <ErrorState message={sources.error} onRetry={sources.reload} />
          ) : !sources.data ? (
            <LoadingState />
          ) : sources.data.length === 0 ? (
            <EmptyState title="No sources yet">Nothing has been ingested.</EmptyState>
          ) : (
            <ul className="divide-y divide-line-2">
              {sources.data.map((s) => (
                <li key={s.id} className="flex items-center justify-between py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] text-ink">{s.name}</span>
                    <span className="text-[10.5px] text-muted">{s.provider}</span>
                  </span>
                  <span className="text-right">
                    {s.last_run ? <StatusIndicator status={s.last_run.status} /> : <span className="text-muted">—</span>}
                    <span className="num block text-[10.5px] text-muted">{ago(s.last_run?.finished_at ?? s.last_run?.started_at)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Recent system activity" actions={<Link to="/audit" className="text-[11px] text-cyan hover:underline">Audit →</Link>}>
          {!canAudit ? (
            <EmptyState title="Not available for your role" />
          ) : activity.error ? (
            <ErrorState message={activity.error} onRetry={activity.reload} />
          ) : !activity.data ? (
            <LoadingState />
          ) : activity.data.length === 0 ? (
            <EmptyState title="No activity recorded" />
          ) : (
            <ol className="relative ml-1.5 border-l border-line-2">
              {activity.data.map((a, i) => {
                const c = a.kind.endsWith("failed") ? "var(--color-danger)" : a.kind.endsWith("skipped") ? "var(--color-warn)" : "var(--color-ok)";
                return (
                  <li key={a.id} className="relative mb-3 pl-4 last:mb-0 og-enter" style={{ animationDelay: `${i * 50}ms` }}>
                    <span className="absolute -left-[4.5px] top-1.5 h-2 w-2 rounded-full ring-4 ring-panel" style={{ background: c, boxShadow: `0 0 8px ${c}` }} />
                    <span className="block text-[11.5px] leading-snug text-ink">{a.message}</span>
                    <span className="num text-[10px] text-muted">{ago(a.at)} · {a.kind}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>
      </div>
    </div>
  );
}

const PRIORITY_FILL: Record<string, string> = { HIGH: "#FF647C", MEDIUM: "#F5B942", LOW: "#4DA3FF" };

/** Upcoming conjunctions stacked by priority in 6-hour bins of time to TCA. Real screening output only. */
function ConjunctionActivity({ events }: { events: { tca: string; priority: string }[] }) {
  const now = Date.now();
  const bins = Array.from({ length: 12 }, (_, i) => ({ label: `${i * 6}–${i * 6 + 6} h`, HIGH: 0, MEDIUM: 0, LOW: 0 } as Record<string, number | string>));
  let later = 0;
  for (const e of events) {
    const h = (new Date(e.tca).getTime() - now) / 3.6e6;
    if (h < 0) continue;
    const k = Math.floor(h / 6);
    if (k >= bins.length) later++;
    else bins[k]![e.priority] = ((bins[k]![e.priority] as number) ?? 0) + 1;
  }
  return (
    <div>
      <div className="h-[180px]">
        <ResponsiveContainer>
          <BarChart data={bins} margin={{ left: -14, right: 4, top: 6 }}>
            <CartesianGrid stroke="#1A2639" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: "#64748B", fontSize: 10 }} axisLine={{ stroke: "#223149" }} tickLine={false} />
            <YAxis tick={{ fill: "#64748B", fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip cursor={{ fill: "#18243A" }} contentStyle={{ background: "#121D30", border: "1px solid #223149", fontSize: 11, borderRadius: 8 }} />
            {(["LOW", "MEDIUM", "HIGH"] as const).map((p) => (
              <Bar key={p} dataKey={p} stackId="a" fill={PRIORITY_FILL[p]} radius={p === "HIGH" ? [3, 3, 0, 0] : undefined} animationDuration={900} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-[10.5px] text-muted">HIGH &lt; 1 km, MEDIUM &lt; 5 km, LOW otherwise.{later > 0 && ` ${later} more beyond 72 h.`}</p>
    </div>
  );
}
