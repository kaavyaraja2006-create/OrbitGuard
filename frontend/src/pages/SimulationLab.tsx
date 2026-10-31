import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Clapperboard, Crosshair, Home, Play, Radar, ShieldCheck } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState, KV, LoadingState, OrbitLoader, Panel } from "../components/ui";
import { Notice } from "../components/auth/AuthLayout";
import { api, ApiError } from "../services/api";
import { useAsync } from "../services/useAsync";
import { useCan } from "../stores/auth";
import { fmt, utc } from "../lib/format";
import type { Simulation } from "../types/mission";
import { SimBadge, tip } from "./DigitalTwin";
import { DEFAULT_LAYERS, dist, fmtKm, SIM_COLORS, stateAt, useSimModel, useSimScene } from "../components/sim/simScene";
import type { SimLayers } from "../components/sim/simScene";
import { SimulationTimeline } from "../components/fx/SimulationTimeline";
import type { TimelineEvent } from "../components/fx/SimulationTimeline";

const COLOR = SIM_COLORS;

export function SimulationLab() {
  const [params, setParams] = useSearchParams();
  const planId = Number(params.get("plan")) || null;
  const plans = useAsync(() => api.plans(), []);
  const done = (plans.data ?? []).filter((p) => p.status === "succeeded" && p.result_status === "selected");
  return (
    <div className="-m-3 flex h-[calc(100%+1.5rem)] flex-col sm:-m-5 sm:h-[calc(100%+2.5rem)]">
      <div className="flex flex-wrap items-center gap-3 border-b border-line-2 bg-app/80 px-4 py-3 backdrop-blur sm:px-5">
        <div className="min-w-0">
          <div className="eyebrow mb-0.5 text-[9.5px]">Simulation</div>
          <h1 className="font-display text-[19px] font-semibold tracking-[0.03em] text-ink">SIMULATION LABORATORY</h1>
          <p className="hidden text-[11.5px] text-ink-2 sm:block">Your satellite before and after the burn. Every position is propagated, then rotated to Earth-fixed coordinates.</p>
        </div>
        {planId && (
          <Link to={`/scenario?plan=${planId}`} className="btn ml-auto">
            <Clapperboard size={13} /> Guided replay
          </Link>
        )}
        <select className={`input h-8 w-full sm:w-auto sm:min-w-[280px] ${planId ? "" : "sm:ml-auto"}`} value={planId ?? ""} onChange={(e) => setParams((p) => { p.set("plan", e.target.value); return p; }, { replace: true })} aria-label="Maneuver plan">
          <option value="">Choose a maneuver plan…</option>
          {done.map((p) => <option key={p.id} value={p.id}>Plan #{p.id} · {p.twin_name} · {fmt((p.dv_ms ?? 0) * 1000, 1)} mm/s</option>)}
        </select>
      </div>
      {!planId ? (
        <div className="p-5"><Panel><EmptyState title="Pick a plan with a selected maneuver" icon={<Radar size={18} />}>{done.length === 0 ? <>Optimise one on <Link to="/maneuvers" className="text-cyan hover:underline">Maneuver Optimization</Link> first.</> : "Its original and modified trajectories, the threats, the maneuver point and the closest approaches are replayed here."}</EmptyState></Panel></div>
      ) : <SimLoader planId={planId} />}
    </div>
  );
}

function SimLoader({ planId }: { planId: number }) {
  const can = useCan();
  const [sim, setSim] = useState<Simulation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "none" | "running" | "ready">("loading");
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const poll = (id: number) =>
      api.simulation(id).then((s) => {
        if (!alive) return;
        if (s.status === "succeeded") { setSim(s); setState("ready"); }
        else if (s.status === "failed") { setErr(s.message); setState("none"); }
        else { setState("running"); timer = window.setTimeout(() => poll(id), 1000); }
      }).catch((e) => alive && setErr((e as ApiError).message));
    setSim(null);
    setState("loading");
    api.simulations(planId).then((list) => {
      if (!alive) return;
      const ok = list.find((x) => x.status === "succeeded") ?? list[0];
      if (ok) poll(ok.id);
      else setState("none");
    }).catch((e) => setErr((e as ApiError).message));
    return () => { alive = false; window.clearTimeout(timer); };
  }, [planId]);
  const start = async () => {
    setErr(null);
    setState("running");
    try {
      const r = await api.createSimulation(planId);
      const poll = async () => {
        const s = await api.simulation(r.simulation_id);
        if (s.status === "succeeded") { setSim(s); setState("ready"); }
        else if (s.status === "failed") { setErr(s.message); setState("none"); }
        else window.setTimeout(poll, 1000);
      };
      poll();
    } catch (e) {
      setErr((e as ApiError).message);
      setState("none");
    }
  };
  if (err && state !== "ready") return <div className="p-5"><Notice kind="error">{err}</Notice></div>;
  if (state === "loading") return <div className="p-5"><LoadingState /></div>;
  if (state === "none")
    return (
      <div className="p-5"><Panel><EmptyState title="No simulation for this plan yet">
        {can("simulation:run") ? <button className="btn btn-primary mt-3" onClick={start}><Play size={13} /> Run high-fidelity simulation</button> : "Your role can't run simulations."}
        <p className="mt-2 text-[11px]">Full force model (J2–J4, drag, Sun, Moon, SRP) with the twin's finite burn.</p>
      </EmptyState></Panel></div>
    );
  if (state === "running" || !sim) return <div className="flex flex-1 items-center justify-center gap-2.5 text-ink-2"><OrbitLoader size={26} /> Propagating trajectories with the full force model…</div>;
  return <Player sim={sim} />;
}

function Player({ sim }: { sim: Simulation }) {
  const host = useRef<HTMLDivElement>(null);
  const m = useSimModel(sim);
  const cfg = sim.config;
  const { horizon, start, man, orig, mod, threats } = m;
  const [layers, setLayers] = useState<SimLayers>(DEFAULT_LAYERS);
  const scene = useSimScene(host, m, layers);
  const [t, setT] = useState<number>(man ? Math.max(0, man.t_s - 600) : 0);
  const tRef = useRef(t);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(60);
  const [follow, setFollow] = useState(false);
  const [chartThreat, setChartThreat] = useState(0);
  const [activeEvent, setActiveEvent] = useState<number | null>(null);

  // ---- animation loop: advance time, move markers, follow camera
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastUi = 0;
    const frame = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (playing) {
        tRef.current = Math.min(horizon, tRef.current + dt * speed);
        if (tRef.current >= horizon) setPlaying(false);
      }
      scene.apply(tRef.current);
      if (follow) scene.camera.lock(scene.activeAt(tRef.current));
      if (now - lastUi > 100) {
        lastUi = now;
        setT(tRef.current);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, horizon, follow, scene.apply]);

  useEffect(() => {
    if (!follow) scene.camera.release();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow]);

  // space bar toggles playback
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const seek = (s: number) => {
    tRef.current = Math.max(0, Math.min(horizon, s));
    setT(tRef.current);
  };

  const events: TimelineEvent[] = useMemo(
    () => [
      ...(man ? [{ t: man.t_s, kind: "burn" as const, label: "Burn" }] : []),
      ...m.tcas.map((c) => ({ t: c.t, kind: "tca" as const, label: `TCA ${c.threat}` })),
    ],
    [man, m.tcas],
  );
  const onEvent = (e: TimelineEvent, i: number) => {
    setActiveEvent(i);
    if (e.kind === "burn") {
      seek(e.t - 120);
      setSpeed(10);
      scene.camera.flyTo(stateAt(orig, e.t), 1_800_000);
    } else {
      const k = m.tcas.findIndex((c) => c.t === e.t);
      seek(e.t - 90);
      setSpeed(1);
      if (k >= 0) setChartThreat(k);
      scene.camera.flyTo(stateAt(orig, e.t), 900_000, 1.6, 0.6, -0.45);
    }
  };

  // ---- readouts and charts
  const pO = stateAt(orig, t);
  const pM = mod ? stateAt(mod, t) : null;
  const alt = (p: number[] | null) => (p ? Math.hypot(p[0]!, p[1]!, p[2]!) - 6378.137 : null);
  const sepData = useMemo(() => {
    const s = cfg.separations;
    const k = Math.min(chartThreat, s.series.length - 1);
    const ser = s.series[k];
    if (!ser) return [];
    const step = Math.max(1, Math.floor(s.t_s.length / 600));
    const out = [];
    for (let i = 0; i < s.t_s.length; i += step) out.push({ t: s.t_s[i] / 3600, before: ser.before_km[i], after: ser.after_km?.[i] ?? null });
    return out;
  }, [cfg.separations, chartThreat]);
  const dmin: number = sim.config?.d_min_km ?? 0.2;

  const LAYER_ROWS: [keyof SimLayers, string, string, boolean][] = [
    ["original", mod ? "Your satellite → path if no burn" : "Trajectory", COLOR.original, true],
    ["modified", "Maneuvered path", COLOR.modified, !!mod],
    ["alternative", "Alternative candidate", COLOR.alternative, !!m.alt],
    ["threats", "Threats", COLOR.threat, true],
    ["vector", "Burn + Δv vector", COLOR.burn, !!man],
    ["tca", "Closest approaches", COLOR.tca, true],
    ["distance", "Live distance to threats", COLOR.tca, true],
    ["labels", "Labels", "#9AAAC0", true],
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
      <div className="relative min-h-[420px] min-w-0 flex-1">
        <div ref={host} className="absolute inset-0" />
        <div className="glass absolute left-3 top-3 z-10 hidden w-[236px] rounded-xl p-3 text-[11.5px] sm:block">
          <div className="label-caps mb-2 flex items-center gap-1.5">Layers <SimBadge /></div>
          {LAYER_ROWS.filter((r) => r[3]).map(([k, l, c]) => (
            <label key={k} className="flex cursor-pointer items-center gap-2 rounded px-1 py-[3px] text-ink hover:bg-hover/60">
              <input type="checkbox" className="accent-cyan" checked={layers[k]} onChange={() => setLayers((s) => ({ ...s, [k]: !s[k] }))} />
              <span className="h-[3px] w-3.5 rounded" style={{ background: k === "original" && mod ? `linear-gradient(90deg, ${COLOR.selected} 50%, ${COLOR.original} 50%)` : c }} />
              {l}
            </label>
          ))}
          <p className="mt-2 border-t border-line-2 pt-2 text-[10px] leading-snug text-muted">
            Cyan: your satellite until the burn. Then green is where it goes, dashed blue where it would have gone. Window: half an orbit back, one ahead.
          </p>
        </div>
        <div className="absolute right-3 top-3 z-10 flex flex-col gap-1.5">
          <button className="btn h-9 w-9 justify-center px-0" title="Reset view" aria-label="Reset view" onClick={() => { setFollow(false); scene.camera.home(); }}><Home size={14} /></button>
          <button className="btn h-9 w-9 justify-center px-0" title="Fly to satellite" aria-label="Fly to satellite" onClick={() => scene.camera.flyTo(scene.activeAt(tRef.current), 1_500_000, 1)}><Crosshair size={14} /></button>
          <button className={`btn h-9 w-9 justify-center px-0 ${follow ? "border-cyan text-cyan" : ""}`} title="Follow satellite" aria-label="Follow satellite" aria-pressed={follow} onClick={() => setFollow((f) => !f)}><Radar size={14} /></button>
        </div>
        <div className="absolute inset-x-3 bottom-3 z-10">
          <SimulationTimeline
            start={start}
            horizon={horizon}
            t={t}
            onSeek={seek}
            playing={playing}
            onTogglePlay={() => setPlaying((p) => !p)}
            speed={speed}
            onSpeed={setSpeed}
            events={events}
            onEvent={onEvent}
            activeEvent={activeEvent}
          />
        </div>
      </div>

      <aside className="w-full shrink-0 overflow-y-auto border-t border-line-2 bg-sidebar p-3 xl:w-[390px] xl:border-l xl:border-t-0">
        {mod && m.tcas.length > 0 && (
          <Panel title={<><ShieldCheck size={13} className="text-ok" /> Encounters</>} className="mb-3" accent={COLOR.modified}>
            <ul className="space-y-2">
              {m.tcas.map((c, i) => {
                const safe = c.after_km !== null && c.after_km >= dmin;
                return (
                  <li key={i}>
                    <button
                      className="w-full rounded-lg border border-line-2 bg-app/50 px-3 py-2 text-left transition-colors hover:border-line hover:bg-hover/60"
                      onClick={() => onEvent({ t: c.t, kind: "tca", label: c.threat }, events.findIndex((e) => e.t === c.t))}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[12px] font-medium text-ink">{c.threat}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[9.5px] font-semibold tracking-wider ${safe ? "bg-ok/15 text-ok" : "bg-danger/15 text-danger"}`}>{safe ? "AVOIDED" : "CHECK"}</span>
                      </div>
                      <div className="num mt-1 flex items-center gap-1.5 text-[11.5px]">
                        <span style={{ color: COLOR.original }}>{fmtKm(c.before_km)}</span>
                        <span className="text-muted">→</span>
                        <span style={{ color: COLOR.modified }}>{fmtKm(c.after_km)}</span>
                        <span className="ml-auto text-[10px] text-muted">{utc(c.tca, false)}</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-[10px] leading-snug text-muted">
              Closest approach without the burn → closest approach with it, over the whole window.{" "}
              {m.tcas.every((c) => c.refined) ? "Refined values from the plan." : "From this simulation's 30 s samples (re-run the simulation for refined values)."}
            </p>
          </Panel>
        )}
        <Panel title="At this instant" className="mb-3">
          <KV k="Altitude (if no burn)"><span className="num">{fmt(alt(pO), 2)} km</span></KV>
          {mod && <KV k="Altitude (maneuvered)"><span className="num">{fmt(alt(pM), 2)} km</span></KV>}
          {mod && <KV k="Maneuvered − original"><span className="num">{fmt(dist(pO, pM), 3)} km</span></KV>}
          {threats.map((th) => {
            const pT = stateAt(th, t);
            const b = dist(pO, pT), a = dist(pM, pT);
            return (
              <KV key={th.label} k={th.label.replace(" (SYNTHETIC)", "")}>
                <span className="num"><span style={{ color: COLOR.original }}>{fmt(b, b !== null && b < 10 ? 3 : 0)}</span>{mod && <> → <span style={{ color: COLOR.modified }}>{fmt(a, a !== null && a < 10 ? 3 : 0)}</span></>} km</span>
              </KV>
            );
          })}
        </Panel>
        {man && (
          <Panel title="Maneuver" className="mb-3" accent={COLOR.burn}>
            <KV k="Time">{utc(man.time)}</KV>
            <KV k="|Δv|"><span className="num">{fmt(man.dv_ms * 1000, 1)} mm/s</span></KV>
            <KV k="Δv R / T / N"><span className="num">{man.dv_rtn_ms.map((x: number) => (x * 1000).toFixed(1)).join(" / ")} mm/s</span></KV>
            <KV k="Finite burn"><span className="num">{fmt(man.burn_s, 1)} s</span></KV>
          </Panel>
        )}
        <Panel title="Separation vs time" className="mb-3" actions={
          <select className="input h-7" value={chartThreat} onChange={(e) => setChartThreat(Number(e.target.value))} aria-label="Threat">{cfg.separations.series.map((s: { threat: string }, i: number) => <option key={i} value={i}>{s.threat}</option>)}</select>
        }>
          <div className="h-[210px]">
            <ResponsiveContainer>
              <LineChart data={sepData} margin={{ left: 0, right: 8, top: 6 }}>
                <CartesianGrid stroke="#1A2639" />
                <XAxis dataKey="t" type="number" domain={[0, horizon / 3600]} tick={{ fill: "#64748B", fontSize: 10 }} tickFormatter={(v) => `${Math.round(v)}h`} />
                <YAxis scale="log" domain={["auto", "auto"]} allowDataOverflow tick={{ fill: "#64748B", fontSize: 10 }} width={46} tickFormatter={(v) => (v >= 1 ? `${v}` : v.toFixed(2))} unit="" />
                <Tooltip contentStyle={tip} formatter={(v, n) => [`${Number(v).toFixed(3)} km`, String(n)]} labelFormatter={(x) => `T+${Number(x).toFixed(2)} h`} />
                <Legend wrapperStyle={{ fontSize: 10.5 }} />
                <ReferenceArea y1={0.0001} y2={dmin} fill="#FF647C" fillOpacity={0.07} ifOverflow="hidden" />
                {man && <ReferenceLine x={man.t_s / 3600} stroke={COLOR.burn} strokeDasharray="4 3" label={{ value: "burn", fill: COLOR.burn, fontSize: 9.5, position: "insideTopLeft" }} />}
                <ReferenceLine x={t / 3600} stroke="#E8EEF7" strokeDasharray="3 3" />
                <Line dataKey="before" name="if no burn" stroke={COLOR.original} dot={false} isAnimationActive={false} strokeWidth={1.4} />
                <Line dataKey="after" name="maneuvered" stroke={COLOR.modified} dot={false} isAnimationActive={false} strokeWidth={1.6} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-1 text-[10.5px] text-muted">Log scale, km. Red band: below the {fmt(dmin * 1000, 0)} m safety distance. Dips are passes of the threat.</p>
        </Panel>
        <Panel title="Run details">
          <p className="text-[11px] leading-relaxed text-ink-2">{cfg.force_model?.join(" · ")}</p>
          <p className="mt-1.5 text-[11px] text-ink-2">Fidelity: {cfg.fidelity} · plan <Link to={`/maneuvers?plan=${sim.plan_id}`} className="text-cyan hover:underline">#{sim.plan_id}</Link> · engine {sim.versions?.engine}</p>
          {sim.metrics.filter((x) => !x.context).map((x) => <KV key={x.name} k={x.name.replace(/_/g, " ")}><span className="num">{fmt(x.value, 3)} {x.unit}</span></KV>)}
        </Panel>
      </aside>
    </div>
  );
}
