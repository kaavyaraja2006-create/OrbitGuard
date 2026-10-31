import { useNavigate } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { PriorityBadge, fmtDistance, timeToTca } from "../components/conjunction";
import { EmptyState, ErrorState, LoadingState, MetricCard, PageHeader, Panel, StatusIndicator } from "../components/ui";
import { api } from "../services/api";
import { useAsync } from "../services/useAsync";
import type { ConjunctionEvent, Priority } from "../types";
import { utc } from "../lib/format";

const RANK: Record<Priority, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export function ThreatMonitoring() {
  const nav = useNavigate();
  const ev = useAsync(() => api.conjunctions({ upcoming_only: true, latest_run_per_primary: true, limit: 1000 }), [], 30000);
  const rows: ConjunctionEvent[] = (ev.data ?? []).slice().sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.tca.localeCompare(b.tca));
  const count = (p: Priority) => rows.filter((r) => r.priority === p).length;
  const primaries = new Set(rows.map((r) => r.primary_norad_id)).size;
  const now = Date.now();

  return (
    <div>
      <PageHeader eyebrow="Safety analysis" title="THREAT MONITORING" subtitle="Upcoming conjunctions from the most recent screening of each primary, ranked by geometric priority then time." />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="High (< 1 km)" value={ev.data ? count("HIGH") : "—"} accent="var(--color-danger)" />
        <MetricCard label="Medium (< 5 km)" value={ev.data ? count("MEDIUM") : "—"} accent="var(--color-warn)" />
        <MetricCard label="Low" value={ev.data ? count("LOW") : "—"} accent="var(--color-ink-2)" />
        <MetricCard label="Primaries screened" value={ev.data ? primaries : "—"} accent="var(--color-cyan)" hint="With upcoming events" />
      </div>
      <Panel title="Upcoming events" bodyClassName="p-0 overflow-x-auto">
        {ev.error ? (
          <ErrorState message={ev.error} onRetry={ev.reload} />
        ) : !ev.data ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <EmptyState title="No upcoming conjunctions" icon={<ShieldAlert size={22} strokeWidth={1.5} />}>
            Either nothing has been screened yet, or no screened primary has a close approach after now. Run a screening from Collision Assessment.
          </EmptyState>
        ) : (
          <table className="w-full min-w-[980px] whitespace-nowrap text-[12px]">
            <thead className="bg-panel">
              <tr className="border-b border-line-2 text-left text-[10px] uppercase tracking-wider text-muted">
                <th className="px-3 py-2 font-semibold">Priority</th>
                <th className="px-3 font-semibold">Primary</th>
                <th className="px-3 font-semibold">Secondary</th>
                <th className="px-3 font-semibold">TCA</th>
                <th className="px-3 text-right font-semibold">Miss</th>
                <th className="px-3 text-right font-semibold">Rel. speed</th>
                <th className="px-3 font-semibold">Data</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="cursor-pointer border-b border-line-2/70 hover:bg-hover" onClick={() => nav(`/collision?run=${e.run_id}&event=${e.id}`)}>
                  <td className="px-3 py-2"><PriorityBadge p={e.priority} /></td>
                  <td className="max-w-[180px] truncate px-3 text-ink">{e.primary_name ?? e.primary_norad_id}</td>
                  <td className="max-w-[200px] truncate px-3 text-ink-2">
                    {e.secondary_name ?? "Unnamed"} <span className="num text-[10.5px] text-muted">#{e.secondary_norad_id}</span>
                  </td>
                  <td className="num px-3 text-[11.5px]">
                    {utc(e.tca)} <span className="block text-[10px] text-muted">{timeToTca(e.tca, now)}</span>
                  </td>
                  <td className="num px-3 text-right text-ink">{fmtDistance(e.miss_distance_km)}</td>
                  <td className="num px-3 text-right">{e.relative_speed_kms.toFixed(2)} km/s</td>
                  <td className="px-3">
                    <StatusIndicator status={e.data_confidence === "adequate" ? "ok" : e.data_confidence === "reduced" ? "degraded" : "failed"} label={e.data_confidence ?? "—"} />
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
