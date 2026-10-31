import { useEffect, useState } from "react";
import { Pause, Play, RotateCcw } from "lucide-react";
import { simTimeOf, useApp } from "../stores/app";
import { utc } from "../lib/format";

const SPEEDS = [1, 10, 60, 300, 1200];
const RANGE_H = 24;

/** Simulation clock controls. Offsets are relative to the wall clock. */
export function TimelineControls() {
  const clock = useApp((s) => s.clock);
  const { setPlaying, setSpeed, setSimTime, resetToNow } = useApp.getState();
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 500);
    return () => clearInterval(id);
  }, []);

  const t = simTimeOf(clock);
  const offsetH = (t - Date.now()) / 3_600_000;
  const clamped = Math.max(-RANGE_H, Math.min(RANGE_H, offsetH));

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line-2 bg-panel px-3 py-2">
      <button className="btn h-8 w-8 justify-center px-0" onClick={() => setPlaying(!clock.playing)} aria-label={clock.playing ? "Pause" : "Play"}>
        {clock.playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <label className="flex items-center gap-1.5 text-[11px] text-ink-2">
        Speed
        <select className="input h-8 pr-6" value={clock.speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Simulation speed">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              ×{s}
            </option>
          ))}
        </select>
      </label>
      <div className="flex min-w-[220px] flex-1 items-center gap-2">
        <span className="num text-[10px] text-muted">−{RANGE_H}h</span>
        <input
          type="range"
          min={-RANGE_H}
          max={RANGE_H}
          step={0.05}
          value={clamped}
          onChange={(e) => setSimTime(Date.now() + Number(e.target.value) * 3_600_000)}
          className="flex-1 accent-cyan"
          aria-label="Simulation time offset from now"
        />
        <span className="num text-[10px] text-muted">+{RANGE_H}h</span>
      </div>
      <span className="num min-w-[176px] text-[12px] text-ink">{utc(new Date(t).toISOString())}</span>
      <span className="num w-[84px] text-right text-[11px] text-ink-2" title="Offset of the simulation clock from the wall clock">
        {offsetH >= 0 ? "+" : "−"}
        {Math.abs(offsetH) < 48 ? `${Math.abs(offsetH).toFixed(2)} h` : `${(Math.abs(offsetH) / 24).toFixed(1)} d`}
      </span>
      <button className="btn" onClick={resetToNow}>
        <RotateCcw size={13} /> Now
      </button>
    </div>
  );
}
