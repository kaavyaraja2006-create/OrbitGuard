import { useState } from "react";
import { Laptop, LogOut, ShieldCheck } from "lucide-react";
import { ErrorState, KV, LoadingState, PageHeader, Panel } from "../components/ui";
import { Notice } from "../components/auth/AuthLayout";
import { PasswordField, passwordChecks } from "../components/auth/PasswordField";
import { api, ApiError } from "../services/api";
import { useAsync } from "../services/useAsync";
import { useAuth } from "../stores/auth";
import { RoleBadge } from "../lib/roles";
import { ago, utc } from "../lib/format";

export function Account() {
  const me = useAuth((s) => s.me)!;
  const sessions = useAsync(() => api.mySessions(), [], 30000);
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [smsg, setSmsg] = useState<string | null>(null);

  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.changePassword(cur, pw);
      setMsg({ kind: "ok", text: `Password changed. ${r.other_sessions_revoked} other session(s) were signed out.` });
      setCur("");
      setPw("");
      setPw2("");
      sessions.reload();
    } catch (e2) {
      setMsg({ kind: "error", text: (e2 as ApiError).message });
    }
  };

  return (
    <div>
      <PageHeader eyebrow="Workspace" title="ACCOUNT & SECURITY" subtitle="Your identity, role and active sessions" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel title="Profile">
          <div className="mb-3"><RoleBadge role={me.role} /></div>
          <KV k="Name">{me.full_name}</KV>
          <KV k="E-mail">{me.email}</KV>
          <KV k="Organisation">{me.organization?.name}</KV>
          <KV k="Department">{me.department?.name ?? "—"}</KV>
          <KV k="Job title">{me.job_title ?? "—"}</KV>
          <KV k="Portal"><span className="num">/login/{me.portal}</span></KV>
          <KV k="Member since">{utc(me.created_at, false)}</KV>
          {me.assigned_satellites && me.assigned_satellites.length > 0 && (
            <KV k="Assigned satellites">{me.assigned_satellites.map((s) => s.name ?? s.norad_id).join(", ")}</KV>
          )}
          <div className="mt-4">
            <div className="label-caps mb-1.5">Your permissions</div>
            <div className="flex flex-wrap gap-1">
              {me.permissions.map((p) => (
                <span key={p} className="num rounded bg-hover px-1.5 py-0.5 text-[10.5px] text-ink-2">{p}</span>
              ))}
            </div>
          </div>
        </Panel>

        <Panel title="Change password" subtitle="Signs out your other sessions">
          {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
          <form onSubmit={change}>
            <PasswordField value={cur} onChange={setCur} label="Current password" />
            <PasswordField value={pw} onChange={setPw} label="New password" autoComplete="new-password" showStrength email={me.email} name={me.full_name} />
            <PasswordField value={pw2} onChange={setPw2} label="Repeat new password" autoComplete="new-password" />
            <button className="btn btn-primary w-full justify-center" disabled={!cur || pw !== pw2 || !passwordChecks(pw, me.email, me.full_name).every((c) => c.ok)}>
              <ShieldCheck size={13} /> Update password
            </button>
          </form>
        </Panel>

        <Panel
          title="Sessions"
          subtitle={`Idle timeout ${me.session?.idle_timeout_minutes ?? "—"} min · this session expires ${utc(me.session?.expires_at, false)}`}
          bodyClassName="p-0"
          actions={<button className="btn h-7" onClick={() => api.revokeOtherSessions().then((r) => { setSmsg(`${r.revoked} other session(s) signed out`); sessions.reload(); })}><LogOut size={12} /> Sign out others</button>}
        >
          {smsg && <div className="px-3 pt-3"><Notice kind="ok">{smsg}</Notice></div>}
          {sessions.error ? <ErrorState message={sessions.error} /> : !sessions.data ? <LoadingState /> : (
            <ul className="divide-y divide-line-2">
              {sessions.data.map((s) => (
                <li key={s.id} className="flex items-start gap-3 px-4 py-2.5">
                  <Laptop size={15} className={s.active ? "mt-0.5 text-ok" : "mt-0.5 text-muted"} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] text-ink">
                      {s.user_agent?.split(") ")[0]?.split("(")[1] ?? s.user_agent ?? "Unknown client"}
                      {s.current && <span className="ml-1.5 rounded bg-cyan/15 px-1 text-[10px] text-cyan">this device</span>}
                    </div>
                    <div className="num text-[10.5px] text-muted">
                      {s.ip ?? "?"} · started {ago(s.created_at)} · {s.active ? `active ${ago(s.last_seen_at)}` : s.revoked_reason ?? "expired"}
                    </div>
                  </div>
                  {s.active && !s.current && (
                    <button className="btn h-7" onClick={() => api.revokeMySession(s.id).then(sessions.reload)}>Revoke</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
