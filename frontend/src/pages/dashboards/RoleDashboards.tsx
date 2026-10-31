import { Link } from "react-router-dom";
import { Activity, Database, FlaskConical, Globe2, Orbit, Radar, Satellite, ShieldAlert, Telescope, Trash2 } from "lucide-react";
import { EmptyState, ErrorState, KV, LoadingState, MetricCard, OrbitBadges, Panel } from "../../components/ui";
import { PriorityBadge, fmtDistance, timeToTca } from "../../components/conjunction";
import { Tabs } from "../../components/Tabs";
import { api } from "../../services/api";
import { useAsync } from "../../services/useAsync";
import { simTimeISO, useApp } from "../../stores/app";
import { useAuth, useCan } from "../../stores/auth";
import { fmt, fmtInt, utc } from "../../lib/format";
import { FleetPanel } from "../admin/FleetPanel";
import { DashboardHero, QuickLink } from "./common";

function FleetConjunctions({ ids }: { ids: number[] }) {
  const ev = useAsync(() => api.conjunctions({ upcoming_only: true, latest_run_per_primary: true, limit: 500 }), [ids.join(",")], 30000);
  const rows = (ev.data ?? []).filter((e) => ids.includes(e.primary_norad_id));
  return (
    <Panel title="Upcoming conjunctions for your satellites" subtitle="Latest screening per satellite. Priority is geometric (miss distance), not probability." bodyClassName="p-0" actions={<Link to="/collision" className="text-[11px] text-cyan hover:underline">Screen →</Link>}>
      {ev.error ? <ErrorState message={ev.error} /> : !ev.data ? <LoadingState /> : rows.length === 0 ? (
        <EmptyState title="No upcoming events">Run a screening on Collision Assessment to populate this.</EmptyState>
      ) : (
        <table className="w-full text-[12px]">
          <tbody>
            {rows.slice(0, 12).map((e) => (
              <tr key={e.id} className="border-b border-line-2/70">
                <td className="px-3 py-2"><PriorityBadge p={e.priority} /></td>
                <td className="px-2 text-ink">{e.primary_name ?? e.primary_norad_id} <span className="text-muted">vs</span> {e.secondary_name ?? e.secondary_norad_id}</td>
                <td className="num px-2 text-right">{fmtDistance(e.miss_distance_km)}</td>
                <td className="num px-3 text-right text-ink-2">{timeToTca(e.tca, Date.now())}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

export function MissionDashboard() {
  const fleet = useAsync(() => api.fleet(), [], 60000);
  const ids = (fleet.data?.satellites ?? []).map((s) => s.norad_id);
  const ev = useAsync(() => api.conjunctions({ upcoming_only: true, latest_run_per_primary: true, limit: 500 }), [], 30000);
  const mine = (ev.data ?? []).filter((e) => ids.includes(e.primary_norad_id));
  const unassigned = (fleet.data?.satellites ?? []).filter((s) => s.assigned_to.length === 0).length;
  return (
    <div>
      <DashboardHero title="Mission control" actions={<><Link to="/collision" className="btn btn-primary"><ShieldAlert size={13} /> Screen a satellite</Link><Link to="/environment" className="btn"><Globe2 size={13} /> 3D environment</Link></>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Fleet satellites" value={fleet.data ? fleet.data.satellites.length : "—"} icon={<Satellite size={15} />} hint={fleet.data ? `${unassigned} without an operator` : " "} />
        <MetricCard label="Upcoming events" value={ev.data ? mine.length : "—"} accent="var(--color-warn)" icon={<Activity size={15} />} hint="From latest screenings" />
        <MetricCard label="High priority" value={ev.data ? mine.filter((e) => e.priority === "HIGH").length : "—"} accent="var(--color-danger)" icon={<ShieldAlert size={15} />} hint="Miss distance < 1 km" />
        <MetricCard label="Operators" value={fleet.data ? fleet.data.operators.length : "—"} accent="var(--color-blue)" icon={<Radar size={15} />} hint="Active in your organisation" />
      </div>
      <Tabs
        tabs={[
          { id: "events", label: "Conjunction picture", content: <FleetConjunctions ids={ids} /> },
          { id: "fleet", label: "Fleet & assignments", content: <FleetPanel /> },
        ]}
      />
    </div>
  );
}

export function ScienceDashboard() {
  const k = useAsync(() => api.kelvinsSummary(), [], 60000);
  const jobs = useAsync(() => api.datasetJobs(8), [], 15000);
  const s = k.data?.summary;
  return (
    <div>
      <DashboardHero title="Research lab" actions={<Link to="/validation" className="btn btn-primary"><FlaskConical size={13} /> Open validation</Link>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Kelvins CDMs" value={s ? fmtInt(s.cdms) : "—"} icon={<Database size={15} />} hint={s ? `${fmtInt(s.events)} events` : "Not imported yet"} />
        <MetricCard label="Mahalanobis within 1 %" value={s?.mahalanobis_rel_error?.within_1pct != null ? fmt(s.mahalanobis_rel_error.within_1pct, 1) : "—"} unit={s ? "%" : undefined} accent="var(--color-ok)" icon={<Telescope size={15} />} hint="Our geometry vs ESA's" />
        <MetricCard label="Pc median |Δ|" value={s?.pc_agreement?.median_abs_dex != null ? fmt(s.pc_agreement.median_abs_dex, 3) : "—"} unit={s ? "dex" : undefined} accent="var(--color-violet)" icon={<FlaskConical size={15} />} hint="log10 Pc vs ESA" />
        <MetricCard label="Within 0.1 dex" value={s?.pc_agreement?.within_0_1_dex_pct != null ? fmt(s.pc_agreement.within_0_1_dex_pct, 1) : "—"} unit={s ? "%" : undefined} accent="var(--color-cyan)" icon={<Activity size={15} />} hint="Share of comparable CDMs" />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Recent dataset jobs" bodyClassName="p-0">
          {jobs.error ? <ErrorState message={jobs.error} /> : !jobs.data ? <LoadingState /> : jobs.data.length === 0 ? <EmptyState title="No jobs yet">Import Kelvins or SOCRATES on the Validation page.</EmptyState> : (
            <table className="w-full text-[12px]">
              <tbody>
                {jobs.data.map((j) => (
                  <tr key={j.id} className="border-b border-line-2/70">
                    <td className="num px-3 py-2 text-ink-2">#{j.id}</td>
                    <td className="px-2 text-ink">{j.kind}</td>
                    <td className="px-2 text-ink-2">{j.status}</td>
                    <td className="num px-3 text-right text-[11px] text-muted">{utc(j.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <div className="space-y-2">
          <QuickLink to="/validation" icon={FlaskConical} label="Validation" hint="Kelvins Pc reconstruction, SOCRATES cross-check" accent="#35D39A" />
          <QuickLink to="/collision" icon={ShieldAlert} label="Collision assessment" hint="Screen, refine TCA, sensitivity of Pc" accent="#F5B942" />
          <QuickLink to="/orbits" icon={Orbit} label="Orbit intelligence" hint="Six-label classification, criteria" accent="#4DA3FF" />
          <QuickLink to="/environment" icon={Globe2} label="Proximity analysis" hint="Multi-satellite nearby-object detection" accent="#36D6E8" />
        </div>
      </div>
    </div>
  );
}

export function OperatorDashboard() {
  const me = useAuth((s) => s.me)!;
  const ids = (me.assigned_satellites ?? []).filter((s) => s.in_catalog).map((s) => s.norad_id);
  const live = useAsync(() => (ids.length ? api.compare(ids, simTimeISO(), 10, null) : Promise.resolve(null)), [ids.join(",")], 15000);
  const select = useApp((s) => s.select);
  return (
    <div>
      <DashboardHero title="Operator console" actions={<Link to="/environment" className="btn btn-primary"><Globe2 size={13} /> Track in 3D</Link>} />
      <Panel title="Your assigned satellites" subtitle="Live SGP4 state at the simulation clock · nearby = objects within 10 km now" bodyClassName="p-0" className="mb-4">
        {ids.length === 0 ? (
          <EmptyState title="No satellites assigned to you yet">Your mission manager or organisation administrator assigns fleet satellites to operators.</EmptyState>
        ) : live.error ? <ErrorState message={live.error} /> : !live.data ? <LoadingState /> : (
          <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2 xl:grid-cols-3">
            {live.data.rows.map((r) => (
              <div key={r.norad_id} className="rounded-lg border border-line-2 bg-app/60 p-3.5">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[13px] font-medium text-ink">{r.name ?? r.norad_id}</div>
                    <div className="num text-[10.5px] text-muted">NORAD {r.norad_id}</div>
                  </div>
                  {r.labels && <OrbitBadges labels={r.labels} />}
                </div>
                {r.status !== "ok" ? <div className="text-[11.5px] text-danger">{r.message ?? r.status}</div> : (
                  <div className="grid grid-cols-2 gap-x-3">
                    <KV k="Altitude"><span className="num">{fmt(r.altitude_km, 1)} km</span></KV>
                    <KV k="Speed"><span className="num">{fmt(r.speed_kms, 3)} km/s</span></KV>
                    <KV k="Lat / lon"><span className="num">{fmt(r.position?.lat_deg, 1)}°, {fmt(r.position?.lon_deg, 1)}°</span></KV>
                    <KV k="Nearby ≤10 km"><span className={`num ${r.nearby_count ? "text-warn" : ""}`}>{r.nearby_count ?? "—"}</span></KV>
                    <KV k="Element age"><span className="num">{r.freshness}</span></KV>
                    <KV k="Period"><span className="num">{fmt(r.period_min, 1)} min</span></KV>
                  </div>
                )}
                <div className="mt-3 flex gap-2">
                  <Link to="/environment" className="btn h-7" onClick={() => select(r.norad_id)}>View & proximity</Link>
                  <Link to="/collision" className="btn h-7">Screen</Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
      <FleetConjunctions ids={ids} />
    </div>
  );
}

export function PublicDashboard() {
  const stats = useAsync(() => api.stats(), [], 60000);
  const famous = useAsync(() => api.search({ q: "", category: "active_satellite", limit: 1 }), []);
  const select = useApp((s) => s.select);
  const can = useCan();
  const picks: [number, string][] = [[25544, "ISS (ZARYA)"], [20580, "Hubble Space Telescope"], [48274, "Tiangong (CSS)"], [43013, "NOAA 20"], [39084, "Landsat 8"], [41866, "GOES 16"]];
  return (
    <div>
      <DashboardHero title="Public tracker" actions={<Link to="/environment" className="btn btn-primary"><Globe2 size={13} /> Open 3D globe</Link>}>
        <p className="max-w-[720px] text-[12.5px] leading-relaxed text-ink-2">
          Every position here is computed with SGP4 from public orbital elements (CelesTrak) at the clock time shown in the top bar. Nothing is simulated without a label. Your account is read-only.
        </p>
      </DashboardHero>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Objects tracked" value={stats.data ? fmtInt(stats.data.tracked_objects) : "—"} icon={<Radar size={15} />} hint={stats.data?.newest_epoch ? `Newest element set ${utc(stats.data.newest_epoch, false)}` : " "} />
        <MetricCard label="Payloads" value={stats.data ? fmtInt(stats.data.by_type["PAYLOAD"] ?? 0) : "—"} accent="var(--color-blue)" icon={<Satellite size={15} />} />
        <MetricCard label="Debris + rocket bodies" value={stats.data ? fmtInt((stats.data.by_type["DEBRIS"] ?? 0) + (stats.data.by_type["ROCKET BODY"] ?? 0)) : "—"} accent="#C8D3E3" icon={<Trash2 size={15} />} hint="Only what public sources publish" />
        <MetricCard label="Active satellites" value={famous.data ? fmtInt(famous.data.total) : "—"} accent="var(--color-ok)" icon={<Orbit size={15} />} hint="Per CelesTrak 'active' list" />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Famous satellites" subtitle="Click to follow it on the globe (if it has been ingested)">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {picks.map(([id, name]) => (
              <Link key={id} to="/environment" onClick={() => select(id)} className="flex items-center justify-between rounded-lg border border-line-2 px-3 py-2.5 hover:bg-hover">
                <span className="text-[12.5px] text-ink">{name}</span>
                <span className="num text-[10.5px] text-muted">{id}</span>
              </Link>
            ))}
          </div>
        </Panel>
        <div className="space-y-2">
          <QuickLink to="/environment" icon={Globe2} label="Space environment" hint="Every object in 3D, nearby-object detection" />
          <QuickLink to="/orbits" icon={Orbit} label="Orbit intelligence" hint="LEO, MEO, GEO, polar, sun-synchronous, HEO" accent="#4DA3FF" />
          <QuickLink to="/tracking" icon={Radar} label="Satellite catalogue" hint="Search and inspect any object" accent="#A78BFA" />
          {!can("conjunction:read") && <p className="px-1 pt-2 text-[11px] leading-relaxed text-muted">Collision assessment and research tools are available to operator, scientist and mission accounts issued by an organisation.</p>}
        </div>
      </div>
    </div>
  );
}
