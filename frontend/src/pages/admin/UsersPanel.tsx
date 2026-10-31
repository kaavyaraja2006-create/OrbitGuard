import { useMemo, useState } from "react";
import { KeyRound, Lock, LogOut, Pencil, Plus, RefreshCw, Search, Unlock, UserCheck, UserX } from "lucide-react";
import { Modal } from "../../components/Tabs";
import { EmptyState, ErrorState, LoadingState, Panel } from "../../components/ui";
import { Notice } from "../../components/auth/AuthLayout";
import { api, ApiError } from "../../services/api";
import { useAsync } from "../../services/useAsync";
import { ROLE_LABEL, RoleBadge } from "../../lib/roles";
import { ago } from "../../lib/format";
import type { AdminUser, OrgRow, Role } from "../../types/auth";
import { useAuth } from "../../stores/auth";

const ALL_ROLES: Role[] = ["super_admin", "org_admin", "mission_manager", "scientist", "operator", "public"];

export function UsersPanel({ scope }: { scope: "platform" | "organization" }) {
  const me = useAuth((s) => s.me)!;
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [orgFilter, setOrgFilter] = useState("");
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<AdminUser | "new" | null>(null);
  const [flash, setFlash] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const size = 25;
  const users = useAsync(
    () => api.adminUsers({ q, role, status, organization_id: orgFilter ? Number(orgFilter) : undefined, limit: size, offset: page * size }),
    [q, role, status, orgFilter, page],
  );
  const orgs = useAsync(() => api.adminOrgs(), []);
  const matrix = useAsync(() => api.adminRoles(), []);
  const assignable: Role[] = scope === "platform" ? ALL_ROLES : (matrix.data?.org_assignable_roles ?? []);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setFlash(null);
    try {
      const r = await fn();
      setFlash({ kind: "ok", text: (r as { message?: string })?.message ?? ok });
      users.reload();
    } catch (e) {
      setFlash({ kind: "error", text: (e as ApiError).message });
    }
  };

  return (
    <Panel
      title="Users"
      subtitle={scope === "platform" ? "Every account on the platform" : `Accounts in ${me.organization?.name}`}
      bodyClassName="p-0"
      actions={
        <>
          <button className="btn h-7" onClick={users.reload} aria-label="Refresh">
            <RefreshCw size={12} />
          </button>
          <button className="btn btn-primary h-7" onClick={() => setEditing("new")}>
            <Plus size={13} /> New user
          </button>
        </>
      }
    >
      <div className="flex flex-wrap gap-2 border-b border-line-2 p-3">
        <div className="relative min-w-[220px] flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input className="input w-full pl-8" placeholder="Search name or e-mail" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} aria-label="Search users" />
        </div>
        <select className="input" value={role} onChange={(e) => { setRole(e.target.value); setPage(0); }} aria-label="Role filter">
          <option value="">All roles</option>
          {ALL_ROLES.map((r) => (
            <option key={r} value={r}>{ROLE_LABEL[r]}</option>
          ))}
        </select>
        <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }} aria-label="Status filter">
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="inactive">Deactivated</option>
          <option value="locked">Locked</option>
          <option value="unverified">Unverified</option>
        </select>
        {scope === "platform" && (
          <select className="input" value={orgFilter} onChange={(e) => { setOrgFilter(e.target.value); setPage(0); }} aria-label="Organisation filter">
            <option value="">All organisations</option>
            {(orgs.data ?? []).map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        )}
      </div>
      {flash && <div className="px-3 pt-3"><Notice kind={flash.kind}>{flash.text}</Notice></div>}
      {users.error ? (
        <ErrorState message={users.error} onRetry={users.reload} />
      ) : !users.data ? (
        <LoadingState />
      ) : users.data.items.length === 0 ? (
        <EmptyState title="No users match" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-[12px]">
            <thead>
              <tr className="border-b border-line-2 text-left text-[10px] uppercase tracking-wider text-muted">
                <th className="px-3 py-2 font-semibold">User</th>
                <th className="px-3 font-semibold">Role</th>
                <th className="px-3 font-semibold">Organisation</th>
                <th className="px-3 font-semibold">Status</th>
                <th className="px-3 font-semibold">Last sign-in</th>
                <th className="px-3 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.data.items.map((u) => {
                const self = u.id === me.id;
                const locked = !!u.locked_until;
                return (
                  <tr key={u.id} className="border-b border-line-2/70 hover:bg-hover/40">
                    <td className="px-3 py-2">
                      <div className="text-ink">{u.full_name} {self && <span className="text-[10px] text-muted">(you)</span>}</div>
                      <div className="text-[11px] text-muted">{u.email}{u.job_title ? ` · ${u.job_title}` : ""}</div>
                    </td>
                    <td className="px-3"><RoleBadge role={u.role} /></td>
                    <td className="px-3 text-ink-2">
                      {u.organization?.name}
                      {u.department && <div className="text-[10.5px] text-muted">{u.department.name}</div>}
                    </td>
                    <td className="px-3">
                      <div className="flex flex-wrap gap-1">
                        <Pill on={u.is_active} yes="Active" no="Deactivated" />
                        {locked && <span className="rounded bg-warn/15 px-1.5 text-[10px] text-warn">Locked</span>}
                        {!u.email_verified && <span className="rounded bg-hover px-1.5 text-[10px] text-ink-2">Unverified</span>}
                        {u.must_change_password && <span className="rounded bg-hover px-1.5 text-[10px] text-ink-2">Temp. password</span>}
                        {!!u.active_sessions && <span className="rounded bg-ok/10 px-1.5 text-[10px] text-ok">{u.active_sessions} session{u.active_sessions > 1 ? "s" : ""}</span>}
                      </div>
                    </td>
                    <td className="num px-3 text-[11px] text-ink-2">{u.last_login_at ? ago(u.last_login_at) : "never"}</td>
                    <td className="px-3">
                      {u.manageable !== false && (
                        <div className="flex justify-end gap-1">
                          <IconBtn title="Edit" onClick={() => setEditing(u)}><Pencil size={12} /></IconBtn>
                          {locked && <IconBtn title="Unlock" onClick={() => act(() => api.unlockUser(u.id), "Unlocked")}><Unlock size={12} /></IconBtn>}
                          <IconBtn title="E-mail a password link" onClick={() => act(() => api.sendReset(u.id), "Sent")}><KeyRound size={12} /></IconBtn>
                          <IconBtn title="Sign out all sessions" onClick={() => act(() => api.revokeUserSessions(u.id).then((r) => ({ message: `${r.revoked} session(s) signed out` })), "")}><LogOut size={12} /></IconBtn>
                          {!self && (
                            <IconBtn title={u.is_active ? "Deactivate" : "Reactivate"} onClick={() => act(() => api.updateUser(u.id, { is_active: !u.is_active }), u.is_active ? `${u.email} deactivated` : `${u.email} reactivated`)}>
                              {u.is_active ? <UserX size={12} className="text-danger" /> : <UserCheck size={12} className="text-ok" />}
                            </IconBtn>
                          )}
                        </div>
                      )}
                      {u.manageable === false && <div className="flex justify-end text-muted" title="Managed by the platform administrator"><Lock size={12} /></div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="flex items-center justify-between px-3 py-2 text-[11.5px] text-ink-2">
            <span>{users.data.total} user{users.data.total === 1 ? "" : "s"}</span>
            <div className="flex gap-1.5">
              <button className="btn h-7" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</button>
              <button className="btn h-7" disabled={(page + 1) * size >= users.data.total} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </div>
        </div>
      )}
      {editing && (
        <UserEditor
          user={editing === "new" ? null : editing}
          orgs={orgs.data ?? []}
          roles={assignable}
          scope={scope}
          onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            setFlash({ kind: "ok", text });
            users.reload();
          }}
        />
      )}
    </Panel>
  );
}

function Pill({ on, yes, no }: { on: boolean; yes: string; no: string }) {
  return <span className={`rounded px-1.5 text-[10px] ${on ? "bg-ok/10 text-ok" : "bg-danger/10 text-danger"}`}>{on ? yes : no}</span>;
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className="flex h-7 w-7 items-center justify-center rounded-md border border-line-2 text-ink-2 hover:bg-hover hover:text-ink" title={title} aria-label={title} onClick={onClick}>
      {children}
    </button>
  );
}

function UserEditor({ user, orgs, roles, scope, onClose, onSaved }: { user: AdminUser | null; orgs: OrgRow[]; roles: Role[]; scope: string; onClose: () => void; onSaved: (msg: string) => void }) {
  const me = useAuth((s) => s.me)!;
  const self = user?.id === me.id;
  const [email, setEmail] = useState(user?.email ?? "");
  const [name, setName] = useState(user?.full_name ?? "");
  const [title, setTitle] = useState(user?.job_title ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? roles[0] ?? "scientist");
  const [orgId, setOrgId] = useState<number>(user?.organization?.id ?? me.organization?.id ?? 0);
  const [deptId, setDeptId] = useState<number | "">(user?.department?.id ?? "");
  const [mode, setMode] = useState<"invite" | "password">("invite");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const orgChoices = useMemo(() => {
    const kindOk = (o: OrgRow) => (role === "public" ? o.kind === "public" : o.kind !== "public");
    return orgs.filter(kindOk);
  }, [orgs, role]);
  const org = orgs.find((o) => o.id === orgId);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (user) {
        await api.updateUser(user.id, {
          full_name: name,
          job_title: title || null,
          ...(self ? {} : { role, organization_id: orgId }),
          ...(deptId === "" ? { clear_department: true } : { department_id: Number(deptId) }),
        });
        onSaved(`Saved ${user.email}${!self && role !== user.role ? ": role changed, existing sessions signed out" : ""}`);
      } else {
        await api.createUser({
          email,
          full_name: name,
          role,
          organization_id: scope === "platform" ? orgId : undefined,
          department_id: deptId === "" ? null : Number(deptId),
          job_title: title || null,
          initial_password: mode === "password" ? pw : null,
        });
        onSaved(mode === "invite" ? `Invitation e-mailed to ${email}` : `Account created. ${email} must change the password at first sign-in.`);
      }
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={user ? `Edit ${user.full_name}` : "Create user"} onClose={onClose}>
      {err && <Notice kind="error">{err}</Notice>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <L label="E-mail">
          <input className="input w-full" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!!user} />
        </L>
        <L label="Full name">
          <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} />
        </L>
        <L label="Role">
          <select className="input w-full" value={role} onChange={(e) => { const r = e.target.value as Role; setRole(r); setDeptId(""); if (r === "public") setOrgId(orgs.find((o) => o.kind === "public")?.id ?? orgId); }} disabled={self}>
            {(roles.includes(role) ? roles : [role, ...roles]).map((r) => (
              <option key={r} value={r} disabled={!roles.includes(r)}>{ROLE_LABEL[r]}</option>
            ))}
          </select>
        </L>
        <L label="Organisation">
          {scope === "platform" ? (
            <select className="input w-full" value={orgId} onChange={(e) => { setOrgId(Number(e.target.value)); setDeptId(""); }} disabled={self}>
              {orgChoices.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          ) : (
            <input className="input w-full" value={me.organization?.name ?? ""} disabled />
          )}
        </L>
        <L label="Department">
          <select className="input w-full" value={deptId} onChange={(e) => setDeptId(e.target.value === "" ? "" : Number(e.target.value))}>
            <option value="">None</option>
            {(org?.departments ?? []).map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </L>
        <L label="Job title (optional)">
          <input className="input w-full" value={title} onChange={(e) => setTitle(e.target.value)} />
        </L>
      </div>
      {!user && (
        <div className="mt-4 rounded-lg border border-line-2 p-3">
          <div className="label-caps mb-2">Initial access</div>
          <label className="mb-1.5 flex items-start gap-2 text-[12px] text-ink">
            <input type="radio" className="mt-0.5 accent-cyan" checked={mode === "invite"} onChange={() => setMode("invite")} />
            <span>E-mail an invitation link <span className="block text-[11px] text-muted">The user sets their own password. Valid 72 h.</span></span>
          </label>
          <label className="flex items-start gap-2 text-[12px] text-ink">
            <input type="radio" className="mt-0.5 accent-cyan" checked={mode === "password"} onChange={() => setMode("password")} />
            <span>Set a temporary password <span className="block text-[11px] text-muted">Share it securely; it must be changed at first sign-in.</span></span>
          </label>
          {mode === "password" && <input className="input mt-2 w-full" type="text" autoComplete="new-password" placeholder="Temporary password (policy applies)" value={pw} onChange={(e) => setPw(e.target.value)} />}
        </div>
      )}
      {user && !self && role !== user.role && <p className="mt-3 text-[11.5px] text-warn">Changing the role signs this user out everywhere; they'll use the {ROLE_LABEL[role]} portal next time.</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !name.trim() || (!user && !email.includes("@")) || (mode === "password" && !user && pw.length < 10)} onClick={save}>
          {user ? "Save changes" : mode === "invite" ? "Create & send invite" : "Create user"}
        </button>
      </div>
    </Modal>
  );
}

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-ink-2">{label}</span>
      {children}
    </label>
  );
}
