import { motion, useReducedMotion } from "motion/react";
import { EASE } from "../fx/motion";

/**
 * Propellant budget bar: used, usable and reserve propellant, with an optional planned burn
 * highlighted inside the usable part. All values in kg from the twin's configuration.
 */
export function FuelGauge({
  initialKg,
  remainingKg,
  reserveKg,
  plannedKg = 0,
  dvAvailableMs,
  compact = false,
}: {
  initialKg: number;
  remainingKg: number;
  reserveKg: number;
  plannedKg?: number;
  dvAvailableMs?: number;
  compact?: boolean;
}) {
  const reduce = useReducedMotion();
  const total = Math.max(initialKg, remainingKg, 1e-9);
  const used = Math.max(0, initialKg - remainingKg);
  const reserve = Math.min(reserveKg, remainingKg);
  const usable = Math.max(0, remainingKg - reserve);
  const planned = Math.min(plannedKg, usable);
  const pct = (x: number) => `${(100 * x) / total}%`;
  const seg = (w: string, cls: string, style?: React.CSSProperties, delay = 0, title?: string) => (
    <motion.div
      title={title}
      className={`h-full ${cls}`}
      style={style}
      initial={reduce ? false : { width: 0 }}
      animate={{ width: w }}
      transition={{ duration: 0.9, ease: EASE, delay }}
    />
  );
  return (
    <div>
      <div className={`flex overflow-hidden rounded-full border border-line-2 bg-app ${compact ? "h-2.5" : "h-4"}`}>
        {seg(pct(reserve), "", { background: "repeating-linear-gradient(135deg, #F5B94255 0 4px, #F5B94222 4px 8px)" }, 0, `Reserve ${reserve.toFixed(3)} kg`)}
        {seg(pct(usable - planned), "bg-gradient-to-r from-ok/70 to-ok", undefined, 0.08, `Usable ${usable.toFixed(3)} kg`)}
        {planned > 0 && seg(pct(planned), "bg-violet shadow-[0_0_12px_#A78BFA]", undefined, 0.16, `This burn ${(planned * 1000).toFixed(1)} g`)}
        {seg(pct(used), "bg-line", undefined, 0.24, `Used ${used.toFixed(3)} kg`)}
      </div>
      {!compact && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-ink-2">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-ok" /> usable <span className="num text-ink">{usable.toFixed(3)} kg</span></span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-warn/60" /> reserve <span className="num text-ink">{reserve.toFixed(3)} kg</span></span>
          {planned > 0 && <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-violet" /> this burn <span className="num text-ink">{(planned * 1000).toFixed(1)} g</span></span>}
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-line" /> used <span className="num text-ink">{used.toFixed(3)} kg</span></span>
          {dvAvailableMs !== undefined && <span className="ml-auto">Δv available <span className="num text-ink">{dvAvailableMs.toFixed(2)} m/s</span></span>}
        </div>
      )}
    </div>
  );
}
