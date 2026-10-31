import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronLeft, ChevronRight, Clapperboard, GitCompare, Pause, Play, Repeat, ShieldCheck } from "lucide-react";
import { EmptyState, LoadingState, OrbitLoader, Panel } from "../components/ui";
import { Notice } from "../components/auth/AuthLayout";
import { api, ApiError } from "../services/api";
import { useAsync } from "../services/useAsync";
import { useCan } from "../stores/auth";
import { fmt, utc } from "../lib/format";
import type { Plan, Simulation } from "../types/mission";
import { SimBadge } from "./DigitalTwin";
import { DEFAULT_LAYERS, fmtKm, SIM_COLORS, stateAt, useSimModel, useSimScene } from "../components/sim/simScene";
import type { SimModel } from "../components/sim/simScene";
import { SimulationTimeline } from "../components/fx/SimulationTimeline";
import { EASE } from "../components/fx/motion";

/* ------------------------------------------------------------------ page shell */
export function ScenarioVisualizer() {
  const [params, setParams] = useSearchParams();
  const planId = Number(params.get("plan")) || null;
  const plans = useAsync(() => api.plans(), []);
  const done = (plans.data ?? []).filter((p) => p.status === "succeeded" && p.result_status === "selected");
  useEffect(() => {
    // open the newest replayable plan by default
    if (!planId && done[0]) setParams((p) => { p.set("plan", String(done[0]!.id)); return p; }, { replace: true });
  }, [planId, done, setParams]);
  return (
    <div className="-m-3 flex h-[calc(100%+1.5rem)] flex-col sm:-m-5 sm:h-[calc(100%+2.5rem)]">
      <div className="flex flex-wrap items-center gap-3 border-b border-line-2 bg-app/80 px-4 py-3 backdrop-blur sm:px-5">
        <div className="min-w-0">
          <div className="eyebrow mb-0.5 text-[9.5px]">Simulation</div>
          <h1 className="font-display text-[19px] font-semibold tracking-[0.03em] text-ink">ORBITAL SCENARIO VISUALIZER</h1>
          <p className="hidden text-[11.5px] text-ink-2 sm:block">A guided replay of a maneuver plan: the approach, the burn, each avoided encounter and the multi-threat check.</p>
        </div>
        <select
          className="input ml-auto h-8 w-full sm:w-auto sm:min-w-[280px]"
          value={planId ?? ""}
          onChange={(e) => setParams((p) => { p.set("plan", e.target.value); p.delete("alt"); return p; }, { replace: true })}
          aria-label="Maneuver plan"
        >
          <option value="">Choose a maneuver plan…</option>
          {done.map((p) => <option key={p.id} value={p.id}>Plan #{p.id} · {p.twin_name} · {fmt((p.dv_ms ?? 0) * 1000, 1)} mm/s</option>)}
        </select>
      </div>
      {plans.data && done.length === 0 ? (
        <div className="p-5">
          <Panel>
            <EmptyState title="No plan to replay yet" icon={<Clapperboard size={20} />}>
              Optimise a maneuver on <Link to="/maneuvers" className="text-cyan hover:underline">Maneuver Optimization</Link>. Plans with a selected burn appear here.
            </EmptyState>
          </Panel>
        </div>
      ) : !planId ? (
        <div className="p-5"><LoadingState /></div>
      ) : (
        <ScenarioLoader key={planId} planId={planId} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ data */
function ScenarioLoader({ planId }: { planId: number }) {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const altWanted = params.get("alt") !== null ? Number(params.get("alt")) : null;
  const plan = useAsync(() => api.plan(planId), [planId]);
  const [sim, setSim] = useState<Simulation | null>(null);
  const [state, setState] = useState<"loading" | "none" | "running" | "ready">("loading");
  const [err, setErr] = useState<string | null>(null);

  const poll = (id: number, alive: () => boolean) => {
    api.simulation(id).then((s) => {
      if (!alive()) return;
      if (s.status === "succeeded") { setSim(s); setState("ready"); }
      else if (s.status === "failed") { setErr(s.message); setState("none"); }
      else { setState("running"); window.setTimeout(() => poll(id, alive), 1000); }
    }).catch((e) => alive() && setErr((e as ApiError).message));
  };

  useEffect(() => {
    let live = true;
    const alive = () => live;
    setSim(null);
    setErr(null);
    setState("loading");
    api.simulations(planId).then((list) => {
      if (!live) return;
      const ok = list.filter((x) => x.status !== "failed");
      const pick = altWanted !== null ? ok.find((x) => x.alternative_index === altWanted) : ok.find((x) => x.alternative_index == null) ?? ok[0];
      if (pick) poll(pick.id, alive);
      else if (altWanted !== null && can("simulation:run")) run(altWanted, alive);
      else setState("none");
    }).catch((e) => setErr((e as ApiError).message));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId, altWanted]);

  const run = async (alt: number | null, alive: () => boolean = () => true) => {
    setErr(null);
    setState("running");
    try {
      const r = await api.createSimulation(planId, "validation", alt ?? undefined);
      poll(r.simulation_id, alive);
    } catch (e) {
      setErr((e as ApiError).message);
      setState("none");
    }
  };

  if (err && state !== "ready") return <div className="p-5"><Notice kind="error">{err}</Notice></div>;
  if (state === "loading" || !plan.data) return <div className="p-5"><LoadingState label="Loading scenario" /></div>;
  if (state === "none")
    return (
      <div className="p-5">
        <Panel>
          <EmptyState title="This plan hasn't been simulated yet" icon={<Clapperboard size={20} />}>
            {can("simulation:run") ? (
              <button className="btn btn-primary mt-3" onClick={() => run(null)}><Play size={13} /> Run high-fidelity simulation</button>
            ) : "Your role can't run simulations."}
            <p className="mt-2 text-[11px]">Full force model (J2–J4, drag, Sun, Moon, SRP) with the twin's finite burn.</p>
          </EmptyState>
        </Panel>
      </div>
    );
  if (state === "running" || !sim)
    return <div className="flex flex-1 items-center justify-center gap-2.5 text-ink-2"><OrbitLoader size={26} /> Propagating the scenario with the full force model…</div>;
  return (
    <Theatre
      sim={sim}
      plan={plan.data}
      onAlternative={(k) => setParams((p) => { if (k === null) p.delete("alt"); else p.set("alt", String(k)); return p; }, { replace: true })}
      altIndex={altWanted}
    />
  );
}

/* ------------------------------------------------------------------ acts */
interface Act {
  key: string;
  chapter: string;
  title: string;
  body: ReactNode;
  t0: number;
  t1: number;
  speed: number;
  /** camera: overview (home), track the active satellite at a range, or follow a fixed point */
  cam: { kind: "home" } | { kind: "track"; range: number; pitch?: number } | { kind: "point"; at: () => [number, number, number] | null; range: number };
  tone?: "danger" | "burn" | "ok" | "info" | "alt";
}

const TONE: Record<NonNullable<Act["tone"]>, string> = { danger: SIM_COLORS.tca, burn: SIM_COLORS.burn, ok: SIM_COLORS.modified, info: SIM_COLORS.selected, alt: SIM_COLORS.alternative };

function buildActs(m: SimModel, plan: Plan, sim: Simulation): Act[] {
  const res = plan.result!;
  const acts: Act[] = [];
  const first = m.tcas.slice().sort((a, b) => a.t - b.t)[0];
  const worst = m.tcas.slice().sort((a, b) => (a.before_km ?? 1e9) - (b.before_km ?? 1e9))[0];
  const nThreat = m.threats.length;
  const synth = res.threats?.some((t) => t.kind === "synthetic");
  acts.push({
    key: "situation",
    chapter: "Situation",
    title: `${plan.twin_name ?? "Your satellite"} and ${nThreat} threat${nThreat === 1 ? "" : "s"}`,
    body: (
      <>
        A {(m.horizon / 3600).toFixed(0)} h window from <span className="num text-ink">{utc(new Date(m.start).toISOString())}</span>. The cyan line is your satellite; orange lines are the objects predicted to pass close.
        {synth && <> Threats marked <span className="text-warn">SYNTH</span> are synthetic test objects.</>}
      </>
    ),
    t0: 0,
    t1: Math.min(m.horizon, (m.man?.t_s ?? m.period) * 0.35),
    speed: 300,
    cam: { kind: "home" },
    tone: "info",
  });
  if (worst)
    acts.push({
      key: "danger",
      chapter: "The danger",
      title: `Without a burn, ${worst.threat} passes ${fmtKm(worst.before_km)} away`,
      body: (
        <>
          At <span className="num text-ink">{utc(worst.tca)}</span>, on the original orbit (dashed blue after the burn time). The safety rule is at least{" "}
          <span className="num text-ink">{fmt((sim.config.d_min_km ?? 0.2) * 1000, 0)} m</span> and a collision probability below{" "}
          <span className="num text-ink">{(sim.config.pc_limit ?? 1e-4).toExponential(0)}</span>.
        </>
      ),
      t0: Math.max(0, worst.t - 240),
      t1: Math.min(m.horizon, worst.t + 60),
      speed: 4,
      cam: { kind: "point", at: () => stateAt(m.orig, worst.t), range: 650_000 },
      tone: "danger",
    });
  if (m.man) {
    const [r, tt, n] = m.man.dv_rtn_ms.map((x) => x * 1000);
    const dir = Math.abs(tt!) >= Math.max(Math.abs(r!), Math.abs(n!)) ? (tt! > 0 ? "along-track (+T)" : "against the motion (−T)") : Math.abs(r!) >= Math.abs(n!) ? "radial" : "cross-track";
    acts.push({
      key: "burn",
      chapter: "Maneuver",
      title: `A ${fmt(m.man.dv_ms * 1000, 1)} mm/s burn, ${dir}`,
      body: (
        <>
          At <span className="num text-ink">{utc(m.man.time)}</span>, {fmt((first ? first.t - m.man.t_s : 0) / 3600, 2)} h before the first encounter. The thruster fires for{" "}
          <span className="num text-ink">{fmt(m.man.burn_s, 1)} s</span> (R/T/N <span className="num text-ink">{[r, tt, n].map((x) => x!.toFixed(1)).join(" / ")}</span> mm/s). From here the
          satellite follows the green path.
        </>
      ),
      t0: Math.max(0, m.man.t_s - 150),
      t1: Math.min(m.horizon, m.man.t_s + 600),
      speed: 8,
      cam: { kind: "track", range: 1_400_000, pitch: -0.5 },
      tone: "burn",
    });
  }
  m.tcas
    .slice()
    .sort((a, b) => a.t - b.t)
    .forEach((c, i) =>
      acts.push({
        key: `tca-${i}`,
        chapter: `Encounter ${i + 1}`,
        title: m.mod ? `${c.threat}: ${fmtKm(c.before_km)} → ${fmtKm(c.after_km)}` : `${c.threat} at ${fmtKm(c.before_km)}`,
        body: m.mod ? (
          <>
            The maneuvered satellite (green) passes the threat at <span className="num text-ok">{fmtKm(c.after_km)}</span> instead of{" "}
            <span className="num" style={{ color: SIM_COLORS.original }}>{fmtKm(c.before_km)}</span>. The red dashed line is the live distance.
          </>
        ) : (
          "Closest approach on the original orbit."
        ),
        t0: Math.max(0, c.t - 180),
        t1: Math.min(m.horizon, c.t + 90),
        speed: 3,
        cam: { kind: "track", range: 700_000, pitch: -0.4 },
        tone: "ok",
      }),
    );
  if (m.alt) {
    const a = sim.config.alternative;
    const sel = res.selected!;
    const minAlt = (sim.config.separations.series as { threat: string; alternative_km: number[] | null }[]).map((s) => ({
      threat: s.threat,
      d: s.alternative_km ? Math.min(...s.alternative_km) : null,
    }));
    acts.push({
      key: "alternative",
      chapter: "Alternative",
      title: `Candidate #${a.index + 1}: ${fmt(a.dv_ms * 1000, 1)} mm/s vs ${fmt(sel.dv_ms * 1000, 1)} mm/s selected`,
      body: (
        <>
          The amber dashed path is another feasible burn from the plan's table (score J {fmt(a.J, 3)} vs {fmt(sel.J, 3)}). Closest sampled distances:{" "}
          {minAlt.map((x, i) => (
            <span key={i} className="num text-ink">{x.threat} {fmtKm(x.d)}{i < minAlt.length - 1 ? " · " : ""}</span>
          ))}
          .
        </>
      ),
      t0: Math.max(0, (first?.t ?? a.t_s) - 240),
      t1: Math.min(m.horizon, (first?.t ?? a.t_s) + 60),
      speed: 4,
      cam: { kind: "track", range: 900_000, pitch: -0.45 },
      tone: "alt",
    });
  }
  const v = res.validation;
  const mc = res.monte_carlo?.selected;
  acts.push({
    key: "validation",
    chapter: "Validation",
    title: res.safe_against_all_threats ? "Every threat cleared" : "Not every threat is cleared",
    body: (
      <>
        {res.threats_considered?.length ?? nThreat} threats checked together, not one at a time. Independent validation (finite burn, full force model, catalogue re-screen):{" "}
        <span className={v?.status === "passed" ? "text-ok" : "text-danger"}>{v?.status ?? "not run"}</span>.
        {mc && (
          <>
            {" "}Monte Carlo: <span className="num text-ink">{(mc.p_violation * 100).toFixed(1)}%</span> of {mc.samples} samples breach a safety rule (ASSUMED uncertainty).
          </>
        )}
      </>
    ),
    t0: 0,
    t1: m.horizon,
    speed: 1200,
    cam: { kind: "home" },
    tone: res.safe_against_all_threats ? "ok" : "danger",
  });
  return acts;
}

/* ------------------------------------------------------------------ player */
function Theatre({ sim, plan, altIndex, onAlternative }: { sim: Simulation; plan: Plan; altIndex: number | null; onAlternative: (k: number | null) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const m = useSimModel(sim);
  const reduce = useReducedMotion();
  const scene = useSimScene(host, m, DEFAULT_LAYERS);
  const acts = useMemo(() => buildActs(m, plan, sim), [m, plan, sim]);
  const [ai, setAi] = useState(0);
  const [t, setT] = useState(0);
  const tRef = useRef(0);
  const [playing, setPlaying] = useState(true);
  const [auto, setAuto] = useState(true);
  const [speed, setSpeed] = useState(acts[0]!.speed);
  const actStart = useRef(performance.now());
  const manual = useRef(false);
  const act = acts[Math.min(ai, acts.length - 1)]!;
  const can = useCan();

  const alternatives = (plan.result?.top_candidates ?? [])
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.feasible && c.t_m_s !== null && JSON.stringify(c.dv_rtn_ms) !== JSON.stringify(plan.result?.selected?.dv_rtn_ms))
    .slice(0, 6);

  // start an act: jump in time, set speed, move the camera
  useEffect(() => {
    tRef.current = act.t0;
    setT(act.t0);
    setSpeed(act.speed);
    actStart.current = performance.now();
    manual.current = false;
    scene.apply(act.t0);
    if (act.cam.kind === "home") scene.camera.home(reduce ? 0 : 2);
    else if (act.cam.kind === "point") scene.camera.flyTo(act.cam.at(), act.cam.range, reduce ? 0 : 2.2, 0.5, -0.45);
    setPlaying(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai, acts]);

  // frame loop
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastUi = 0;
    let advanceAt = 0;
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (playing) {
        tRef.current = Math.min(m.horizon, tRef.current + dt * speed);
        if (!manual.current && tRef.current >= act.t1) {
          tRef.current = act.t1;
          if (auto && ai < acts.length - 1) {
            if (!advanceAt) advanceAt = now + 1600;
            else if (now >= advanceAt) {
              advanceAt = 0;
              setAi((k) => k + 1);
            }
          } else setPlaying(false);
        }
      }
      scene.apply(tRef.current);
      if (act.cam.kind === "track" && !manual.current) {
        // cinematic approach: ease the range in over 2.5 s and drift the heading slowly
        const e = Math.min(1, (now - actStart.current) / 2500);
        const k = reduce ? 1 : 1 - Math.pow(1 - e, 3);
        const range = 9_000_000 + (act.cam.range - 9_000_000) * k;
        const heading = reduce ? 0.4 : 0.4 + ((now - actStart.current) / 1000) * 0.04;
        scene.camera.lock(scene.activeAt(tRef.current), range, heading, act.cam.pitch ?? -0.5);
      }
      if (now - lastUi > 100) {
        lastUi = now;
        setT(tRef.current);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      scene.camera.release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, act, auto, ai, acts.length, m.horizon, reduce]);

  const go = (k: number) => setAi(Math.max(0, Math.min(acts.length - 1, k)));
  const seek = (s: number) => {
    manual.current = true;
    tRef.current = Math.max(0, Math.min(m.horizon, s));
    setT(tRef.current);
  };
  const tone = TONE[act.tone ?? "info"];

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={host} className="absolute inset-0" />
      {/* vignette for legibility */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_80%_at_50%_40%,transparent_55%,rgba(5,8,15,0.75))]" />

      {/* chapters */}
      <div className="absolute inset-x-3 top-3 z-10 flex flex-wrap items-center gap-2">
        <div className="glass flex max-w-full items-center gap-1 overflow-x-auto rounded-full p-1">
          {acts.map((a, i) => (
            <button
              key={a.key}
              onClick={() => go(i)}
              className={`relative whitespace-nowrap rounded-full px-3 py-1.5 text-[11px] font-medium transition-colors ${i === ai ? "text-ink" : "text-ink-2 hover:text-ink"}`}
              aria-current={i === ai ? "step" : undefined}
            >
              {i === ai && <motion.span layoutId="act-pill" className="absolute inset-0 rounded-full border bg-elevated" style={{ borderColor: `${TONE[a.tone ?? "info"]}66` }} transition={{ type: "spring", stiffness: 380, damping: 34 }} />}
              <span className="relative flex items-center gap-1.5">
                <span className="num text-[9.5px] text-muted">{String(i + 1).padStart(2, "0")}</span>
                {a.chapter}
              </span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <SimBadge />
          <button
            className={`btn h-8 ${auto ? "border-cyan/50 text-cyan" : ""}`}
            onClick={() => setAuto((a) => !a)}
            aria-pressed={auto}
            title="Advance to the next chapter automatically"
          >
            <Repeat size={13} /> Auto
          </button>
        </div>
      </div>

      {/* caption */}
      <div className="absolute bottom-[150px] left-3 z-10 w-[min(560px,calc(100%-1.5rem))] sm:bottom-[132px]">
        <AnimatePresence mode="wait">
          <motion.div
            key={act.key}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: "blur(4px)" }}
            transition={{ duration: 0.5, ease: EASE }}
            className="glass relative overflow-hidden rounded-xl p-4"
          >
            <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: tone, boxShadow: `0 0 16px ${tone}` }} />
            <div className="num mb-1.5 flex items-center gap-2 text-[10px] tracking-[0.18em]" style={{ color: tone }}>
              {String(ai + 1).padStart(2, "0")} / {String(acts.length).padStart(2, "0")} · {act.chapter.toUpperCase()}
            </div>
            <h2 className="font-display text-[19px] font-semibold leading-snug text-ink sm:text-[22px]">{act.title}</h2>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">{act.body}</p>
            <div className="mt-3 flex items-center gap-2">
              <button className="btn h-8" onClick={() => go(ai - 1)} disabled={ai === 0}><ChevronLeft size={13} /> Previous</button>
              <button className="btn btn-primary h-8" onClick={() => go(ai + 1)} disabled={ai === acts.length - 1}>Next <ChevronRight size={13} /></button>
              <button className="btn h-8 w-8 justify-center px-0" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>
                {playing ? <Pause size={13} /> : <Play size={13} />}
              </button>
              <Link to={`/simulation?plan=${sim.plan_id}`} className="ml-auto text-[11px] text-cyan hover:underline">Open in lab →</Link>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* comparison panel */}
      <div className="glass absolute right-3 top-16 z-10 hidden w-[260px] rounded-xl p-3 lg:block">
        <div className="label-caps mb-2 flex items-center gap-1.5"><ShieldCheck size={12} className="text-ok" /> Closest approach: no burn → burn</div>
        <ul className="space-y-1.5">
          {m.tcas.map((c, i) => (
            <li key={i} className="flex items-center justify-between text-[11.5px]">
              <span className="text-ink-2">{c.threat}</span>
              <span className="num">
                <span style={{ color: SIM_COLORS.original }}>{fmtKm(c.before_km)}</span>
                <span className="text-muted"> → </span>
                <span style={{ color: SIM_COLORS.modified }}>{fmtKm(c.after_km)}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3 border-t border-line-2 pt-2.5">
          <div className="label-caps mb-1.5 flex items-center gap-1.5"><GitCompare size={12} /> Compare a trajectory</div>
          <select
            className="input h-8 w-full"
            value={altIndex ?? ""}
            onChange={(e) => onAlternative(e.target.value === "" ? null : Number(e.target.value))}
            disabled={!can("simulation:run") && altIndex === null}
            aria-label="Alternative candidate"
          >
            <option value="">Selected burn only</option>
            {alternatives.map(({ c, i }) => (
              <option key={i} value={i}>
                Candidate #{i + 1} · {fmt(c.dv_ms * 1000, 1)} mm/s · J {fmt(c.J, 3)}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[10px] leading-snug text-muted">
            {alternatives.length ? "Another feasible burn from the plan, flown with the same force model (amber, dashed)." : "The plan has no other feasible candidate to compare."}
          </p>
        </div>
      </div>

      <div className="absolute inset-x-3 bottom-3 z-10">
        <SimulationTimeline
          start={m.start}
          horizon={m.horizon}
          t={t}
          onSeek={seek}
          playing={playing}
          onTogglePlay={() => setPlaying((p) => !p)}
          speed={speed}
          onSpeed={(s) => { manual.current = true; setSpeed(s); }}
          events={[...(m.man ? [{ t: m.man.t_s, kind: "burn" as const, label: "Burn" }] : []), ...m.tcas.map((c) => ({ t: c.t, kind: "tca" as const, label: c.threat }))]}
          compact
        />
      </div>
    </div>
  );
}
