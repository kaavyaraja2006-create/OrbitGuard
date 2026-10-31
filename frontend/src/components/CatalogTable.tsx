import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { api } from "../services/api";
import { useAsync } from "../services/useAsync";
import { useApp } from "../stores/app";
import { ORBIT_LABELS } from "../types";
import { EmptyState, ErrorState, FreshnessBadge, LoadingState, OrbitBadges, TypeBadge } from "./ui";
import { ageDays, fmt } from "../lib/format";

type SortKey = "norad_id" | "name" | "perigee_alt_km" | "apogee_alt_km" | "mean_i_deg" | "mean_e" | "period_min" | "age_days";

const COLS: { key: SortKey | null; label: string; align?: "right" }[] = [
  { key: "name", label: "Object" },
  { key: "norad_id", label: "NORAD", align: "right" },
  { key: null, label: "Type" },
  { key: null, label: "Orbit labels" },
  { key: "perigee_alt_km", label: "Perigee alt", align: "right" },
  { key: "apogee_alt_km", label: "Apogee alt", align: "right" },
  { key: "mean_i_deg", label: "Incl.", align: "right" },
  { key: "mean_e", label: "Ecc.", align: "right" },
  { key: "period_min", label: "Period", align: "right" },
  { key: "age_days", label: "Data age", align: "right" },
];

export interface CatalogFilters {
  q: string;
  object_type: string;
  label: string;
  freshness: string;
}

export function CatalogTable({
  initial,
  lockedTypes,
  pageSize = 25,
}: {
  initial?: Partial<CatalogFilters>;
  lockedTypes?: string[];
  pageSize?: number;
}) {
  const [f, setF] = useState<CatalogFilters>({ q: "", object_type: "", label: "", freshness: "", ...initial });
  const [sort, setSort] = useState<{ key: SortKey; order: "asc" | "desc" }>({ key: "norad_id", order: "asc" });
  const [page, setPage] = useState(0);
  const [q, setQ] = useState(f.q);
  const select = useApp((s) => s.select);
  const selectedId = useApp((s) => s.selectedId);
  const dataVersion = useApp((s) => s.dataVersion);

  useEffect(() => {
    const id = setTimeout(() => setF((x) => ({ ...x, q })), 250);
    return () => clearTimeout(id);
  }, [q]);
  useEffect(() => setPage(0), [f, sort]);

  const { data, error, loading, reload } = useAsync(
    () => api.objects({ ...f, object_type: f.object_type || (lockedTypes ? lockedTypes.join(",") : ""), sort: sort.key, order: sort.order, limit: pageSize, offset: page * pageSize }),
    [f, sort, page, dataVersion],
  );

  const typeOptions = lockedTypes ?? ["PAYLOAD", "ROCKET BODY", "DEBRIS", "UNKNOWN"];
  const pages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line-2 px-4 py-2.5">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input className="input w-[220px] pl-7" placeholder="Name, NORAD or COSPAR" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter objects" />
        </div>
        <select className="input" value={f.object_type} onChange={(e) => setF({ ...f, object_type: e.target.value })} aria-label="Object type">
          <option value="">{lockedTypes ? "Debris + rocket bodies + unknown" : "All types"}</option>
          {typeOptions.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} aria-label="Orbit label">
          <option value="">All orbit labels</option>
          {ORBIT_LABELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <select className="input" value={f.freshness} onChange={(e) => setF({ ...f, freshness: e.target.value })} aria-label="Data freshness">
          <option value="">Any data age</option>
          <option value="fresh">Fresh (≤ 3 d)</option>
          <option value="aging">Aging (3–14 d)</option>
          <option value="stale">Stale (&gt; 14 d)</option>
        </select>
        <span className="ml-auto num text-[11px] text-ink-2">{data ? `${data.total.toLocaleString()} objects` : ""}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !data && loading ? (
          <LoadingState />
        ) : data && data.items.length === 0 ? (
          <EmptyState title="No objects match">
            {f.q || f.label || f.object_type || f.freshness ? "Try clearing filters." : "The catalog is empty. Ingest a CelesTrak group or upload TLEs from Data Sources."}
          </EmptyState>
        ) : (
          <table className="w-full min-w-[960px] text-[12px]">
            <thead className="sticky top-0 z-10 bg-panel">
              <tr className="border-b border-line-2">
                {COLS.map((c) => (
                  <th key={c.label} className={`px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted ${c.align === "right" ? "text-right" : "text-left"}`}>
                    {c.key ? (
                      <button
                        className="inline-flex items-center gap-1 hover:text-ink"
                        onClick={() => setSort((s) => ({ key: c.key!, order: s.key === c.key && s.order === "asc" ? "desc" : "asc" }))}
                      >
                        {c.label}
                        {sort.key === c.key && (sort.order === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.items.map((r) => (
                  <tr
                    key={r.norad_id}
                    onClick={() => select(r.norad_id)}
                    className={`cursor-pointer border-b border-line-2/70 hover:bg-hover ${selectedId === r.norad_id ? "bg-elevated" : ""}`}
                  >
                    <td className="max-w-[220px] truncate px-3 py-1.5 text-ink">
                      {selectedId === r.norad_id && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-cyan" />}
                      {r.name ?? <span className="text-muted">Unnamed</span>}
                    </td>
                    <td className="num px-3 text-right text-ink-2">{r.norad_id}</td>
                    <td className="px-3"><TypeBadge t={r.object_type} /></td>
                    <td className="px-3"><OrbitBadges labels={r.labels} /></td>
                    <td className="num px-3 text-right">{fmt(r.perigee_alt_km, 1)} <span className="text-muted">km</span></td>
                    <td className="num px-3 text-right">{fmt(r.apogee_alt_km, 1)} <span className="text-muted">km</span></td>
                    <td className="num px-3 text-right">{fmt(r.mean_i_deg, 2)}°</td>
                    <td className="num px-3 text-right">{r.mean_e.toFixed(5)}</td>
                    <td className="num px-3 text-right">{fmt(r.period_min, 1)} <span className="text-muted">min</span></td>
                    <td className="px-3 text-right">
                      <span className="inline-flex items-center gap-2">
                        <span className="num text-ink-2">{ageDays(r.age_days)}</span>
                        <FreshnessBadge f={r.freshness} />
                      </span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-line-2 px-4 py-2 text-[11px] text-ink-2">
        <span>
          Page <span className="num text-ink">{page + 1}</span> of <span className="num text-ink">{pages}</span>
        </span>
        <div className="flex gap-1.5">
          <button className="btn h-7" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
            <ChevronLeft size={13} />
          </button>
          <button className="btn h-7" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
            <ChevronRight size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
