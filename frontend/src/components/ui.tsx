import type { ReactNode } from "react";
import { AlertTriangle, CircleDashed, Inbox } from "lucide-react";
import type { Freshness, ObjectType, OrbitLabel } from "../types";
import { AnimatedHeading } from "./fx/AnimatedHeading";
import { AnimatedMetric } from "./fx/AnimatedMetric";

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = "",
  bodyClassName = "p-4",
  accent,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** optional accent colour for the top hairline */
  accent?: string;
}) {
  return (
    <section className={`panel og-enter flex min-w-0 flex-col ${className}`}>
      {accent && <span className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-xl" style={{ background: `linear-gradient(90deg, ${accent}, transparent 70%)` }} />}
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line-2 px-4 py-2.5">
          <div className="min-w-0">
            {title && <h2 className="label-caps flex items-center gap-2 text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 truncate text-[11px] text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: string; subtitle?: string; actions?: ReactNode; eyebrow?: string }) {
  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          {eyebrow && <div className="eyebrow mb-1.5 animate-fade-in">{eyebrow}</div>}
          <AnimatedHeading text={title} className="font-display text-[24px] font-semibold leading-tight tracking-[0.03em] text-ink sm:text-[27px]" step={0.05} />
          {subtitle && <p className="mt-1.5 max-w-3xl animate-fade-in text-[12.5px] leading-relaxed text-ink-2 [animation-delay:200ms]">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="divider-glow mt-4" />
    </div>
  );
}

export function MetricCard({
  label,
  value,
  unit,
  hint,
  icon,
  accent = "var(--color-blue)",
  format,
}: {
  label: string;
  /** numbers count up when they come into view; null shows an em dash */
  value: ReactNode | number | null;
  unit?: string;
  hint?: ReactNode;
  icon?: ReactNode;
  accent?: string;
  format?: (v: number) => string;
}) {
  return (
    <div className="panel panel-glow og-enter group relative overflow-hidden px-4 py-3.5">
      <span className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, ${accent}, transparent 70%)` }} />
      <span className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full opacity-[0.07] blur-2xl transition-opacity group-hover:opacity-[0.16]" style={{ background: accent }} />
      <div className="flex items-center justify-between">
        <span className="label-caps">{label}</span>
        {icon && <span style={{ color: accent }}>{icon}</span>}
      </div>
      <div className="mt-2.5 flex items-baseline gap-1.5">
        <span className="num text-[27px] font-medium leading-none text-ink">
          {typeof value === "number" || value === null ? <AnimatedMetric value={value as number | null} format={format} /> : value}
        </span>
        {unit && <span className="text-[11px] text-ink-2">{unit}</span>}
      </div>
      {hint && <div className="mt-1.5 text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

const STATUS_STYLE: Record<string, { color: string; label: string }> = {
  ok: { color: "var(--color-ok)", label: "Operational" },
  succeeded: { color: "var(--color-ok)", label: "Succeeded" },
  running: { color: "var(--color-cyan)", label: "Running" },
  queued: { color: "var(--color-ink-2)", label: "Queued" },
  skipped: { color: "var(--color-warn)", label: "Skipped" },
  degraded: { color: "var(--color-warn)", label: "Degraded" },
  failed: { color: "var(--color-danger)", label: "Failed" },
  offline: { color: "var(--color-danger)", label: "Unreachable" },
  fresh: { color: "var(--color-ok)", label: "Fresh" },
  aging: { color: "var(--color-warn)", label: "Aging" },
  stale: { color: "var(--color-danger)", label: "Stale" },
  "future-epoch": { color: "var(--color-violet)", label: "Future epoch" },
};

export function StatusIndicator({ status, label }: { status: string; label?: string }) {
  const s = STATUS_STYLE[status] ?? { color: "var(--color-muted)", label: status };
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px]" style={{ color: s.color }}>
      <span className="relative inline-flex h-1.5 w-1.5">
        {status === "running" && <span className="absolute inset-0 animate-ping rounded-full opacity-60" style={{ background: s.color }} />}
        <span className="relative h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
      </span>
      {label ?? s.label}
    </span>
  );
}

export function FreshnessBadge({ f }: { f: Freshness }) {
  return <StatusIndicator status={f} />;
}

const LABEL_COLOR: Record<OrbitLabel, string> = {
  LEO: "#4DA3FF",
  MEO: "#36D6E8",
  GEO: "#A78BFA",
  POLAR: "#9AAAC0",
  SSO: "#35D39A",
  HEO: "#F5B942",
};

export function OrbitBadge({ label }: { label: OrbitLabel }) {
  const c = LABEL_COLOR[label];
  return (
    <span
      className="num inline-flex h-[18px] items-center rounded px-1.5 text-[10px] font-medium tracking-wide"
      style={{ color: c, background: `color-mix(in srgb, ${c} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 35%, transparent)` }}
    >
      {label}
    </span>
  );
}

export function OrbitBadges({ labels }: { labels: OrbitLabel[] }) {
  if (!labels.length) return <span className="text-[11px] text-muted">UNCLASSIFIED</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {labels.map((l) => (
        <OrbitBadge key={l} label={l} />
      ))}
    </span>
  );
}

export const TYPE_COLOR: Record<ObjectType, string> = {
  PAYLOAD: "#4DA3FF",
  "ROCKET BODY": "#A78BFA",
  DEBRIS: "#C8D3E3",
  UNKNOWN: "#64748B",
};

export function TypeBadge({ t }: { t: ObjectType }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-2">
      <span className="h-2 w-2 rounded-[2px]" style={{ background: TYPE_COLOR[t] }} />
      {t}
    </span>
  );
}

export function ScientificValue({ value, unit, digits = 3, className = "" }: { value: number | null | undefined; unit?: string; digits?: number; className?: string }) {
  const v =
    value === null || value === undefined || Number.isNaN(value)
      ? "—"
      : Math.abs(value) !== 0 && (Math.abs(value) < 1e-3 || Math.abs(value) >= 1e7)
        ? value.toExponential(digits)
        : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (
    <span className={`num text-ink ${className}`}>
      {v}
      {unit && <span className="ml-1 text-[10.5px] text-muted">{unit}</span>}
    </span>
  );
}

export function KV({ k, children, title }: { k: string; children: ReactNode; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[5px]" title={title}>
      <span className="shrink-0 text-[11.5px] text-ink-2">{k}</span>
      <span className="min-w-0 truncate text-right text-[12px]">{children}</span>
    </div>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <span className="text-muted">{icon ?? <Inbox size={22} strokeWidth={1.5} />}</span>
      <p className="text-[12.5px] font-medium text-ink">{title}</p>
      {children && <div className="max-w-sm text-[11.5px] leading-relaxed text-ink-2">{children}</div>}
    </div>
  );
}

/** Orbital loader: a satellite circling a small Earth (static under reduced motion). */
export function OrbitLoader({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <circle cx="12" cy="12" r="4" fill="#4DA3FF" opacity="0.85" />
      <ellipse cx="12" cy="12" rx="10" ry="4.2" fill="none" stroke="#36D6E8" strokeOpacity="0.35" strokeWidth="1" transform="rotate(-25 12 12)" />
      <g transform="rotate(-25 12 12)">
        <circle r="1.6" fill="#E8EEF7">
          <animateMotion dur="1.4s" repeatCount="indefinite" path="M 22 12 A 10 4.2 0 1 1 2 12 A 10 4.2 0 1 1 22 12" />
        </circle>
      </g>
    </svg>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[100px] items-center justify-center gap-2.5 text-[12px] text-ink-2" role="status">
      <OrbitLoader /> {label}…
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex h-full min-h-[100px] flex-col items-center justify-center gap-2 px-6 text-center">
      <AlertTriangle size={18} className="text-danger" />
      <p className="max-w-md text-[12px] text-ink-2">{message}</p>
      {onRetry && (
        <button className="btn mt-1" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function PhaseTag({ phase }: { phase: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-line px-1 py-px text-[9.5px] font-semibold tracking-wider text-muted">
      <CircleDashed size={9} /> P{phase}
    </span>
  );
}
