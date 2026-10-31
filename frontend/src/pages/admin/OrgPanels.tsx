import { useState } from "react";
import { Building2, Plus, Trash2 } from "lucide-react";
import { EmptyState, ErrorState, LoadingState, Panel } from "../../components/ui";
import { Notice } from "../../components/auth/AuthLayout";
import { api, ApiError } from "../../services/api";
import { useAsync } from "../../services/useAsync";
import { utc } from "../../lib/format";
import type { OrgRow } from "../../types/auth";

export function OrganizationsPanel() {
  const orgs = useAsync(() => api.adminOrgs(), []);
  const [name, setName] = useState("");
  const [country, setCountry] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg({ kind: "ok", text: ok });
      orgs.reload();
    } catch (e) {
      setMsg({ kind: "error", text: (e as ApiError).message });
    }
  };
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Panel title="Organisations" bodyClassName="p-0 overflow-x-auto">
        {orgs.error ? <ErrorState message={orgs.error} /> : !orgs.data ? <LoadingState /> : (
          <table className="w-full min-w-[640px] text-[12px]">
            <thead>
              <tr className="border-b border-line-2 text-left text-[10px] uppercase tracking-wider text-muted">
                <th className="px-3 py-2 font-semibold">Organisation</th>
                <th className="px-3 font-semibold">Kind</th>
                <th className="px-3 text-right font-semibold">Users</th>
                <th className="px-3 text-right font-semibold">Fleet</th>
                <th className="px-3 font-semibold">Departments</th>
                <th className="px-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {orgs.data.map((o) => (
                <tr key={o.id} className="border-b border-line-2/70">
                  <td className="px-3 py-2"><div className="text-ink">{o.name}</div><div className="text-[10.5px] text-muted">{o.country ?? "—"} · since {utc(o.created_at, false).slice(0, 10)}</div></td>
                  <td className="px-3 text-ink-2">{o.kind}</td>
                  <td className="num px-3 text-right">{o.users}</td>
                  <td className="num px-3 text-right">{o.fleet_size}</td>
                  <td className="px-3 text-[11px] text-ink-2">{o.departments.map((d) => d.name).join(", ") || "—"}</td>
                  <td className="px-3">
                    {o.kind === "member" ? (
                      <button className={`btn h-7 ${o.is_active ? "" : "border-danger/50 text-danger"}`} onClick={() => run(() => api.updateOrg(o.id, { is_active: !o.is_active }), `${o.name} ${o.is_active ? "suspended" : "reactivated"}`)}>
                        {o.is_active ? "Active · suspend" : "Suspended · reactivate"}
                      </button>
                    ) : (
                      <span className="text-[11px] text-muted">system</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel title="New organisation">
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
        <input className="input mb-2 w-full" placeholder="Name, e.g. Indian Space Research Organisation" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input mb-3 w-full" placeholder="Country (optional)" value={country} onChange={(e) => setCountry(e.target.value)} />
        <button className="btn btn-primary w-full justify-center" disabled={name.trim().length < 2} onClick={() => run(() => api.createOrg(name.trim(), country.trim() || null).then(() => { setName(""); setCountry(""); }), "Organisation created")}>
          <Building2 size={13} /> Create organisation
        </button>
        <p className="mt-3 text-[11px] leading-relaxed text-muted">Suspending an organisation signs nobody out by itself, but every request from its members is refused until it is reactivated.</p>
      </Panel>
    </div>
  );
}

export function DepartmentsPanel({ org, onChange }: { org: OrgRow; onChange: () => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    try {
      await api.createDept(org.id, name.trim());
      setName("");
      onChange();
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };
  return (
    <Panel title="Departments" subtitle={org.name}>
      {err && <Notice kind="error">{err}</Notice>}
      {org.departments.length === 0 ? <EmptyState title="No departments yet" /> : (
        <ul className="mb-3 divide-y divide-line-2">
          {org.departments.map((d) => (
            <li key={d.id} className="flex items-center justify-between py-2 text-[12.5px] text-ink">
              {d.name}
              <button className="text-muted hover:text-danger" title="Delete department" aria-label={`Delete ${d.name}`} onClick={() => api.deleteDept(d.id).then(onChange).catch((e) => setErr((e as ApiError).message))}>
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input className="input flex-1" placeholder="e.g. Flight Dynamics" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn-primary" disabled={name.trim().length < 2} onClick={add}><Plus size={13} /> Add</button>
      </div>
    </Panel>
  );
}
