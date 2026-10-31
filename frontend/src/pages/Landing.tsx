import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { Link } from "react-router-dom";
import { lazy, Suspense, useRef } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  BarChart3,
  Box,
  Clapperboard,
  Cpu,
  FlaskConical,
  Globe2,
  Lock,
  Orbit,
  Radar,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Tag,
  Workflow,
} from "lucide-react";
import { Logo } from "../components/AppSidebar";
import { SpaceBackground } from "../components/fx/SpaceBackground";
import { AnimatedHeading } from "../components/fx/AnimatedHeading";
import { RotatingText } from "../components/fx/RotatingText";
import { AnimatedMetric } from "../components/fx/AnimatedMetric";
import { StatusLight } from "../components/fx/MissionStatus";
import { EASE } from "../components/fx/motion";
import { api } from "../services/api";
import { useAsync } from "../services/useAsync";
import { useAuth } from "../stores/auth";
import { ago, utc } from "../lib/format";

const OrbitalGlobe = lazy(() => import("../components/fx/OrbitalGlobe").then((m) => ({ default: m.OrbitalGlobe })));

const PHRASES = [
  "TRACKING THE ORBITAL ENVIRONMENT",
  "DETECTING POTENTIAL CONJUNCTIONS",
  "ANALYZING COLLISION PROBABILITY",
  "OPTIMIZING AVOIDANCE MANEUVERS",
  "VALIDATING MULTI-THREAT TRAJECTORIES",
];

function Reveal({ children, delay = 0, className = "" }: { children: ReactNode; delay?: number; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.7, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

function SectionTitle({ eyebrow, title, blurb }: { eyebrow: string; title: string; blurb?: string }) {
  return (
    <Reveal className="mx-auto mb-12 max-w-2xl text-center">
      <div className="eyebrow mb-3">{eyebrow}</div>
      <h2 className="font-display text-[30px] font-semibold leading-tight tracking-tight text-ink sm:text-[38px]">{title}</h2>
      {blurb && <p className="mt-4 text-[14px] leading-relaxed text-ink-2">{blurb}</p>}
    </Reveal>
  );
}

/* ---------- small illustrative glyphs for the capability cards (decorative, no data) ---------- */
const Ill = {
  environment: (
    <svg viewBox="0 0 120 80" className="h-full w-full">
      <circle cx="60" cy="40" r="16" fill="#123a6b" stroke="#4DA3FF" strokeOpacity=".5" />
      <g className="origin-[60px_40px] animate-[spin_40s_linear_infinite]">
        {Array.from({ length: 26 }, (_, i) => {
          const a = (i * 137.5 * Math.PI) / 180, r = 22 + ((i * 7) % 16);
          return <circle key={i} cx={60 + r * Math.cos(a)} cy={40 + r * 0.62 * Math.sin(a)} r={i % 5 ? 1 : 1.5} fill={i % 4 ? "#C8D3E3" : "#4DA3FF"} opacity=".8" />;
        })}
      </g>
    </svg>
  ),
  orbits: (
    <svg viewBox="0 0 120 80" className="h-full w-full">
      <circle cx="60" cy="40" r="12" fill="#123a6b" />
      <ellipse cx="60" cy="40" rx="44" ry="14" fill="none" stroke="#36D6E8" strokeOpacity=".7" strokeDasharray="4 4" className="animate-orbit-dash" />
      <ellipse cx="60" cy="40" rx="30" ry="22" fill="none" stroke="#A78BFA" strokeOpacity=".6" transform="rotate(-35 60 40)" />
      <path d="M 82 40 A 22 22 0 0 0 78 28" fill="none" stroke="#F5B942" strokeWidth="1.5" />
      <text x="86" y="30" fill="#F5B942" fontSize="8" fontFamily="JetBrains Mono Variable">i</text>
    </svg>
  ),
  tracking: (
    <svg viewBox="0 0 120 80" className="h-full w-full">
      <circle cx="60" cy="40" r="30" fill="none" stroke="#223149" />
      <circle cx="60" cy="40" r="18" fill="none" stroke="#223149" />
      <g className="origin-[60px_40px] animate-[spin_4s_linear_infinite]">
        <path d="M60 40 L90 40 A30 30 0 0 0 81 19 Z" fill="#36D6E8" opacity=".18" />
      </g>
      <circle cx="78" cy="30" r="2.5" fill="#36D6E8" />
      <circle cx="44" cy="52" r="2" fill="#4DA3FF" />
      <circle cx="68" cy="58" r="1.5" fill="#C8D3E3" />
    </svg>
  ),
  collision: (
    <svg viewBox="0 0 120 80" className="h-full w-full">
      <path d="M10 62 Q60 34 110 22" fill="none" stroke="#4DA3FF" strokeWidth="1.5" />
      <path d="M14 14 Q60 44 108 66" fill="none" stroke="#FF9F43" strokeWidth="1.5" />
      <ellipse cx="60" cy="40" rx="14" ry="6" fill="#FF647C" opacity=".12" stroke="#FF647C" strokeOpacity=".6" transform="rotate(-15 60 40)" />
      <circle cx="60" cy="40" r="3" fill="#FF647C">
        <animate attributeName="r" values="2.5;4.5;2.5" dur="1.8s" repeatCount="indefinite" />
      </circle>
    </svg>
  ),
  twin: (
    <svg viewBox="0 0 120 80" className="h-full w-full animate-float">
      <rect x="50" y="30" width="20" height="20" rx="2" fill="#121D30" stroke="#E8EEF7" strokeOpacity=".8" />
      {[-1, 1].map((s) => (
        <g key={s}>
          <line x1={s > 0 ? 70 : 50} y1="40" x2={s > 0 ? 76 : 44} y2="40" stroke="#9AAAC0" />
          <rect x={s > 0 ? 76 : 14} y="32" width="30" height="16" fill="#4DA3FF" fillOpacity=".2" stroke="#4DA3FF" />
          {[1, 2].map((k) => <line key={k} x1={(s > 0 ? 76 : 14) + k * 10} y1="32" x2={(s > 0 ? 76 : 14) + k * 10} y2="48" stroke="#4DA3FF" strokeOpacity=".5" />)}
        </g>
      ))}
      <path d="M60 50 L56 60 L64 60 Z" fill="#A78BFA" opacity=".8" />
    </svg>
  ),
  maneuver: (
    <svg viewBox="0 0 120 80" className="h-full w-full">
      <path d="M8 56 Q50 40 112 44" fill="none" stroke="#4DA3FF" strokeDasharray="4 4" strokeOpacity=".8" />
      <path d="M42 46 Q70 26 112 24" fill="none" stroke="#35D39A" strokeWidth="1.8" strokeDasharray="200" className="animate-orbit-dash" />
      <circle cx="42" cy="46" r="3.5" fill="#A78BFA" />
      <path d="M42 46 L50 34" stroke="#A78BFA" strokeWidth="1.5" markerEnd="url(#og-arrow)" />
      <circle cx="96" cy="44" r="2.5" fill="#FF647C" />
      <defs>
        <marker id="og-arrow" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#A78BFA" /></marker>
      </defs>
    </svg>
  ),
  simulation: (
    <svg viewBox="0 0 120 80" className="h-full w-full">
      <line x1="10" y1="54" x2="110" y2="54" stroke="#223149" strokeWidth="3" strokeLinecap="round" />
      <line x1="10" y1="54" x2="70" y2="54" stroke="#36D6E8" strokeWidth="3" strokeLinecap="round" />
      {[[34, "#A78BFA"], [62, "#FF647C"], [92, "#FF647C"]].map(([x, c]) => (
        <rect key={x as number} x={(x as number) - 3} y="51" width="6" height="6" fill={c as string} transform={`rotate(45 ${x} 54)`} />
      ))}
      <circle cx="70" cy="54" r="4.5" fill="#070B14" stroke="#36D6E8" strokeWidth="2" />
      <path d="M20 34 Q60 10 100 34" fill="none" stroke="#35D39A" strokeOpacity=".7" />
      <path d="M20 34 Q60 22 100 34" fill="none" stroke="#4DA3FF" strokeOpacity=".6" strokeDasharray="3 3" />
    </svg>
  ),
  research: (
    <svg viewBox="0 0 120 80" className="h-full w-full">
      {[18, 30, 22, 46, 38, 58].map((h, i) => (
        <rect key={i} x={16 + i * 16} y={66 - h} width="10" height={h} rx="2" fill={i === 5 ? "#35D39A" : "#4DA3FF"} fillOpacity={i === 5 ? 0.9 : 0.45}>
          <animate attributeName="height" from="0" to={h} dur="1.2s" fill="freeze" />
          <animate attributeName="y" from="66" to={66 - h} dur="1.2s" fill="freeze" />
        </rect>
      ))}
      <line x1="10" y1="66" x2="112" y2="66" stroke="#223149" />
    </svg>
  ),
};

const CAPABILITIES = [
  { icon: Globe2, title: "Space environment", text: "Every catalogue object propagated with SGP4 to one simulation clock and shown on a 3D Earth.", ill: Ill.environment, accent: "#4DA3FF" },
  { icon: Orbit, title: "Orbit intelligence", text: "Multi-label regime classification (LEO, MEO, GEO, HEO, polar, sun-synchronous) from orbital elements.", ill: Ill.orbits, accent: "#36D6E8" },
  { icon: Radar, title: "Satellite tracking", text: "Track several satellites together, compare them and see which objects are nearby now and later.", ill: Ill.tracking, accent: "#36D6E8" },
  { icon: ShieldAlert, title: "Collision assessment", text: "Screening, time-of-closest-approach refinement and collision probability where covariance exists.", ill: Ill.collision, accent: "#FF647C" },
  { icon: Box, title: "Digital twin", text: "A configurable spacecraft (mass, drag, thruster, fuel, limits) propagated with a numerical force model.", ill: Ill.twin, accent: "#A78BFA" },
  { icon: Sparkles, title: "Maneuver optimisation", text: "One burn that clears every threat at once, tested against uncertainty and validated independently.", ill: Ill.maneuver, accent: "#35D39A" },
  { icon: Clapperboard, title: "Simulation & scenarios", text: "Replay the original and maneuvered orbits, the burn and each avoided encounter in 3D.", ill: Ill.simulation, accent: "#F5B942" },
  { icon: BarChart3, title: "Research analytics", text: "Seeded experiments comparing methods, with results exported as CSV and JSON.", ill: Ill.research, accent: "#4DA3FF" },
];

const PIPELINE = [
  { k: "01", t: "Ingest", d: "CelesTrak groups or TLE files, with epochs and freshness kept." },
  { k: "02", t: "Propagate", d: "SGP4 for the catalogue; Cowell integration for digital twins." },
  { k: "03", t: "Screen", d: "Close approaches found, then TCA refined to milliseconds." },
  { k: "04", t: "Assess", d: "Collision probability with the covariance stated; assumed values labelled." },
  { k: "05", t: "Optimise", d: "Multi-threat search with Monte Carlo robustness and fuel trim." },
  { k: "06", t: "Validate", d: "Full force model, finite burn and a whole-catalogue re-screen." },
];

const PRINCIPLES = [
  { icon: ShieldCheck, t: "Nothing fabricated", d: "Every number on screen is computed from stored data or comes from a run you can inspect. Missing data shows as missing." },
  { icon: Tag, t: "Assumptions labelled", d: "Synthetic test objects are marked SYNTHETIC, assumed uncertainty ASSUMED and twin bookkeeping SIMULATED." },
  { icon: Lock, t: "Never commands spacecraft", d: "Plans and simulations stay inside the platform. The real catalogue is never modified with simulated results." },
  { icon: FlaskConical, t: "Reproducible runs", d: "Each optimisation, simulation and experiment stores its inputs, seeds, force model and software versions." },
];

export function Landing() {
  const { status, me } = useAuth();
  const authed = status === "authenticated" && !!me;
  const sc = useAsync(() => api.showcase(), [], 60000);
  const d = sc.data;
  const root = useRef<HTMLDivElement>(null);
  const hero = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ container: root, target: hero, offset: ["start start", "end start"] });
  const globeY = useTransform(scrollYProgress, [0, 1], ["0%", "18%"]);
  const textY = useTransform(scrollYProgress, [0, 1], ["0%", "30%"]);
  const fade = useTransform(scrollYProgress, [0, 0.8], [1, 0]);
  const launch = authed ? me!.dashboard : "/login";
  const debris = d ? (d.by_type["DEBRIS"] ?? 0) + (d.by_type["ROCKET BODY"] ?? 0) : null;

  return (
    <div ref={root} className="relative h-full overflow-y-auto overflow-x-hidden bg-[#05080F] scroll-smooth">
      {/* ------------------------------------------------ top bar */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.04] bg-[#05080F]/60 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1320px] items-center gap-6 px-5">
          <Logo collapsed={false} />
          <nav className="ml-6 hidden items-center gap-6 text-[12.5px] text-ink-2 md:flex" aria-label="Sections">
            <a href="#capabilities" className="transition-colors hover:text-ink">Capabilities</a>
            <a href="#pipeline" className="transition-colors hover:text-ink">How it works</a>
            <a href="#integrity" className="transition-colors hover:text-ink">Scientific integrity</a>
            <a href="#access" className="transition-colors hover:text-ink">Access</a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {!authed && (
              <Link to="/register" className="btn hidden sm:inline-flex">
                Create account
              </Link>
            )}
            <Link to={launch} className="btn btn-primary">
              {authed ? "Open dashboard" : "Sign in"} <ArrowRight size={13} />
            </Link>
          </div>
        </div>
      </header>

      {/* ------------------------------------------------ hero */}
      <section ref={hero} className="relative flex min-h-[100svh] items-center overflow-hidden pt-16">
        <SpaceBackground density={0.00016} />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_60%_at_70%_55%,rgba(54,214,232,0.10),transparent_70%)]" />
        <motion.div style={{ y: globeY }} className="absolute inset-y-0 right-[-30%] w-[130%] opacity-55 sm:right-[-12%] sm:w-[85%] sm:opacity-100 lg:right-[-6%] lg:w-[68%]">
          <Suspense fallback={null}>
            <OrbitalGlobe
              points={d?.sample.ecef_km}
              types={d?.sample.types}
              tracks={d?.tracks}
              time={d?.generated_at}
              rotate={0.03}
              timelapse={90}
              range={19_500_000}
              centerLon={40}
            />
          </Suspense>
        </motion.div>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#05080F] via-[#05080F]/75 to-transparent sm:via-[#05080F]/40" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-[#05080F] to-transparent" />

        <motion.div style={{ y: textY, opacity: fade }} className="relative z-10 mx-auto w-full max-w-[1320px] px-5 py-16">
          <div className="max-w-[640px]">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8 }} className="mb-6 inline-flex items-center gap-2.5 rounded-full border border-cyan/20 bg-cyan/[0.06] px-3 py-1.5">
              {sc.error ? <StatusLight tone="bad" size={6} /> : d ? <StatusLight tone={d.tracked_objects ? "ok" : "warn"} size={6} /> : <StatusLight tone="idle" size={6} />}
              <span className="num text-[10.5px] tracking-[0.16em] text-ink-2">
                {sc.error ? "CATALOGUE OFFLINE" : !d ? "CONNECTING" : d.tracked_objects ? "LIVE ORBITAL DATA" : "NO CATALOGUE LOADED"}
              </span>
              {d && <span className="num text-[10.5px] text-muted">· {utc(d.generated_at)}</span>}
            </motion.div>
            <AnimatedHeading
              text="INTELLIGENCE BEYOND THE ORBIT."
              emphasis={["ORBIT"]}
              className="font-display text-[44px] font-bold leading-[0.98] tracking-[-0.01em] text-ink sm:text-[64px] lg:text-[76px]"
              step={0.09}
              delay={0.15}
            />
            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, ease: EASE, delay: 0.65 }}
              className="mt-6 max-w-[520px] text-[15.5px] leading-relaxed text-ink-2 sm:text-[17px]"
            >
              An advanced orbital intelligence platform for satellite monitoring, conjunction assessment, and uncertainty-aware collision avoidance.
            </motion.p>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.9, duration: 0.6 }} className="mt-6 flex items-center gap-3 font-mono text-[12px] tracking-[0.14em] text-cyan">
              <span className="h-px w-8 bg-cyan/60" />
              <RotatingText phrases={PHRASES} />
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: EASE, delay: 1.05 }}
              className="mt-10 flex flex-wrap gap-3"
            >
              <a href="#capabilities" className="btn btn-hero group">
                EXPLORE ORBITAL INTELLIGENCE <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
              </a>
              <Link to={launch} className="btn btn-primary btn-hero group">
                LAUNCH MISSION CONTROL <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
              </Link>
            </motion.div>
          </div>
        </motion.div>

        {d && d.sample.count > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.4, duration: 0.6 }}
            className="glass absolute bottom-6 right-5 z-10 hidden max-w-[300px] rounded-xl px-4 py-3 text-[11px] leading-relaxed text-ink-2 md:block"
          >
            <div className="label-caps mb-1 text-[9.5px]">On the globe</div>
            <span className="num text-ink">{d.sample.count.toLocaleString()}</span> of <span className="num text-ink">{d.sample.of.toLocaleString()}</span> catalogue objects at{" "}
            <span className="num text-ink">{utc(d.generated_at)}</span>, propagated with SGP4. Lines: {d.tracks.length} real orbits, satellites replayed at ×90.
          </motion.div>
        )}
      </section>

      {/* ------------------------------------------------ live metrics */}
      <section className="relative border-y border-line-2 bg-[#070B14]">
        <div className="mx-auto grid max-w-[1320px] grid-cols-2 divide-line-2 px-5 md:grid-cols-4 md:divide-x">
          {[
            { l: "Objects tracked", v: d?.tracked_objects ?? null, c: "#36D6E8" },
            { l: "Payloads", v: d ? (d.by_type["PAYLOAD"] ?? 0) : null, c: "#4DA3FF" },
            { l: "Debris & rocket bodies", v: debris, c: "#C8D3E3" },
          ].map((m) => (
            <div key={m.l} className="px-2 py-7 md:px-8">
              <div className="label-caps text-[10px]">{m.l}</div>
              <div className="mt-2 text-[34px] font-medium leading-none text-ink" style={{ textShadow: `0 0 24px ${m.c}33` }}>
                <AnimatedMetric value={m.v} />
              </div>
            </div>
          ))}
          <div className="px-2 py-7 md:px-8">
            <div className="label-caps text-[10px]">Newest element set</div>
            <div className="num mt-2 text-[34px] font-medium leading-none text-ink">{d?.newest_epoch ? ago(d.newest_epoch) : "—"}</div>
            <div className="mt-1 text-[11px] text-muted">{d?.last_ingestion ? `last ingestion ${ago(d.last_ingestion)}` : sc.error ? "backend unreachable" : "no ingestion yet"}</div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ capabilities */}
      <section id="capabilities" className="relative scroll-mt-16 px-5 py-24">
        <div className="pointer-events-none absolute inset-0 orbit-grid opacity-40" />
        <div className="relative mx-auto max-w-[1320px]">
          <SectionTitle
            eyebrow="Capabilities"
            title="One platform from the catalogue to a validated maneuver."
            blurb="Each module works on the same propagated data and the same simulation clock, so what you see in one view is what the next one calculates with."
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {CAPABILITIES.map((c, i) => (
              <Reveal key={c.title} delay={(i % 4) * 0.06}>
                <div className="panel panel-glow group h-full overflow-hidden p-5 hover:-translate-y-1">
                  <span className="absolute inset-x-0 top-0 h-px opacity-70" style={{ background: `linear-gradient(90deg, ${c.accent}, transparent 75%)` }} />
                  <div className="mb-4 h-[86px] rounded-lg border border-line-2 bg-[#070B14]/80 p-2">{c.ill}</div>
                  <div className="mb-2 flex items-center gap-2">
                    <c.icon size={15} style={{ color: c.accent }} />
                    <h3 className="font-display text-[15px] font-semibold text-ink">{c.title}</h3>
                  </div>
                  <p className="text-[12.5px] leading-relaxed text-ink-2">{c.text}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ pipeline */}
      <section id="pipeline" className="relative scroll-mt-16 border-t border-line-2 bg-[#070B14] px-5 py-24">
        <div className="mx-auto max-w-[1320px]">
          <SectionTitle eyebrow="How it works" title="From element sets to an avoided encounter." />
          <div className="relative">
            <svg className="pointer-events-none absolute left-0 top-[26px] hidden h-2 w-full lg:block" preserveAspectRatio="none" viewBox="0 0 100 2" aria-hidden>
              <line x1="4" y1="1" x2="96" y2="1" stroke="#223149" strokeWidth="0.4" />
              <line x1="4" y1="1" x2="96" y2="1" stroke="#36D6E8" strokeWidth="0.4" strokeDasharray="2 6" className="animate-orbit-dash" />
            </svg>
            <ol className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-6">
              {PIPELINE.map((p, i) => (
                <Reveal key={p.k} delay={i * 0.08}>
                  <li className="relative">
                    <div className="mb-4 flex h-[52px] w-[52px] items-center justify-center rounded-full border border-cyan/30 bg-[#05080F] shadow-[0_0_24px_-6px_rgba(54,214,232,0.5)]">
                      <span className="num text-[13px] text-cyan">{p.k}</span>
                    </div>
                    <h3 className="font-display text-[16px] font-semibold text-ink">{p.t}</h3>
                    <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">{p.d}</p>
                  </li>
                </Reveal>
              ))}
            </ol>
          </div>
          <Reveal delay={0.2} className="mx-auto mt-14 flex max-w-3xl flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[11.5px] text-muted">
            <span className="flex items-center gap-1.5"><Cpu size={13} className="text-blue" /> SGP4 · Cowell (DOP853) · J2–J4, drag, Sun, Moon, SRP</span>
            <span className="flex items-center gap-1.5"><Workflow size={13} className="text-violet" /> Monte Carlo robustness · finite-burn validation</span>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------ integrity */}
      <section id="integrity" className="relative scroll-mt-16 overflow-hidden px-5 py-24">
        <SpaceBackground density={0.00006} parallax={false} />
        <div className="relative mx-auto max-w-[1320px]">
          <SectionTitle
            eyebrow="Scientific integrity"
            title="Built to be checked, not just looked at."
            blurb="A collision-avoidance tool is only useful if you can trust what it shows. These rules hold everywhere in ORBITGUARD."
          />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {PRINCIPLES.map((p, i) => (
              <Reveal key={p.t} delay={i * 0.06}>
                <div className="panel panel-glow flex h-full gap-4 p-6">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line bg-[#070B14] text-cyan">
                    <p.icon size={18} />
                  </span>
                  <div>
                    <h3 className="font-display text-[16px] font-semibold text-ink">{p.t}</h3>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{p.d}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ access */}
      <section id="access" className="relative scroll-mt-16 border-t border-line-2 bg-[#070B14] px-5 py-24">
        <Reveal className="mx-auto max-w-3xl text-center">
          <div className="eyebrow mb-3">Access</div>
          <h2 className="font-display text-[32px] font-semibold leading-tight tracking-tight text-ink sm:text-[40px]">
            Six mission roles. <span className="text-gradient">One secure platform.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-[14px] leading-relaxed text-ink-2">
            Administrators, organisation admins, mission managers, scientists, operators and the public each sign in through their own portal, and the server grants only that role's permissions.
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <Link to={launch} className="btn btn-primary btn-hero">
              {authed ? "OPEN MISSION CONTROL" : "CHOOSE YOUR PORTAL"} <ArrowRight size={14} />
            </Link>
            {!authed && (
              <Link to="/register" className="btn btn-hero">
                CREATE A PUBLIC ACCOUNT
              </Link>
            )}
          </div>
        </Reveal>
      </section>

      <footer className="border-t border-line-2 px-5 py-8">
        <div className="mx-auto flex max-w-[1320px] flex-wrap items-center justify-between gap-4 text-[11.5px] text-muted">
          <Logo collapsed={false} />
          <span>Research platform · positions from public catalogue data · never commands real spacecraft</span>
        </div>
      </footer>
    </div>
  );
}
