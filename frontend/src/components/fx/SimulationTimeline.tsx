import { FastForward, Pause, Play, SkipBack } from "lucide-react";
import { utc } from "../../lib/format";
import { EVENT_COLOR, EventIndicator } from "./EventIndicator";
import type { EventKind } from "./EventIndicator";

export interface TimelineEvent {
  t: number; // seconds from start
  kind: EventKind;
  label: string;
}

/**
 * Playback bar for propagated scenarios: play/pause, speed, UTC readout, a scrubbable track with
 * event markers (burns, closest approaches) and jump buttons. Keyboard: the track is a range input.
 */
export function SimulationTimeline({
  start,
  horizon,
  t,
  onSeek,
  playing,
  onTogglePlay,
  speed,
  speeds = [1, 10, 60, 300, 1200],
  onSpeed,
  events = [],
  onEvent,
  activeEvent,
  compact = false,
}: {
  start: number;
  horizon: number;
  t: number;
  onSeek: (t: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
  speed: number;
  speeds?: number[];
  onSpeed: (s: number) => void;
  events?: TimelineEvent[];
  onEvent?: (e: TimelineEvent, i: number) => void;
  activeEvent?: number | null;
  compact?: boolean;
}) {
  const frac = horizon > 0 ? Math.min(1, Math.max(0, t / horizon)) : 0;
  return (
    <div className="glass rounded-xl p-3 shadow-2xl shadow-black/40">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn h-9 w-9 justify-center rounded-full px-0" onClick={() => onSeek(0)} aria-label="Back to start" title="Back to start">
          <SkipBack size={14} />
        </button>
        <button
          className="btn btn-primary h-9 w-9 justify-center rounded-full px-0"
          onClick={onTogglePlay}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause (space)" : "Play (space)"}
        >
          {playing ? <Pause size={15} /> : <Play size={15} className="translate-x-px" />}
        </button>
        <div className="flex items-center gap-0.5 rounded-lg border border-line-2 bg-app/60 p-0.5" role="group" aria-label="Playback speed">
          <FastForward size={12} className="mx-1 text-muted" />
          {speeds.map((s) => (
            <button
              key={s}
              onClick={() => onSpeed(s)}
              aria-pressed={speed === s}
              className={`num h-7 rounded-md px-2 text-[11px] transition-colors ${speed === s ? "bg-cyan/15 text-cyan" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
            >
              ×{s}
            </button>
          ))}
        </div>
        <div className="ml-1 leading-tight">
          <div className="num text-[12.5px] text-ink">{utc(new Date(start + t * 1000).toISOString())}</div>
          <div className="num text-[10.5px] text-muted">
            T+{(t / 3600).toFixed(2)} h / {(horizon / 3600).toFixed(1)} h
          </div>
        </div>
        {!compact && (
          <div className="ml-auto hidden flex-wrap gap-1.5 md:flex">
            {events.map((e, i) => (
              <EventIndicator key={i} kind={e.kind} active={activeEvent === i} onClick={onEvent ? () => onEvent(e, i) : undefined}>
                {e.label}
              </EventIndicator>
            ))}
          </div>
        )}
      </div>
      <div className="relative mt-3 h-6">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-line-2" />
        <div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-gradient-to-r from-blue to-cyan" style={{ width: `${frac * 100}%` }} />
        {events.map((e, i) => (
          <button
            key={i}
            onClick={onEvent ? () => onEvent(e, i) : undefined}
            className="absolute top-1/2 z-10 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] border border-app transition-transform hover:scale-125"
            style={{ left: `${(e.t / horizon) * 100}%`, background: EVENT_COLOR[e.kind] }}
            title={`${e.label} · T+${(e.t / 3600).toFixed(2)} h`}
            aria-label={`Jump to ${e.label}`}
          />
        ))}
        <span
          className="pointer-events-none absolute top-1/2 z-20 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-cyan bg-app shadow-[0_0_12px_rgba(54,214,232,0.7)]"
          style={{ left: `${frac * 100}%` }}
        />
        <input
          type="range"
          min={0}
          max={horizon}
          step={1}
          value={t}
          onChange={(e) => onSeek(Number(e.target.value))}
          className="absolute inset-0 z-[5] h-full w-full cursor-pointer opacity-0"
          aria-label="Simulation time"
        />
      </div>
    </div>
  );
}
