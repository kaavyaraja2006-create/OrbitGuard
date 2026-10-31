import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Bell, CheckCheck, Info, OctagonAlert } from "lucide-react";
import { api } from "../services/api";
import { useCan } from "../stores/auth";
import { ago } from "../lib/format";
import type { AlertItem } from "../types/mission";

const ICON = { info: Info, warning: AlertTriangle, critical: OctagonAlert };
const COLOR = { info: "text-blue", warning: "text-warn", critical: "text-danger" };

/** Alerts raised by the system from real events (screenings, plans, experiments). Never fabricated. */
export function AlertsBell() {
  const can = useCan();
  const nav = useNavigate();
  const [data, setData] = useState<{ unread: number; items: AlertItem[] } | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const allowed = can("alerts:read");
  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    const load = () => api.alerts().then((d) => alive && setData(d)).catch(() => undefined);
    load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [allowed]);
  useEffect(() => {
    const h = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  if (!allowed) return null;
  const unread = data?.unread ?? 0;
  return (
    <div ref={box} className="relative">
      <button className="relative flex h-9 w-9 items-center justify-center rounded-md border border-line-2 bg-panel hover:bg-hover" onClick={() => setOpen((o) => !o)} aria-label={`Alerts (${unread} unread)`}>
        <Bell size={15} className="text-ink-2" />
        {unread > 0 && <span className="num absolute -right-1 -top-1 min-w-[16px] rounded-full bg-danger px-1 text-center text-[9.5px] font-semibold leading-4 text-white">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-1.5 w-[360px] overflow-hidden rounded-lg border border-line bg-elevated shadow-2xl">
          <div className="flex items-center justify-between border-b border-line-2 px-3.5 py-2.5">
            <span className="text-[12.5px] font-semibold text-ink">Alerts</span>
            <button className="flex items-center gap-1 text-[11px] text-ink-2 hover:text-ink" onClick={() => api.alertsReadAll().then(() => api.alerts().then(setData))}><CheckCheck size={12} /> Mark all read</button>
          </div>
          <ul className="max-h-[420px] overflow-y-auto">
            {!data?.items.length && <li className="px-3.5 py-6 text-center text-[12px] text-muted">No alerts. They appear when screenings, maneuver plans or experiments produce something worth knowing.</li>}
            {data?.items.map((a) => {
              const I = ICON[a.severity];
              return (
                <li key={a.id}>
                  <button className={`flex w-full gap-2.5 px-3.5 py-2.5 text-left hover:bg-hover ${a.read ? "opacity-60" : ""}`} onClick={() => { setOpen(false); if (a.link) nav(a.link); }}>
                    <I size={15} className={`mt-0.5 shrink-0 ${COLOR[a.severity]}`} />
                    <span className="min-w-0">
                      <span className="block text-[12px] text-ink">{a.title}</span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-ink-2">{a.message}</span>
                      <span className="num mt-0.5 block text-[10px] text-muted">{ago(a.created_at)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
