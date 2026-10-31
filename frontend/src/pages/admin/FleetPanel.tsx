import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Satellite, Trash2, X } from "lucide-react";
import { EmptyState, ErrorState, LoadingState, Panel } from "../../components/ui";
import { Notice } from "../../components/auth/AuthLayout";
import { api, ApiError } from "../../services/api";
import { useAsync } from "../../services/useAsync";
import { useApp } from "../../stores/app";
import type { CatalogItem } from "../../types/proximity";

export function FleetPanel() {
  const fleet = useAsync(() => api.fleet(), []);
  const select = useApp((s) => s.select);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CatalogItem[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (q.trim().length < 2) return setHits([]);
    const id = setTimeout(() => api.search({ q, limit: 6 }).then((r) => setHits(r.items)).catch(() => setHits([])), 200);
    return () => clearTimeout(id);
  }, [q]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg({ kind: "ok", text: ok });
      fleet.reload();
    } catch (e) {
      setMsg({ kind: "error", text: (e as ApiError).message });
    }
  };
  const f = fleet.data;
  return (
    <Panel title="Satellite fleet & operator assignments" subtitle="Operators can screen only the satellites assigned to them; the server enforces this." bodyClassName="p-0">
      {msg && <div className="px-3 pt-3"><Notice kind={msg.kind}>{msg.text}</Notice></div>}
      {f?.can_manage && (
        <div className="relative border-b border-line-2 p-3">
          <input className="input w-full" placeholder="Add a satellite to the fleet: search name or NORAD ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search catalogue" />
          {hits.length > 0 && (
            <div className="absolute inset-x-3 z-20 mt-1 overflow-hidden rounded-lg border border-line bg-elevated shadow-xl">
              {hits.map((h) => (
                <button key={h.norad_id} className="flex w-full items-center justify-between px-3 py-2 text-left text-[12px] hover:bg-hover" onClick={() => { setQ(""); setHits([]); run(() => api.addFleetSat(h.norad_id), `${h.name ?? h.norad_id} added to the fleet`); }}>
                  <span><span className="text-ink">{h.name ?? "Unnamed"}</span> <span className="num text-muted">{h.norad_id}</span></span>
                  <span className="flex items-center gap-1 text-cyan"><Plus size={12} /> Add</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {fleet.error ? <ErrorState message={fleet.error} /> : !f ? <LoadingState /> : f.satellites.length === 0 ? (
        <EmptyState title={f.can_manage ? "No satellites in the fleet yet" : "No satellites assigned to you yet"}>
          {f.can_manage ? "Ingest catalogue data, then add your organisation's satellites above." : "Ask your mission manager or organisation administrator to assign satellites."}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[12px]">
            <thead>
              <tr className="border-b border-line-2 text-left text-[10px] uppercase tracking-wider text-muted">
                <th className="px-3 py-2 font-semibold">Satellite</th>
                <th className="px-3 font-semibold">Assigned operators</th>
                {f.can_manage && <th className="px-3 font-semibold">Assign</th>}
                <th className="px-3 text-right font-semibold" />
              </tr>
            </thead>
            <tbody>
              {f.satellites.map((sat) => {
                const free = f.operators.filter((o) => !sat.assigned_to.some((a) => a.user_id === o.id));
                return (
                  <tr key={sat.norad_id} className="border-b border-line-2/70">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2 text-ink"><Satellite size={13} className="text-cyan" />{sat.name ?? "Not in catalogue"}</div>
                      <div className="num text-[10.5px] text-muted">NORAD {sat.norad_id} · {sat.object_type}</div>
                    </td>
                    <td className="px-3">
                      <div className="flex flex-wrap gap-1">
                        {sat.assigned_to.length === 0 && <span className="text-[11px] text-muted">Unassigned</span>}
                        {sat.assigned_to.map((a) => (
                          <span key={a.assignment_id} className="inline-flex items-center gap-1 rounded bg-blue/10 px-1.5 py-0.5 text-[11px] text-blue">
                            {a.full_name}
                            {f.can_manage && (
                              <button aria-label={`Unassign ${a.full_name}`} className="hover:text-danger" onClick={() => run(() => api.unassign(a.assignment_id), `${a.full_name} unassigned`)}>
                                <X size={11} />
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                    </td>
                    {f.can_manage && (
                      <td className="px-3">
                        <select className="input h-7" value="" onChange={(e) => e.target.value && run(() => api.assign(Number(e.target.value), sat.norad_id), "Operator assigned")} disabled={free.length === 0} aria-label="Assign operator">
                          <option value="">{free.length ? "Assign operator…" : f.operators.length ? "All assigned" : "No operators"}</option>
                          {free.map((o) => (
                            <option key={o.id} value={o.id}>{o.full_name}</option>
                          ))}
                        </select>
                      </td>
                    )}
                    <td className="px-3 text-right">
                      <div className="flex justify-end gap-1">
                        {sat.in_catalog && (
                          <Link to="/environment" className="btn h-7" onClick={() => select(sat.norad_id)}>View</Link>
                        )}
                        {f.can_manage && (
                          <button className="btn h-7 text-danger" aria-label="Remove from fleet" onClick={() => run(() => api.removeFleetSat(sat.norad_id), "Removed from fleet")}>
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
