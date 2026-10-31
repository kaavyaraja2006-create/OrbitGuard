import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Eye,
  EyeOff,
  Focus,
  Home,
  Info,
  Loader2,
  Orbit as OrbitIcon,
  Play,
  Radar,
  Route,
  Search,
  Square,
  X,
} from "lucide-react";
import { api, ApiError } from "../services/api";
import { simTimeISO, useApp } from "../stores/app";
import { useCan } from "../stores/auth";
import { ALL_CATEGORIES, HIGH_COLOR, MAX_TRACKED, NEAR_COLOR, shownTracked, useTracking } from "../stores/tracking";
import type { CatalogItem, Category, CompareRow, FutureWindow, NearbyItem, ProximityJob, ProximityScreen } from "../types/proximity";
import { ORBIT_LABELS } from "../types";
import { FreshnessBadge, OrbitBadges } from "./ui";
import { fmt, utc } from "../lib/format";

const CAT_LABEL: Record<Category, string> = {
  debris: "Debris",
  rocket_body: "Rocket body",
  active_satellite: "Active satellite",
  inactive_satellite: "Inactive satellite",
  satellite_unknown_status: "Satellite, status unknown",
  unknown: "Unknown type",
};
const CAT_COLOR: Record<Category, string> = {
  debris: "#C8D3E3",
  rocket_body: "#F5B942",
  active_satellite: "#4DA3FF",
  inactive_satellite: "#64748B",
  satellite_unknown_status: "#7FA6D6",
  unknown: "#9AAAC0",
};
const RADII = [1, 5, 10, 25, 50, 100];
const HORIZONS = [1, 6, 12, 24, 48];
const PAGE = 15;

type Tab = "select" | "proximity" | "compare";

export function TrackingPanel() {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<Tab>("select");
  const tracked = useTracking((s) => s.tracked);
  if (!open)
    return (
      <div className="flex shrink-0 flex-row items-center gap-2 border-b border-line-2 bg-sidebar px-3 py-2 md:w-11 md:flex-col md:border-b-0 md:border-r md:px-0 md:py-3">
        <button className="btn h-8 w-8 justify-center px-0" onClick={() => setOpen(true)} aria-label="Open tracking panel" title="Tracking & proximity">
          <ChevronRight size={14} />
        </button>
        <Radar size={15} className="text-cyan" />
        <span className="num text-[10px] text-ink-2">{tracked.length}</span>
      </div>
    );
  return (
    <aside className="flex max-h-[45vh] w-full shrink-0 flex-col border-b border-line-2 bg-sidebar md:max-h-none md:w-[400px] md:max-w-[85vw] md:border-b-0 md:border-r" aria-label="Tracking and proximity">
      <div className="flex items-center justify-between border-b border-line-2 px-3 py-2">
        <div className="flex items-center gap-2">
          <Radar size={15} className="text-cyan" />
          <span className="text-[12.5px] font-semibold tracking-wide text-ink">Tracking & proximity</span>
        </div>
        <button className="text-muted hover:text-ink" onClick={() => setOpen(false)} aria-label="Collapse panel">
          <ChevronLeft size={15} />
        </button>
      </div>
      <div role="tablist" className="flex border-b border-line-2 px-2">
        {(
          [
            ["select", `Satellites${tracked.length ? ` · ${tracked.length}` : ""}`],
            ["proximity", "Proximity"],
            ["compare", "Compare"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`relative px-3 py-2 text-[12px] ${tab === id ? "text-ink" : "text-ink-2 hover:text-ink"}`}>
            {label}
            {tab === id && <span className="absolute inset-x-2 -bottom-px h-[2px] rounded bg-cyan" />}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "select" && <SelectTab />}
        {tab === "proximity" && <ProximityTab />}
        {tab === "compare" && <CompareTab />}
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ select
function SelectTab() {
  const { tracked, add, remove, clear, toggleVisible, isolate, isolated, command } = useTracking();
  const select = useApp((s) => s.select);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [label, setLabel] = useState("");
  const [res, setRes] = useState<{ total: number; items: CatalogItem[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!q.trim() && !cat && !label) {
      setRes(null);
      return;
    }
    setLoading(true);
    const id = setTimeout(() => {
      api
        .search({ q: q.trim(), category: cat, label, limit: 40 })
        .then((r) => {
          setRes(r);
          setErr(null);
        })
        .catch((e) => setErr((e as ApiError).message))
        .finally(() => setLoading(false));
    }, 220);
    return () => clearTimeout(id);
  }, [q, cat, label]);

  const ids = new Set(tracked.map((t) => t.id));
  const room = MAX_TRACKED - tracked.length;

  return (
    <div className="p-3">
      <div className="relative">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <input className="input h-9 w-full pl-8" placeholder="Name, NORAD ID or COSPAR ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search satellites" />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <select className="input" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Object category">
          <option value="">Any object type</option>
          {ALL_CATEGORIES.map((c) => (
            <option key={c} value={c}>{CAT_LABEL[c]}</option>
          ))}
        </select>
        <select className="input" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Orbit class">
          <option value="">Any orbit class</option>
          {ORBIT_LABELS.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      </div>

      {err && <p className="mt-2 text-[11.5px] text-danger">{err}</p>}
      {res && (
        <div className="mt-2 rounded-lg border border-line-2">
          <div className="flex items-center justify-between border-b border-line-2 px-2.5 py-1.5 text-[11px] text-ink-2">
            <span>
              {loading ? <Loader2 size={11} className="mr-1 inline animate-spin" /> : null}
              {res.total.toLocaleString()} match{res.total === 1 ? "" : "es"}
              {res.total > res.items.length ? ` · showing ${res.items.length}` : ""}
            </span>
            <button
              className="text-cyan hover:underline disabled:text-muted disabled:no-underline"
              disabled={room <= 0}
              onClick={() => add(res.items.filter((i) => !ids.has(i.norad_id)).slice(0, room).map((i) => ({ id: i.norad_id, name: i.name })))}
              title={`Adds up to ${room} more (limit ${MAX_TRACKED})`}
            >
              Select all shown
            </button>
          </div>
          <ul className="max-h-[240px] overflow-y-auto">
            {res.items.map((it) => {
              const on = ids.has(it.norad_id);
              return (
                <li key={it.norad_id}>
                  <button
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-hover disabled:opacity-50"
                    disabled={!on && room <= 0}
                    onClick={() => (on ? remove(it.norad_id) : add([{ id: it.norad_id, name: it.name }]))}
                    aria-pressed={on}
                  >
                    {on ? <CheckSquare size={14} className="shrink-0 text-cyan" /> : <Square size={14} className="shrink-0 text-muted" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-ink">{it.name ?? "Unnamed object"}</span>
                      <span className="num text-[10px] text-muted">
                        {it.norad_id} · {CAT_LABEL[it.category]} · {fmt(it.perigee_alt_km, 0)}–{fmt(it.apogee_alt_km, 0)} km
                      </span>
                    </span>
                    <OrbitBadges labels={it.labels} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between">
        <span className="label-caps">
          Selected · {tracked.length}/{MAX_TRACKED}
        </span>
        <div className="flex gap-1.5">
          <button className="btn h-7 px-2" onClick={() => command("all")} disabled={!tracked.length} title="Show all selected satellites">
            <Focus size={12} /> All
          </button>
          <button className="btn h-7 px-2" onClick={() => command("reset")} title="Reset camera">
            <Home size={12} />
          </button>
          <button className="btn h-7 px-2" onClick={clear} disabled={!tracked.length}>
            Clear
          </button>
        </div>
      </div>
      {isolated !== null && (
        <div className="mt-2 flex items-center justify-between rounded-md border border-cyan/40 bg-cyan/5 px-2.5 py-1.5 text-[11.5px] text-cyan">
          Isolated: {tracked.find((t) => t.id === isolated)?.name ?? isolated}
          <button className="underline" onClick={() => isolate(null)}>Show all</button>
        </div>
      )}
      {tracked.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11.5px] leading-relaxed text-muted">
          Search above and tick satellites to follow them. Each gets its own colour, label and SGP4 orbit on the globe.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {tracked.map((t) => {
            const dim = isolated !== null ? isolated !== t.id : !t.visible;
            return (
              <li key={t.id} className={`flex items-center gap-2 rounded-lg border border-line-2 bg-panel px-2 py-1.5 ${dim ? "opacity-50" : ""}`}>
                <span className="h-3 w-3 shrink-0 rounded-full ring-2 ring-white/70" style={{ background: t.color }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-ink">{t.name ?? "Unnamed"}</span>
                  <span className="num text-[10px] text-muted">NORAD {t.id}</span>
                </span>
                <ChipBtn title={t.visible ? "Hide" : "Show"} onClick={() => toggleVisible(t.id)}>{t.visible ? <Eye size={12} /> : <EyeOff size={12} />}</ChipBtn>
                <ChipBtn title={isolated === t.id ? "Stop isolating" : "Isolate"} onClick={() => isolate(isolated === t.id ? null : t.id)} active={isolated === t.id}><Focus size={12} /></ChipBtn>
                <ChipBtn title="Zoom to satellite" onClick={() => command("focus", t.id)}><Crosshair size={12} /></ChipBtn>
                <ChipBtn title="Show full orbit" onClick={() => command("orbit", t.id)}><OrbitIcon size={12} /></ChipBtn>
                <ChipBtn title="Inspect" onClick={() => select(t.id)}><Info size={12} /></ChipBtn>
                <ChipBtn title="Remove" onClick={() => remove(t.id)}><X size={12} /></ChipBtn>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ChipBtn({ title, onClick, children, active }: { title: string; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <button className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-2 hover:bg-hover hover:text-ink ${active ? "bg-cyan/15 text-cyan" : ""}`} title={title} aria-label={title} onClick={onClick}>
      {children}
    </button>
  );
}

// --------------------------------------------------------------- proximity
function ProximityTab() {
  const st = useTracking();
  const can = useCan();
  const canPredict = can("proximity:predict");
  const shown = shownTracked(st);
  const ids = shown.map((t) => t.id);
  const idsKey = ids.join(",");
  const catsKey = st.categories.join(",");
  const [custom, setCustom] = useState("");
  const [customH, setCustomH] = useState("");
  const [cur, setCur] = useState<ProximityScreen | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<ProximityJob | null>(null);
  const setNearby = st.setNearby;

  // CURRENT: re-screen whenever inputs change and every 5 s as the simulation clock advances
  useEffect(() => {
    if (st.mode !== "current" || !st.proximityOn || !ids.length || !st.categories.length) {
      if (st.mode === "current") {
        setCur(null);
        setNearby(new Map());
      }
      return;
    }
    let alive = true;
    const run = () => {
      setBusy(true);
      api
        .proximityScreen({ norad_ids: ids, at: simTimeISO(), radius_km: st.radiusKm, categories: st.categories.length === ALL_CATEGORIES.length ? null : st.categories, limit: 200, offset: 0 })
        .then((r) => {
          if (!alive) return;
          setCur(r);
          setErr(null);
          const m = new Map<number, { kind: "near" | "high"; category: Category; of: number }>();
          for (const g of r.results) for (const it of g.items) m.set(it.norad_id, { kind: it.conjunction?.priority === "HIGH" ? "high" : "near", category: it.category, of: g.norad_id });
          setNearby(m);
        })
        .catch((e) => alive && setErr((e as ApiError).message))
        .finally(() => alive && setBusy(false));
    };
    run();
    const t = setInterval(run, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.mode, st.proximityOn, idsKey, st.radiusKm, catsKey]);

  // FUTURE: poll a background job
  useEffect(() => {
    if (!job || job.status === "succeeded" || job.status === "failed") return;
    const t = setInterval(() => api.proximityJob(job.id).then(setJob).catch((e) => setErr((e as ApiError).message)), 1000);
    return () => clearInterval(t);
  }, [job]);
  useEffect(() => {
    if (st.mode !== "future") return;
    if (job?.status !== "succeeded" || !job.result) return setNearby(new Map());
    const m = new Map<number, { kind: "near" | "high"; category: Category; of: number }>();
    for (const g of job.result.satellites) for (const w of g.windows) m.set(w.norad_id, { kind: w.conjunction?.priority === "HIGH" ? "high" : "near", category: w.category, of: g.norad_id });
    setNearby(m);
  }, [job, st.mode, setNearby]);

  const predict = async () => {
    setErr(null);
    try {
      const r = await api.proximityPredict({ norad_ids: ids, start: simTimeISO(), horizon_h: st.horizonH, radius_km: Math.min(st.radiusKm, 200), step_s: 60, categories: st.categories.length === ALL_CATEGORIES.length ? null : st.categories });
      setJob(await api.proximityJob(r.job_id));
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };

  const toggleCat = (c: Category) => st.set({ categories: st.categories.includes(c) ? st.categories.filter((x) => x !== c) : [...st.categories, c] });

  return (
    <div className="p-3">
      <div className="mb-3 rounded-md border border-line-2 bg-panel px-2.5 py-2 text-[11px] leading-relaxed text-ink-2">
        <span className="font-semibold text-ink">Proximity is distance, not risk.</span> Objects are found by true 3D separation at a common time (same SGP4/TEME frame). Collision probability needs covariance:{" "}
        <a href="/collision" className="text-cyan hover:underline">Collision Assessment</a>.
      </div>

      <Row label="Nearby-object detection">
        <Toggle on={st.proximityOn} onChange={() => st.set({ proximityOn: !st.proximityOn })} />
      </Row>

      <div className="label-caps mb-1.5 mt-3">Radius</div>
      <div className="flex flex-wrap gap-1.5">
        {RADII.map((r) => (
          <Pill key={r} on={st.radiusKm === r} onClick={() => { st.set({ radiusKm: r }); setCustom(""); }}>{r} km</Pill>
        ))}
        <input
          className="input h-7 w-[90px]"
          type="number"
          min={0.1}
          max={st.mode === "future" ? 200 : 2000}
          step="any"
          placeholder="Custom km"
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            const v = Number(e.target.value);
            if (v > 0 && v <= (st.mode === "future" ? 200 : 2000)) st.set({ radiusKm: v });
          }}
          aria-label="Custom radius in km"
        />
      </div>

      <div className="label-caps mb-1.5 mt-3">Object types</div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        {ALL_CATEGORIES.map((c) => (
          <label key={c} className="flex cursor-pointer items-center gap-2 text-[11.5px] text-ink">
            <input type="checkbox" className="accent-cyan" checked={st.categories.includes(c)} onChange={() => toggleCat(c)} />
            <span className="h-2 w-2 rounded-full" style={{ background: CAT_COLOR[c] }} />
            {CAT_LABEL[c]}
          </label>
        ))}
      </div>

      <div className="label-caps mb-1.5 mt-3">Mode</div>
      <div className="grid grid-cols-2 gap-1 rounded-lg border border-line-2 p-1">
        {(["current", "future"] as const).map((m) => (
          <button key={m} className={`rounded-md py-1.5 text-[12px] ${st.mode === m ? "bg-elevated text-ink" : "text-ink-2 hover:text-ink"}`} onClick={() => st.set({ mode: m })} disabled={m === "future" && !canPredict} title={m === "future" && !canPredict ? "Not available for your role" : undefined}>
            {m === "current" ? "Current (at sim time)" : "Future (horizon)"}
          </button>
        ))}
      </div>

      {st.mode === "future" && (
        <>
          <div className="label-caps mb-1.5 mt-3">Prediction horizon</div>
          <div className="flex flex-wrap gap-1.5">
            {HORIZONS.map((h) => (
              <Pill key={h} on={st.horizonH === h} onClick={() => { st.set({ horizonH: h }); setCustomH(""); }}>{h} h</Pill>
            ))}
            <input className="input h-7 w-[84px]" type="number" min={0.1} max={72} step="any" placeholder="Custom h" value={customH} onChange={(e) => { setCustomH(e.target.value); const v = Number(e.target.value); if (v > 0 && v <= 72) st.set({ horizonH: v }); }} aria-label="Custom horizon in hours" />
          </div>
          {st.radiusKm > 200 && <p className="mt-1.5 text-[11px] text-warn">Future screening is limited to 200 km; 200 km will be used.</p>}
          <button className="btn btn-primary mt-3 w-full justify-center" disabled={!ids.length || !st.categories.length || (job !== null && (job.status === "queued" || job.status === "running"))} onClick={predict}>
            {job && (job.status === "queued" || job.status === "running") ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            Predict closest approaches for {ids.length} satellite{ids.length === 1 ? "" : "s"}
          </button>
          {job && (job.status === "queued" || job.status === "running") && (
            <div className="mt-2 h-1 overflow-hidden rounded bg-hover">
              <div className="h-full bg-cyan transition-all" style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </div>
          )}
        </>
      )}

      <Layers />

      {err && <p className="mt-3 text-[11.5px] text-danger">{err}</p>}
      {!ids.length ? (
        <p className="mt-4 rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11.5px] text-muted">Select satellites on the Satellites tab first.</p>
      ) : st.mode === "current" ? (
        <CurrentResults r={cur} busy={busy} />
      ) : (
        <FutureResults job={job} />
      )}
    </div>
  );
}

function Layers() {
  const { layers, toggleLayer, command, tracked, isolated } = useTracking();
  const first = isolated ?? tracked.find((t) => t.visible)?.id;
  const items: [keyof typeof layers, string, string?][] = [
    ["labels", "Labels"],
    ["orbits", "Satellite orbits", "#4DA3FF"],
    ["boundary", "Proximity boundary"],
    ["debris", "Nearby debris", NEAR_COLOR],
    ["otherNearby", "Other nearby objects", NEAR_COLOR],
    ["nearbyPaths", "Nearby trajectories", NEAR_COLOR],
  ];
  return (
    <div className="mt-4 rounded-lg border border-line-2 p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="label-caps">Visualisation</span>
        <div className="flex gap-1">
          <button className="btn h-6 px-2 text-[11px]" disabled={first === undefined} onClick={() => first !== undefined && command("focus", first)}>
            <Crosshair size={11} /> Focus
          </button>
          <button className="btn h-6 px-2 text-[11px]" disabled={!tracked.length} onClick={() => command("all")}>All</button>
          <button className="btn h-6 px-2 text-[11px]" onClick={() => command("reset")}><Home size={11} /></button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-2">
        {items.map(([k, label, color]) => (
          <label key={k} className="flex cursor-pointer items-center gap-2 py-0.5 text-[11.5px] text-ink">
            <input type="checkbox" className="accent-cyan" checked={layers[k]} onChange={() => toggleLayer(k)} />
            {color && <span className="h-2 w-2 rounded-full" style={{ background: color }} />}
            {label}
          </label>
        ))}
        <label className="col-span-2 flex items-center gap-2 py-0.5 text-[11.5px] text-muted" title="TLE/SGP4 element sets carry no covariance">
          <input type="checkbox" disabled /> Uncertainty: not available (no covariance in TLE data)
        </label>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-ink-2">
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-cyan" /> selected</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: NEAR_COLOR }} /> nearby</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: HIGH_COLOR }} /> HIGH-priority screened conjunction</span>
      </div>
    </div>
  );
}

function CurrentResults({ r, busy }: { r: ProximityScreen | null; busy: boolean }) {
  if (!r) return <div className="mt-4 flex items-center gap-2 text-[11.5px] text-ink-2">{busy && <Loader2 size={12} className="animate-spin" />} Screening…</div>;
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between text-[11px] text-ink-2">
        <span>
          CURRENT · {utc(r.time)} {busy && <Loader2 size={11} className="ml-1 inline animate-spin" />}
        </span>
        <span>{r.unique_nearby_objects} unique object{r.unique_nearby_objects === 1 ? "" : "s"}</span>
      </div>
      {r.results.map((g) => (
        <Group key={g.norad_id} id={g.norad_id} title={g.satellite?.name ?? String(g.norad_id)} total={g.total} counts={g.counts} status={g.status} message={g.message}>
          {(page) => g.items.slice(page * PAGE, (page + 1) * PAGE).map((it) => <CurrentRow key={it.norad_id} it={it} />)}
        </Group>
      ))}
      <p className="mt-2 text-[10.5px] leading-relaxed text-muted">{r.uncertainty}</p>
    </div>
  );
}

function FutureResults({ job }: { job: ProximityJob | null }) {
  if (!job) return <p className="mt-4 text-[11.5px] text-muted">Choose a horizon and run a prediction. It runs in the background on the server.</p>;
  if (job.status === "failed") return <p className="mt-4 text-[11.5px] text-danger">Prediction failed: {job.message}</p>;
  if (job.status !== "succeeded" || !job.result) return <p className="mt-4 text-[11.5px] text-ink-2">Propagating {job.params.horizon_h} h… {Math.round(job.progress * 100)}%</p>;
  return (
    <div className="mt-4">
      <div className="mb-2 text-[11px] text-ink-2">
        FUTURE · {utc(job.result.start, false)} → {utc(job.result.end, false)} · ≤ {job.params.radius_km} km
      </div>
      {job.result.satellites.map((g) => (
        <Group key={g.norad_id} id={g.norad_id} title={g.satellite?.name ?? String(g.norad_id)} total={g.total} status={g.status === "warnings" ? "ok" : g.status} message={g.warnings?.join("; ")}>
          {(page) => g.windows.slice(page * PAGE, (page + 1) * PAGE).map((w, i) => <FutureRow key={`${w.norad_id}-${i}`} w={w} />)}
        </Group>
      ))}
      <p className="mt-2 text-[10.5px] leading-relaxed text-muted">
        Closest approach from bounded Brent refinement on SGP4; entry/exit are root-finds on |Δr| = R. {job.result.uncertainty}
      </p>
    </div>
  );
}

function Group({ id, title, total, counts, status, message, children }: { id: number; title: string; total: number; counts?: Partial<Record<Category, number>>; status: string; message?: string; children: (page: number) => React.ReactNode }) {
  const color = useTracking((s) => s.tracked.find((t) => t.id === id)?.color ?? "#36D6E8");
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const shownTotal = Math.min(total, 200);
  useEffect(() => setPage((p) => Math.min(p, pages - 1)), [pages]);
  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-line-2">
      <div className="flex items-center justify-between gap-2 border-b border-line-2 bg-panel px-2.5 py-1.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
          <span className="truncate text-[12px] text-ink">{title}</span>
        </span>
        <span className="num shrink-0 text-[11px]" style={{ color: total ? NEAR_COLOR : "var(--color-ink-2)" }}>
          {status === "ok" ? `${total} nearby` : status}
        </span>
      </div>
      {message && <div className="px-2.5 py-1.5 text-[11px] text-warn">{message}</div>}
      {counts && total > 0 && (
        <div className="flex flex-wrap gap-x-2.5 px-2.5 pt-1.5 text-[10.5px] text-ink-2">
          {(Object.entries(counts) as [Category, number][]).map(([c, n]) => (
            <span key={c}>{CAT_LABEL[c]} <span className="num text-ink">{n}</span></span>
          ))}
        </div>
      )}
      {status === "ok" && total === 0 ? <div className="px-2.5 py-2 text-[11.5px] text-muted">Nothing within the radius.</div> : <ul className="divide-y divide-line-2/70">{children(page)}</ul>}
      {pages > 1 && (
        <div className="flex items-center justify-between px-2.5 py-1.5 text-[10.5px] text-ink-2">
          <span>Page {page + 1} / {Math.ceil(shownTotal / PAGE)}{total > 200 ? ` (first 200 of ${total})` : ""}</span>
          <span className="flex gap-1">
            <button className="btn h-6 px-2" disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button>
            <button className="btn h-6 px-2" disabled={(page + 1) * PAGE >= shownTotal} onClick={() => setPage(page + 1)}>›</button>
          </span>
        </div>
      )}
    </div>
  );
}

function TypeDot({ c }: { c: Category }) {
  return <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: CAT_COLOR[c] }} title={CAT_LABEL[c]} />;
}

function CurrentRow({ it }: { it: NearbyItem }) {
  const { nearbyPaths, toggleNearbyPath } = useTracking();
  const select = useApp((s) => s.select);
  const high = it.conjunction?.priority === "HIGH";
  return (
    <li className="flex gap-2 px-2.5 py-1.5">
      <TypeDot c={it.category} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[11.5px] text-ink">{it.name ?? "Unnamed"} <span className="num text-[10px] text-muted">{it.norad_id}</span></span>
          <span className="num shrink-0 text-[12px]" style={{ color: high ? HIGH_COLOR : NEAR_COLOR }}>{fmt(it.distance_km, it.distance_km < 10 ? 3 : 1)} km</span>
        </div>
        <div className="num flex flex-wrap items-center gap-x-2 text-[10px] text-ink-2">
          <span>{CAT_LABEL[it.category]}</span>
          <span>v_rel {fmt(it.relative_speed_kms, 3)} km/s</span>
          <span className={it.motion === "closing" ? "text-warn" : ""}>{it.motion} {fmt(Math.abs(it.range_rate_kms), 3)}</span>
          <span title="Relative position in the selected satellite's RTN frame">RTN [{it.r_rel_rtn_km.map((x) => fmt(x, 1)).join(", ")}]</span>
          <FreshnessBadge f={it.freshness} />
          {it.conjunction && <span style={{ color: high ? HIGH_COLOR : undefined }}>screened: {it.conjunction.priority}</span>}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-0.5">
        <ChipBtn title={nearbyPaths.has(it.norad_id) ? "Hide trajectory" : "Show trajectory"} onClick={() => toggleNearbyPath(it.norad_id)} active={nearbyPaths.has(it.norad_id)}><Route size={11} /></ChipBtn>
        <ChipBtn title="Inspect" onClick={() => select(it.norad_id)}><Info size={11} /></ChipBtn>
      </div>
    </li>
  );
}

function FutureRow({ w }: { w: FutureWindow }) {
  const { nearbyPaths, toggleNearbyPath } = useTracking();
  const select = useApp((s) => s.select);
  const high = w.conjunction?.priority === "HIGH";
  return (
    <li className="flex gap-2 px-2.5 py-1.5">
      <TypeDot c={w.category} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[11.5px] text-ink">{w.name ?? "Unnamed"} <span className="num text-[10px] text-muted">{w.norad_id}</span></span>
          <span className="num shrink-0 text-[12px]" style={{ color: high ? HIGH_COLOR : NEAR_COLOR }} title="Minimum predicted separation">min {fmt(w.min_distance_km, w.min_distance_km < 10 ? 3 : 1)} km</span>
        </div>
        <div className="num flex flex-wrap gap-x-2 text-[10px] text-ink-2">
          <span>TCA {utc(w.tca)}</span>
          <span>v_rel {fmt(w.relative_speed_kms, 3)} km/s</span>
          <span>{w.inside_at_start ? "inside at start" : `enters ${utc(w.entry, true).slice(11)}`}</span>
          <span>{w.exit ? `exits ${utc(w.exit, true).slice(11)}` : "inside at horizon end"}</span>
          <FreshnessBadge f={w.freshness} />
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-0.5">
        <ChipBtn title={nearbyPaths.has(w.norad_id) ? "Hide trajectory" : "Show trajectory"} onClick={() => toggleNearbyPath(w.norad_id)} active={nearbyPaths.has(w.norad_id)}><Route size={11} /></ChipBtn>
        <ChipBtn title="Inspect" onClick={() => select(w.norad_id)}><Info size={11} /></ChipBtn>
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ compare
function CompareTab() {
  const st = useTracking();
  const ids = st.tracked.map((t) => t.id);
  const [rows, setRows] = useState<CompareRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const key = useMemo(() => `${ids.join(",")}|${st.radiusKm}|${st.categories.join(",")}`, [ids, st.radiusKm, st.categories]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (!ids.length) return setRows(null);
    const run = () =>
      api
        .compare(ids, simTimeISO(), st.radiusKm, st.categories.length === ALL_CATEGORIES.length ? null : st.categories)
        .then((r) => {
          if (!alive.current) return;
          setRows(r.rows);
          setTime(r.time);
          setErr(null);
        })
        .catch((e) => alive.current && setErr((e as ApiError).message));
    run();
    const t = setInterval(run, 10000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!ids.length) return <p className="m-3 rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11.5px] text-muted">Select two or more satellites to compare them.</p>;
  const color = (id: number) => st.tracked.find((t) => t.id === id)?.color;
  return (
    <div className="p-3">
      {err && <p className="mb-2 text-[11.5px] text-danger">{err}</p>}
      <div className="mb-2 text-[11px] text-ink-2">At {utc(time)} · nearby = within {st.radiusKm} km · click a row to focus</div>
      <div className="space-y-2">
        {(rows ?? []).map((r) => (
          <button key={r.norad_id} className="w-full rounded-lg border border-line-2 bg-panel p-2.5 text-left hover:border-line hover:bg-elevated" onClick={() => { st.isolate(null); st.command("focus", r.norad_id); }}>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color(r.norad_id) }} />
                <span className="truncate text-[12px] text-ink">{r.name ?? r.norad_id}</span>
              </span>
              {r.labels && <OrbitBadges labels={r.labels} />}
            </div>
            {r.status !== "ok" ? (
              <div className="text-[11px] text-danger">{r.message ?? r.status}</div>
            ) : (
              <div className="num grid grid-cols-3 gap-x-2 gap-y-1 text-[10.5px]">
                <Cell k="Altitude" v={`${fmt(r.altitude_km, 1)} km`} />
                <Cell k="Inclination" v={`${fmt(r.inclination_deg, 2)}°`} />
                <Cell k="Eccentricity" v={fmt(r.eccentricity, 5)} />
                <Cell k="Period" v={`${fmt(r.period_min, 1)} min`} />
                <Cell k="Position" v={`${fmt(r.position?.lat_deg, 1)}°, ${fmt(r.position?.lon_deg, 1)}°`} />
                <Cell k="Nearby" v={String(r.nearby_count ?? "—")} accent={r.nearby_count ? NEAR_COLOR : undefined} />
              </div>
            )}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[10.5px] text-muted">Altitude and position: SGP4 state at the simulation time (WGS-84). Inclination, eccentricity, period: SGP4 mean elements of the latest element set.</p>
    </div>
  );
}

function Cell({ k, v, accent }: { k: string; v: string; accent?: string }) {
  return (
    <div>
      <div className="font-sans text-[9.5px] uppercase tracking-wider text-muted">{k}</div>
      <div className="text-ink" style={{ color: accent }}>{v}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px] text-ink">{label}</span>
      {children}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button role="switch" aria-checked={on} onClick={onChange} className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-cyan/70" : "bg-line"}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`num h-7 rounded-md border px-2.5 text-[11.5px] ${on ? "border-cyan/60 bg-cyan/10 text-cyan" : "border-line-2 text-ink-2 hover:bg-hover hover:text-ink"}`} aria-pressed={on}>
      {children}
    </button>
  );
}
