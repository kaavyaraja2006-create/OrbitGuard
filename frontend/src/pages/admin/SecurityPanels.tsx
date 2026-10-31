import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { EmptyState, ErrorState, LoadingState, Panel } from "../../components/ui";
import { api } from "../../services/api";
import { useAsync } from "../../services/useAsync";
import { utc } from "../../lib/format";

const KIND_COLOR = (k: string) =>
  k.includes("failed") || k.includes("locked") || k.includes("mismatch") ? "text-danger" : k.startsWith("admin.") ? "text-violet" : k === "auth.login" ? "text-ok" : "text-ink-2";

export function SecurityEventsPanel() {
  const ev = useAsync(() => api.securityEvents(200), [], 20000);
  const [filter, setFilter] = useState("");
  const rows = (ev.data ?? []).filter((e) => !filter || e.kind.includes(filter));
  return (
    <Panel
      title="Security & administration events"
      subtitle="Sign-ins, failures, lockouts, portal mismatches, account and permission changes"
      bodyClassName="p-0 max-h-[65vh] overflow-y-auto"
      actions={
        <>
          <select className="input h-7" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Event filter">
            <option value="">All events</option>
            <option value="login_failed">Failed sign-ins</option>
            <option value="locked">Lockouts</option>
            <option value="portal_mismatch">Wrong portal</option>
            <option value="admin.">Administration</option>
            <option value="password">Password changes</option>
          </select>
          <button className="btn h-7" onClick={ev.reload} aria-label="Refresh"><RefreshCw size={12} /></button>
        </>
      }
    >
      {ev.error ? <ErrorState message={ev.error} /> : !ev.data ? <LoadingState /> : rows.length === 0 ? <EmptyState title="No events" /> : (
        <table className="w-full text-[11.5px]">
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="border-b border-line-2/60 align-top">
                <td className="num whitespace-nowrap px-3 py-2 text-[10.5px] text-muted">{utc(e.at)}</td>
                <td className={`num whitespace-nowrap px-2 py-2 text-[10.5px] ${KIND_COLOR(e.kind)}`}>{e.kind}</td>
                <td className="px-2 py-2 text-ink">
                  {e.message}
                  {"ip" in e.details && <span className="num ml-2 text-[10.5px] text-muted">ip {String(e.details.ip)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

export function OutboxPanel() {
  const mails = useAsync(() => api.outbox(50), [], 15000);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Panel title="Outgoing e-mail" subtitle="Without SMTP, mail is not sent and is printed in the backend console. Links are redacted here so no administrator can use someone else's reset link." bodyClassName="p-0">
      {mails.error ? <ErrorState message={mails.error} /> : !mails.data ? <LoadingState /> : mails.data.length === 0 ? <EmptyState title="No e-mail sent yet" /> : (
        <ul className="divide-y divide-line-2">
          {mails.data.map((m) => (
            <li key={m.id}>
              <button className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-hover/50" onClick={() => setOpen(open === m.id ? null : m.id)}>
                <span className="min-w-0">
                  <span className="block truncate text-[12px] text-ink">{m.subject}</span>
                  <span className="text-[11px] text-muted">to {m.to} · {utc(m.created_at)}</span>
                </span>
                <span className={`rounded px-1.5 text-[10px] ${m.status === "sent" ? "bg-ok/10 text-ok" : m.status === "failed" ? "bg-danger/10 text-danger" : "bg-hover text-ink-2"}`}>{m.status}</span>
              </button>
              {open === m.id && <pre className="num mx-4 mb-3 whitespace-pre-wrap rounded-md bg-app p-3 text-[11px] text-ink-2">{m.body}</pre>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
