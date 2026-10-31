import type { ReactNode } from "react";

export const EVENT_COLOR = {
  burn: "#A78BFA", // maneuver markers: purple
  tca: "#FF647C",
  avoided: "#35D39A",
  info: "#4DA3FF",
  warn: "#F5B942",
} as const;
export type EventKind = keyof typeof EVENT_COLOR;

/** A labelled event pill (burn, closest approach, alert). `active` adds a soft pulse. */
export function EventIndicator({
  kind,
  children,
  active = false,
  onClick,
  title,
}: {
  kind: EventKind;
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  const c = EVENT_COLOR[kind];
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      onClick={onClick}
      title={title}
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-colors ${onClick ? "hover:bg-hover" : ""}`}
      style={{ borderColor: `color-mix(in srgb, ${c} 55%, transparent)`, color: c, background: active ? `color-mix(in srgb, ${c} 14%, transparent)` : "transparent" }}
    >
      <span className="relative inline-flex h-1.5 w-1.5">
        {active && <span className="absolute inset-0 rounded-full animate-pulse-ring" style={{ background: c }} />}
        <span className="relative h-1.5 w-1.5 rounded-full" style={{ background: c }} />
      </span>
      {children}
    </Tag>
  );
}
