import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CatalogTable } from "../components/CatalogTable";
import { ObjectInspector } from "../components/ObjectInspector";
import { EmptyState, ErrorState, LoadingState, MetricCard, OrbitBadge, OrbitBadges, PageHeader, Panel } from "../components/ui";
import { api } from "../services/api";
import { useAsync } from "../services/useAsync";
import { useApp } from "../stores/app";
import { ORBIT_LABELS, type OrbitLabel } from "../types";
import { fmtInt } from "../lib/format";
import { OrbitRegimeDiagram } from "../components/viz/OrbitRegimeDiagram";

const ACCENT: Record<OrbitLabel, string> = { LEO: "#4DA3FF", MEO: "#36D6E8", GEO: "#A78BFA", POLAR: "#9AAAC0", SSO: "#35D39A", HEO: "#F5B942" };

function Histogram({ edges, counts, unit, color }: { edges: number[]; counts: number[]; unit: string; color: string }) {
  const data = counts.map((c, i) => {
    const lo = edges[i];
    const hi = edges[i + 1];
    const name = lo < 0 ? `< 0` : hi >= 1e5 ? `> ${lo.toLocaleString()}` : `${lo.toLocaleString()}–${hi.toLocaleString()}`;
    return { name, count: c };
  });
  return (
    <div className="h-[210px]">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ left: -14, right: 4, top: 6, bottom: 22 }}>
          <CartesianGrid stroke="#1A2639" vertical={false} />
          <XAxis dataKey="name" tick={{ fill: "#64748B", fontSize: 9 }} angle={-35} textAnchor="end" interval={0} axisLine={{ stroke: "#223149" }} tickLine={false} />
          <YAxis tick={{ fill: "#64748B", fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: "#18243A" }}
            contentStyle={{ background: "#121D30", border: "1px solid #223149", fontSize: 11 }}
            formatter={(v) => [`${v} objects`, `${unit} bin`]}
          />
          <Bar dataKey="count" fill={color} radius={[2, 2, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function OrbitIntelligence() {
  const dataVersion = useApp((s) => s.dataVersion);
  const selectedId = useApp((s) => s.selectedId);
  const select = useApp((s) => s.select);
  const stats = useAsync(() => api.stats(), [dataVersion]);
  const rules = useAsync(() => api.rules(), []);
  const st = stats.data;
  const r = rules.data;

  return (
    <div>
      <PageHeader eyebrow="Space intelligence" title="ORBIT INTELLIGENCE" subtitle="Six-category multi-label classification computed from SGP4 mean elements. Every label shows the rule that produced it." />

      {stats.error && (
        <div className="panel mb-4">
          <ErrorState message={stats.error} onRetry={stats.reload} />
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <MetricCard
          label="Evaluated"
          value={st ? st.tracked_objects : null}
          accent="var(--color-ink-2)"
          hint={st ? `${fmtInt(st.label_combinations["UNCLASSIFIED"] ?? 0)} fit no label` : " "}
        />
        {ORBIT_LABELS.map((l) => (
          <MetricCard key={l} label={l} value={st ? (st.by_label[l] ?? 0) : null} accent={ACCENT[l]} />
        ))}
      </div>

      <Panel
        title="Orbit regimes"
        subtitle="Compressed radial scale (not to linear scale); counts from the classified catalogue"
        className="mb-4 orbit-grid"
        accent="#36D6E8"
      >
        {!st ? <LoadingState /> : (
          <OrbitRegimeDiagram byLabel={st.by_label} incEdges={st.inclination_histogram.edges_deg} incCounts={st.inclination_histogram.counts} />
        )}
        <p className="mt-2 text-[10.5px] text-muted">Moving dots illustrate Kepler's third law (period ∝ a<sup>1.5</sup>, sped up); they are not individual objects.</p>
      </Panel>

      <div className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_380px]">
        <Panel title="Perigee altitude distribution" subtitle="Latest element set per object">
          {!st ? <LoadingState /> : st.tracked_objects === 0 ? <EmptyState title="No data" /> : <Histogram edges={st.perigee_altitude_histogram.edges_km} counts={st.perigee_altitude_histogram.counts} unit="km" color="#4DA3FF" />}
        </Panel>
        <Panel title="Inclination distribution" subtitle="10° bins">
          {!st ? <LoadingState /> : st.tracked_objects === 0 ? <EmptyState title="No data" /> : <Histogram edges={st.inclination_histogram.edges_deg} counts={st.inclination_histogram.counts} unit="deg" color="#36D6E8" />}
        </Panel>
        <Panel title="Label combinations" subtitle="Overlapping labels counted per object">
          {!st ? (
            <LoadingState />
          ) : Object.keys(st.label_combinations).length === 0 ? (
            <EmptyState title="No data" />
          ) : (
            <ul className="divide-y divide-line-2">
              {Object.entries(st.label_combinations).map(([combo, n]) => (
                <li key={combo} className="flex items-center justify-between py-1.5">
                  {combo === "UNCLASSIFIED" ? <span className="text-[11px] text-muted">UNCLASSIFIED</span> : <OrbitBadges labels={combo.split(" + ") as OrbitLabel[]} />}
                  <span className="num text-[12px] text-ink">{fmtInt(n)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Classification rules" subtitle={r ? `${r.algorithm_version} · thresholds are configurable` : undefined} className="mb-4">
        {rules.error ? (
          <ErrorState message={rules.error} />
        ) : !r ? (
          <LoadingState />
        ) : (
          <div className="grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2 xl:grid-cols-3">
            {[
              ["LEO", `Apogee altitude < ${r.config.leo_max_altitude_km} km (entire orbit below the LEO ceiling).`],
              ["MEO", `Perigee ≥ ${r.config.meo_min_altitude_km} km and apogee < ${(r.constants.geo_altitude_km - r.config.geo_band_km).toFixed(0)} km.`],
              [
                "GEO",
                `Mean motion within ±${r.config.geosync_mean_motion_tol_rev_day} rev/day of one sidereal revolution (${(86400 / r.constants.sidereal_day_s).toFixed(5)} rev/day). Geostationary additionally needs e ≤ ${r.config.geostationary_max_e} and i ≤ ${r.config.geostationary_max_i_deg}°.`,
              ],
              ["POLAR", `|i − 90°| ≤ ${r.config.polar_band_deg}° (project convention).`],
              ["SSO", `First-order J2 nodal rate within ±${r.config.sso_rate_tol_deg_day}°/day of ${r.constants.sso_raan_rate_deg_day.toFixed(4)}°/day: Ω̇ = −(3/2) J₂ n (Rₑ/p)² cos i.`],
              ["HEO", `Eccentricity ≥ ${r.config.heo_min_eccentricity} (project convention, not a universal standard).`],
            ].map(([l, text]) => (
              <div key={l} className="flex gap-3">
                <div className="w-[52px] shrink-0 pt-px">
                  <OrbitBadge label={l as OrbitLabel} />
                </div>
                <p className="text-[12px] leading-relaxed text-ink-2">{text}</p>
              </div>
            ))}
            <div className="md:col-span-2 xl:col-span-3">
              <p className="text-[11px] text-muted">{r.notes.join(" ")}</p>
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Classified objects" bodyClassName="p-0" className="h-[560px]">
        <CatalogTable />
      </Panel>

      {selectedId !== null && <ObjectInspector id={selectedId} onClose={() => select(null)} />}
    </div>
  );
}
