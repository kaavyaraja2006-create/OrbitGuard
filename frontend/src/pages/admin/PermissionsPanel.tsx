import { useEffect, useState } from "react";
import { Lock, Save } from "lucide-react";
import { ErrorState, LoadingState, Panel } from "../../components/ui";
import { Notice } from "../../components/auth/AuthLayout";
import { api, ApiError } from "../../services/api";
import { useAsync } from "../../services/useAsync";
import { ROLE_COLOR } from "../../lib/roles";
import type { Role } from "../../types/auth";

export function PermissionsPanel() {
  const m = useAsync(() => api.adminRoles(), []);
  const [draft, setDraft] = useState<Record<string, Set<string>>>({});
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  useEffect(() => {
    if (m.data) setDraft(Object.fromEntries(m.data.roles.map((r) => [r.role, new Set(r.permissions)])));
  }, [m.data]);
  if (m.error) return <ErrorState message={m.error} />;
  if (!m.data) return <LoadingState />;
  const { roles, permissions, editable } = m.data;
  const dirty = (role: Role) => {
    const orig = new Set(roles.find((r) => r.role === role)!.permissions);
    const d = draft[role];
    return !!d && (d.size !== orig.size || [...d].some((p) => !orig.has(p)));
  };
  const toggle = (role: Role, perm: string) =>
    setDraft((d) => {
      const s = new Set(d[role]);
      s.has(perm) ? s.delete(perm) : s.add(perm);
      return { ...d, [role]: s };
    });
  const save = async (role: Role) => {
    try {
      await api.setRolePermissions(role, [...draft[role]!]);
      setMsg({ kind: "ok", text: `Permissions for ${roles.find((r) => r.role === role)!.label} saved. They apply to the next request of every user with that role.` });
      m.reload();
    } catch (e) {
      setMsg({ kind: "error", text: (e as ApiError).message });
    }
  };
  return (
    <Panel title="Role → permission matrix" subtitle={editable ? "Changes take effect immediately, server-side." : "Read-only for your role"} bodyClassName="p-0 overflow-x-auto">
      {msg && <div className="px-3 pt-3"><Notice kind={msg.kind}>{msg.text}</Notice></div>}
      <table className="w-full min-w-[920px] text-[11.5px]">
        <thead>
          <tr className="border-b border-line-2">
            <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted">Permission</th>
            {roles.map((r) => (
              <th key={r.role} className="px-2 py-2 text-center">
                <div className="text-[10.5px] font-semibold" style={{ color: ROLE_COLOR[r.role] }}>{r.label.split(" / ")[0]}</div>
                {editable && r.role !== "super_admin" && (
                  <button className="btn mt-1 h-6 px-2 text-[10.5px]" disabled={!dirty(r.role)} onClick={() => save(r.role)}>
                    <Save size={11} /> Save
                  </button>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {permissions.map((p) => (
            <tr key={p.id} className="border-b border-line-2/60 hover:bg-hover/40">
              <td className="px-3 py-1.5">
                <div className="num text-[11px] text-ink">{p.id}</div>
                <div className="text-[10.5px] text-muted">{p.description}</div>
              </td>
              {roles.map((r) => {
                const fixed = r.role === "super_admin" || p.locked_to_super_admin;
                const on = r.role === "super_admin" || !!draft[r.role]?.has(p.id);
                return (
                  <td key={r.role} className="px-2 text-center">
                    {fixed ? (
                      on ? <span className="text-ok" title="Always granted">●</span> : <Lock size={11} className="mx-auto text-muted" aria-label="Reserved for Super Administrator" />
                    ) : (
                      <input type="checkbox" className="accent-cyan" checked={on} disabled={!editable} onChange={() => toggle(r.role, p.id)} aria-label={`${p.id} for ${r.label}`} />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
