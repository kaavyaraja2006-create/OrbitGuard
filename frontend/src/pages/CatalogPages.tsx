import { CatalogTable } from "../components/CatalogTable";
import { ObjectInspector } from "../components/ObjectInspector";
import { EmptyState, ErrorState, LoadingState, MetricCard, PageHeader, Panel } from "../components/ui";
import { DensityHeatmap } from "../components/viz/DensityHeatmap";
import { api } from "../services/api";
import { useAsync } from "../services/useAsync";
import { useApp } from "../stores/app";
import { fmtInt } from "../lib/format";

export function SatelliteTracking() {
  const selectedId = useApp((s) => s.selectedId);
  const select = useApp((s) => s.select);
  return (
    <div>
      <PageHeader eyebrow="Space intelligence" title="SATELLITE TRACKING" subtitle="Every catalog object with its latest element set. Select a row to inspect elements, state vectors and provenance." />
      <Panel bodyClassName="p-0" className="h-[calc(100vh-160px)] min-h-[520px]">
        <CatalogTable pageSize={40} />
      </Panel>
      {selectedId !== null && <ObjectInspector id={selectedId} onClose={() => select(null)} />}
    </div>
  );
}

export function DebrisMonitoring() {
  const selectedId = useApp((s) => s.selectedId);
  const select = useApp((s) => s.select);
  const dataVersion = useApp((s) => s.dataVersion);
  const stats = useAsync(() => api.stats(), [dataVersion]);
  const dens = useAsync(() => api.density({ types: "DEBRIS,ROCKET BODY,UNKNOWN", alt_max_km: 2000, alt_bin_km: 50, inc_bin_deg: 5 }), [dataVersion]);
  const st = stats.data;
  return (
    <div>
      <PageHeader
        eyebrow="Space intelligence"
        title="DEBRIS MONITORING"
        subtitle="Cataloged debris, rocket bodies and unidentified objects. Physical properties are not available from TLE sources and are shown as NOT AVAILABLE."
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Cataloged debris" value={st ? (st.by_type["DEBRIS"] ?? 0) : null} accent="#C8D3E3" />
        <MetricCard label="Rocket bodies" value={st ? (st.by_type["ROCKET BODY"] ?? 0) : null} accent="var(--color-violet)" />
        <MetricCard label="Unknown type" value={st ? (st.by_type["UNKNOWN"] ?? 0) : null} accent="var(--color-muted)" hint="No name or group evidence" />
        <MetricCard label="Mass / size known" value="0" accent="var(--color-warn)" hint="ESA DISCOS adapter not yet built" />
      </div>
      <Panel
        title="Where the debris is"
        subtitle="Perigee altitude × inclination, 0–2,000 km, latest element set per object"
        className="mb-4"
        accent="#FF9F43"
      >
        {dens.error ? (
          <ErrorState message={dens.error} onRetry={dens.reload} />
        ) : !dens.data ? (
          <LoadingState />
        ) : dens.data.plotted === 0 ? (
          <EmptyState title="No debris, rocket bodies or unknown objects below 2,000 km">Ingest a debris group from Data Sources to see the distribution.</EmptyState>
        ) : (
          <>
            <DensityHeatmap altEdges={dens.data.alt_edges_km} incEdges={dens.data.inc_edges_deg} counts={dens.data.counts} />
            <p className="mt-1 text-[10.5px] text-muted">
              {fmtInt(dens.data.plotted)} of {fmtInt(dens.data.objects)} objects plotted ({fmtInt(dens.data.outside_range)} above 2,000 km). Dense cells are where debris shares altitude and plane, the regions conjunction screening sees most often.
            </p>
          </>
        )}
      </Panel>
      <Panel bodyClassName="p-0" className="h-[calc(100vh-280px)] min-h-[480px]">
        <CatalogTable lockedTypes={["DEBRIS", "ROCKET BODY", "UNKNOWN"]} pageSize={40} />
      </Panel>
      {selectedId !== null && <ObjectInspector id={selectedId} onClose={() => select(null)} />}
    </div>
  );
}
