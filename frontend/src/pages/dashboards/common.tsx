import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAuth } from "../../stores/auth";
import { portalByRole } from "../../lib/portals";
import { utc } from "../../lib/format";

export function DashboardHero({ title, children, actions }: { title?: string; children?: ReactNode; actions?: ReactNode }) {
  const me = useAuth((s) => s.me)!;
  const pm = portalByRole(me.role)!;
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return (
    <div className="panel relative mb-4 overflow-hidden px-6 py-5">
      <div className="absolute inset-0 tech-grid opacity-40" />
      <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full blur-3xl" style={{ background: `color-mix(in srgb, ${pm.accent} 18%, transparent)` }} />
      <div className="relative flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-4">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-line" style={{ color: pm.accent, background: `color-mix(in srgb, ${pm.accent} 12%, transparent)` }}>
            <pm.icon size={22} />
          </span>
          <div>
            <div className="text-[10.5px] font-semibold tracking-[0.2em]" style={{ color: pm.accent }}>
              {(title ?? pm.short).toUpperCase()}
            </div>
            <h1 className="text-[22px] font-semibold tracking-tight text-ink">
              {greet}, {me.full_name.split(" ")[0]}
            </h1>
            <div className="mt-0.5 text-[12px] text-ink-2">
              {me.role_label} · {me.organization?.name}
              {me.department ? ` · ${me.department.name}` : ""}
              {me.last_login_at && <span className="text-muted"> · signed in {utc(me.session?.created_at ?? me.last_login_at, false)}</span>}
            </div>
          </div>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children && <div className="relative mt-4">{children}</div>}
    </div>
  );
}

export function QuickLink({ to, icon: Icon, label, hint, accent = "var(--color-cyan)" }: { to: string; icon: LucideIcon; label: string; hint: string; accent?: string }) {
  return (
    <Link to={to} className="group panel flex items-center gap-3 px-4 py-3 transition-colors hover:bg-elevated">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ color: accent, background: `color-mix(in srgb, ${accent} 12%, transparent)` }}>
        <Icon size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-medium text-ink">{label}</span>
        <span className="block truncate text-[11px] text-muted">{hint}</span>
      </span>
      <ArrowRight size={14} className="text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
    </Link>
  );
}
