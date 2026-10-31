import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ChevronRight, Clock, Cpu, Menu, Search } from "lucide-react";
import { Link } from "react-router-dom";
import { ALL_ITEMS, NAV } from "../nav";
import { api } from "../services/api";
import { simTimeOf, useApp } from "../stores/app";
import type { ObjectRow } from "../types";
import { OrbitBadges } from "./ui";
import { UserMenu } from "./UserMenu";
import { AlertsBell } from "./AlertsBell";
import { RoleBadge } from "../lib/roles";
import { useAuth, useCan } from "../stores/auth";
import { utc } from "../lib/format";
import { useAsync } from "../services/useAsync";
import { MissionStatus } from "./fx/MissionStatus";

function SimClock() {
  const clock = useApp((s) => s.clock);
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 500);
    return () => clearInterval(id);
  }, []);
  const t = simTimeOf(clock);
  const offset = (t - Date.now()) / 1000;
  const live = clock.playing && clock.speed === 1 && Math.abs(offset) < 2;
  return (
    <div className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-line-2 bg-panel/80 px-2.5 py-1" title="Simulation clock used for every propagated position">
      <Clock size={13} className="hidden text-ink-2 sm:block" />
      <span className="num hidden text-[12px] text-ink lg:inline">{utc(new Date(t).toISOString())}</span>
      <span
        className={`rounded px-1.5 py-px text-[9.5px] font-semibold tracking-wider ${live ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn"}`}
        title={live ? "Simulation clock matches wall clock" : "Simulation clock differs from wall clock"}
      >
        {live ? "REAL TIME" : clock.playing ? `SIM ×${clock.speed}` : "PAUSED"}
      </span>
    </div>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ObjectRow[]>([]);
  const [open, setOpen] = useState(false);
  const select = useApp((s) => s.select);
  const nav = useNavigate();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setItems([]);
      return;
    }
    const id = setTimeout(() => {
      api
        .objects({ q, limit: 8 })
        .then((r) => setItems(r.items))
        .catch(() => setItems([]));
    }, 220);
    return () => clearTimeout(id);
  }, [q]);

  useEffect(() => {
    const h = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const choose = (id: number) => {
    select(id);
    setOpen(false);
    setQ("");
    nav("/tracking");
  };

  return (
    <div ref={box} className="relative hidden w-full min-w-[150px] max-w-[400px] sm:block">
      <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
      <input
        className="input w-full pl-8"
        placeholder="Search object name, NORAD ID or COSPAR ID"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => e.key === "Enter" && items[0] && choose(items[0].norad_id)}
        aria-label="Global object search"
      />
      {open && q.trim().length >= 2 && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-lg border border-line bg-elevated shadow-2xl">
          {items.length === 0 ? (
            <div className="px-3 py-2.5 text-[12px] text-muted">No catalog objects match "{q}"</div>
          ) : (
            items.map((it) => (
              <button key={it.norad_id} onClick={() => choose(it.norad_id)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-hover">
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] text-ink">{it.name ?? "Unnamed object"}</span>
                  <span className="num text-[10.5px] text-muted">
                    {it.norad_id} · {it.intl_designator}
                  </span>
                </span>
                <OrbitBadges labels={it.labels} />
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const EXTRA: Record<string, string> = {
  "/admin": "Administration",
  "/org": "Organisation",
  "/mission": "Mission Control",
  "/science": "Research Lab",
  "/operator": "Operator Console",
  "/public": "Public Tracker",
  "/account": "Account & Security",
};

/** Running optimisations, simulations and experiments, from the same list endpoints the pages use. */
function ActiveJobs() {
  const can = useCan();
  const twin = can("twin:read");
  const research = can("research:read");
  const jobs = useAsync(
    async () => {
      const busy = (x: { status: string }) => x.status === "queued" || x.status === "running";
      const [plans, sims, exps] = await Promise.all([
        twin ? api.plans() : Promise.resolve([]),
        twin ? api.simulations() : Promise.resolve([]),
        research ? api.experiments() : Promise.resolve([]),
      ]);
      return { plans: plans.filter(busy).length, sims: sims.filter(busy).length, exps: exps.filter(busy).length };
    },
    [twin, research],
    8000,
  );
  if (!twin && !research) return null;
  const d = jobs.data;
  const n = d ? d.plans + d.sims + d.exps : 0;
  const parts = d ? [d.plans && `${d.plans} optimisation`, d.sims && `${d.sims} simulation`, d.exps && `${d.exps} experiment`].filter(Boolean).join(", ") : "";
  return (
    <span
      className={`hidden shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] lg:flex ${n ? "border-cyan/40 bg-cyan/10 text-cyan" : "border-line-2 bg-panel/70 text-muted"}`}
      title={n ? `Running: ${parts}` : "No optimisation, simulation or experiment is running"}
    >
      <Cpu size={12} className={n ? "animate-pulse" : ""} />
      {n ? `${n} running` : "Idle"}
    </span>
  );
}

export function TopNavigation() {
  const loc = useLocation();
  const me = useAuth((s) => s.me);
  const openNav = useApp((s) => s.setMobileNav);
  const sources = useAsync(() => api.sources(), [], 30000);
  const lastOk =
    (sources.data ?? [])
      .map((s) => s.last_run)
      .filter((r) => r && r.status === "succeeded" && r.finished_at)
      .map((r) => r!.finished_at!)
      .sort()
      .pop() ?? null;
  const extra = Object.entries(EXTRA).find(([p]) => loc.pathname.startsWith(p));
  const item = extra ? { label: extra[1] } : ALL_ITEMS.find((i) => (i.path === "/" ? loc.pathname === "/" : loc.pathname.startsWith(i.path)));
  const group = NAV.find((g) => g.items.some((i) => i.label === item?.label))?.title;
  return (
    <header className="relative z-40 flex h-14 shrink-0 items-center gap-2 border-b border-line-2 bg-app/75 px-3 backdrop-blur-xl sm:gap-3 sm:px-5">
      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-cyan/25 to-transparent" />
      <button className="btn h-8 w-8 justify-center px-0 lg:hidden" onClick={() => openNav(true)} aria-label="Open navigation">
        <Menu size={15} />
      </button>
      <nav aria-label="Breadcrumb" className="hidden shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] md:flex">
        <Link to="/welcome" className="num text-[10.5px] tracking-[0.16em] text-muted hover:text-ink">ORBITGUARD</Link>
        {group && (
          <span className="hidden items-center gap-1.5 2xl:flex">
            <ChevronRight size={12} className="text-muted" />
            <span className="text-muted">{group}</span>
          </span>
        )}
        <ChevronRight size={12} className="text-muted" />
        <span className="font-medium text-ink" aria-current="page">{item?.label ?? "Not found"}</span>
      </nav>
      <div className="flex min-w-0 flex-1 justify-center">
        <GlobalSearch />
      </div>
      <div className="hidden shrink-0 whitespace-nowrap 2xl:block">{me && <RoleBadge role={me.role} />}</div>
      <span className="hidden shrink-0 whitespace-nowrap xl:inline-flex">
        <MissionStatus compact lastSync={lastOk} />
      </span>
      <ActiveJobs />
      <SimClock />
      <AlertsBell />
      <UserMenu />
    </header>
  );
}
