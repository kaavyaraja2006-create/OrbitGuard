import { api } from "../../services/api";
import { useAsync } from "../../services/useAsync";
import { ago } from "../../lib/format";

const TONE = { ok: "#35D39A", warn: "#F5B942", bad: "#FF647C", idle: "#64748B" } as const;

/** Pulsing status light. Purely presentational; the caller decides the tone from real state. */
export function StatusLight({ tone, size = 8 }: { tone: keyof typeof TONE; size?: number }) {
  const c = TONE[tone];
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {tone !== "idle" && <span className="absolute inset-0 rounded-full animate-pulse-ring" style={{ background: c }} />}
      <span className="relative rounded-full" style={{ width: size, height: size, background: c, boxShadow: `0 0 10px ${c}` }} />
    </span>
  );
}

/**
 * API health + last successful catalogue sync, from /health and /ingestion/sources.
 * `compact` renders a single pill for the top bar.
 */
export function MissionStatus({ compact = false, lastSync }: { compact?: boolean; lastSync?: string | null }) {
  const health = useAsync(() => api.health(), [], 15000);
  const tone: keyof typeof TONE = health.error ? "bad" : !health.data ? "idle" : health.data.status === "ok" ? "ok" : "warn";
  const label = health.error ? "API unreachable" : !health.data ? "Checking" : health.data.status === "ok" ? "Systems nominal" : "Degraded";
  if (compact)
    return (
      <span className="flex items-center gap-2 rounded-full border border-line-2 bg-panel/70 px-2.5 py-1 text-[11px] text-ink-2" title={`API: ${label}`}>
        <StatusLight tone={tone} size={6} />
        <span className="hidden 2xl:inline">{label}</span>
        {lastSync !== undefined && (
          <span className="num text-[10.5px] text-muted">
            <span className="hidden 2xl:inline">· </span>sync {ago(lastSync)}
          </span>
        )}
      </span>
    );
  return (
    <div className="flex items-center gap-2.5">
      <StatusLight tone={tone} />
      <span className="text-[12px] text-ink">{label}</span>
      {lastSync !== undefined && <span className="num text-[11px] text-muted">last sync {ago(lastSync)}</span>}
    </div>
  );
}
