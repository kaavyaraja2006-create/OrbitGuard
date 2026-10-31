import { NavLink } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { Building2, LayoutDashboard, PanelLeftClose, PanelLeftOpen, ShieldCheck, UserCog, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { navFor } from "../nav";
import type { NavGroup } from "../nav";
import { useAuth } from "../stores/auth";
import { portalByRole } from "../lib/portals";
import { useApp } from "../stores/app";
import { api } from "../services/api";
import { useAsync } from "../services/useAsync";
import { PhaseTag } from "./ui";
import { MissionStatus, StatusLight } from "./fx/MissionStatus";
import { ago } from "../lib/format";

export function Logo({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden className="shrink-0 drop-shadow-[0_0_8px_rgba(54,214,232,0.35)]">
        <defs>
          <radialGradient id="og-logo-earth" cx="35%" cy="32%" r="75%">
            <stop offset="0%" stopColor="#7cc0ff" />
            <stop offset="55%" stopColor="#2f7fdc" />
            <stop offset="100%" stopColor="#123a6b" />
          </radialGradient>
        </defs>
        <circle cx="16" cy="16" r="5.4" fill="url(#og-logo-earth)" />
        <g transform="rotate(-28 16 16)">
          <ellipse cx="16" cy="16" rx="12.5" ry="5.5" fill="none" stroke="#36D6E8" strokeWidth="1.4" strokeOpacity="0.9" />
          <circle r="1.9" fill="#E8EEF7">
            <animateMotion dur="7s" repeatCount="indefinite" path="M 28.5 16 A 12.5 5.5 0 1 1 3.5 16 A 12.5 5.5 0 1 1 28.5 16" />
          </circle>
        </g>
      </svg>
      {!collapsed && (
        <div className="leading-tight">
          <div className="font-display text-[15px] font-bold tracking-[0.2em] text-ink">ORBITGUARD</div>
          <div className="whitespace-nowrap text-[7.5px] font-semibold tracking-[0.14em] text-muted">ORBITAL INTELLIGENCE SYSTEM</div>
        </div>
      )}
    </div>
  );
}

function workspace(perms: string[], role?: string, dashboard?: string): NavGroup {
  const pm = portalByRole(role);
  const items: { path: string; label: string; icon: LucideIcon }[] = [{ path: dashboard ?? "/", label: pm ? `${pm.short}` : "Dashboard", icon: pm?.icon ?? LayoutDashboard }];
  if (perms.includes("users:manage_all") && dashboard !== "/admin") items.push({ path: "/admin", label: "Administration", icon: ShieldCheck });
  if (perms.includes("users:manage_org") && !perms.includes("users:manage_all") && dashboard !== "/org") items.push({ path: "/org", label: "Organisation", icon: Building2 });
  items.push({ path: "/account", label: "Account & security", icon: UserCog });
  return { title: "Workspace", items: items.map((i) => ({ ...i, phase: 1, built: true, summary: "" })) };
}

function groups(perms: string[], role?: string, dashboard?: string): NavGroup[] {
  return [workspace(perms, role, dashboard), ...navFor(perms)];
}

export function AppSidebar() {
  const collapsedPref = useApp((s) => s.sidebarCollapsed);
  const toggle = useApp((s) => s.toggleSidebar);
  const mobileNav = useApp((s) => s.mobileNav);
  const setMobileNav = useApp((s) => s.setMobileNav);
  const dataVersion = useApp((s) => s.dataVersion);
  const me = useAuth((s) => s.me);
  const sources = useAsync(() => api.sources(), [dataVersion], 30000);

  const lastOk =
    (sources.data ?? [])
      .map((s) => s.last_run)
      .filter((r) => r && r.status === "succeeded" && r.finished_at)
      .map((r) => r!.finished_at!)
      .sort()
      .pop() ?? null;

  const body = (collapsed: boolean, mobile: boolean) => (
    <>
      <div className={`flex h-14 items-center border-b border-line-2 ${collapsed ? "justify-center" : "justify-between px-4"}`}>
        <NavLink to="/welcome" title="About ORBITGUARD" aria-label="ORBITGUARD home">
          <Logo collapsed={collapsed} />
        </NavLink>
        {mobile && (
          <button className="btn h-8 w-8 justify-center px-0" onClick={() => setMobileNav(false)} aria-label="Close navigation">
            <X size={15} />
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2.5 py-3" aria-label="Primary">
        {groups(me?.permissions ?? [], me?.role, me?.dashboard).map((g) => (
          <div key={g.title} className="mb-3.5">
            {!collapsed && (
              <div className="flex items-center gap-2 px-2 pb-1.5">
                <span className="num text-[9.5px] font-medium tracking-[0.2em] text-muted">{g.title.toUpperCase()}</span>
                <span className="h-px flex-1 bg-gradient-to-r from-line-2 to-transparent" />
              </div>
            )}
            {g.items.map((it) => (
              <NavLink
                key={it.path}
                to={it.path}
                end={it.path === "/"}
                title={collapsed ? `${it.label}${it.built ? "" : ` (Phase ${it.phase})`}` : it.summary || undefined}
                className={({ isActive }) =>
                  `group relative mb-0.5 flex h-[34px] items-center gap-2.5 rounded-lg text-[12.5px] transition-colors duration-150 ${collapsed ? "justify-center" : "px-2.5"} ${
                    isActive ? "text-ink" : it.built ? "text-ink-2 hover:bg-hover/70 hover:text-ink" : "text-muted hover:bg-hover"
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <motion.span
                        layoutId={mobile ? "nav-active-m" : "nav-active"}
                        className="absolute inset-0 rounded-lg border border-cyan/20 bg-gradient-to-r from-cyan/[0.12] via-elevated to-elevated"
                        transition={{ type: "spring", stiffness: 420, damping: 36 }}
                      >
                        <span className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full bg-cyan shadow-[0_0_8px_rgba(54,214,232,0.8)]" />
                      </motion.span>
                    )}
                    <it.icon size={15} strokeWidth={1.75} className={`relative transition-colors ${isActive ? "text-cyan" : "group-hover:text-ink"}`} />
                    {!collapsed && <span className="relative flex-1 truncate">{it.label}</span>}
                    {!collapsed && !it.built && <PhaseTag phase={it.phase} />}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="border-t border-line-2 p-3">
        {!collapsed ? (
          <div className="space-y-2 rounded-lg border border-line-2 bg-panel/70 px-3 py-2.5">
            <MissionStatus />
            <div className="flex items-center justify-between">
              <span className="text-[10.5px] text-ink-2">Last catalogue sync</span>
              <span className="num text-[10.5px] text-ink">{ago(lastOk)}</span>
            </div>
          </div>
        ) : (
          <div className="flex justify-center py-1">
            <StatusLight tone="ok" size={7} />
          </div>
        )}
        {!mobile && (
          <button className="btn mt-2 w-full justify-center" onClick={toggle} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {collapsed ? <PanelLeftOpen size={14} /> : <><PanelLeftClose size={14} /> Collapse</>}
          </button>
        )}
      </div>
    </>
  );

  return (
    <>
      <aside
        className="relative hidden h-full shrink-0 flex-col border-r border-line-2 bg-sidebar transition-[width] duration-300 ease-out lg:flex"
        style={{ width: collapsedPref ? 72 : 248 }}
      >
        <span className="pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-cyan/20 to-transparent" />
        {body(collapsedPref, false)}
      </aside>
      <AnimatePresence>
        {mobileNav && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <motion.div className="absolute inset-0 bg-black/60 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMobileNav(false)} />
            <motion.aside
              className="absolute inset-y-0 left-0 flex w-[272px] max-w-[86vw] flex-col border-r border-line-2 bg-sidebar"
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              role="dialog"
              aria-label="Navigation"
            >
              {body(false, true)}
            </motion.aside>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
