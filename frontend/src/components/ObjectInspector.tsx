import { useState } from "react";
import { Check, Clock3, Copy, X } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../services/api";
import { useAsync } from "../services/useAsync";
import { simTimeISO, useApp } from "../stores/app";
import { ErrorState, FreshnessBadge, KV, LoadingState, OrbitBadges, ScientificValue, TypeBadge } from "./ui";
import { ageDays, utc } from "../lib/format";

const CRIT_UNIT: Record<string, string> = { LEO: "km (apogee alt)", MEO: "km (perigee alt)", GEO: "rev/day", POLAR: "deg", SSO: "deg/day", HEO: "(eccentricity)" };

const TABS = ["Overview", "Orbit", "State", "Classification", "Source"] as const;
type Tab = (typeof TABS)[number];

function Vec({ v, unit }: { v?: number[]; unit: string }) {
  if (!v) return <span className="text-muted">—</span>;
  return (
    <span className="num text-[11.5px] text-ink">
      [{v.map((x) => x.toFixed(4)).join(", ")}] <span className="text-muted">{unit}</span>
    </span>
  );
}

export function ObjectInspector({ id, onClose, variant = "drawer" }: { id: number; onClose?: () => void; variant?: "drawer" | "panel" }) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [copied, setCopied] = useState(false);
  const dataVersion = useApp((s) => s.dataVersion);
  const setSimTime = useApp((s) => s.setSimTime);
  const { data: d, error, loading, reload } = useAsync(() => api.object(id, simTimeISO()), [id, dataVersion], 5000);

  const shell =
    variant === "drawer"
      ? "fixed right-0 top-0 z-40 flex h-full w-full max-w-[440px] flex-col border-l border-line bg-sidebar shadow-2xl"
      : "flex h-full flex-col";

  return (
    <aside className={shell} aria-label="Object inspector">
      <header className="flex items-start justify-between gap-3 border-b border-line-2 px-4 py-3">
        <div className="min-w-0">
          <div className="label-caps">Object inspection</div>
          <h3 className="mt-1 truncate text-[16px] font-semibold text-ink">{d ? (d.name ?? `NORAD ${d.norad_id}`) : loading ? "Loading…" : `NORAD ${id}`}</h3>
          {d && (
            <div className="num mt-0.5 text-[11px] text-ink-2">
              NORAD {d.norad_id} · COSPAR {d.intl_designator || "—"}
            </div>
          )}
        </div>
        {onClose && (
          <button className="btn h-8 w-8 justify-center px-0" onClick={onClose} aria-label="Close inspector">
            <X size={14} />
          </button>
        )}
      </header>

      <div className="flex gap-1 border-b border-line-2 px-3" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-2 py-2 text-[11.5px] ${tab === t ? "border-cyan text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {error && !d ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !d ? (
          <LoadingState />
        ) : (
          <>
            {tab === "Overview" && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <OrbitBadges labels={d.classification?.labels ?? []} />
                  {d.classification?.geo_type && <span className="text-[11px] text-violet">{d.classification.geo_type}</span>}
                </div>
                <div className="divide-y divide-line-2">
                  <KV k="Object type" title={`Determined by: ${d.object_type.determined_by}`}>
                    <TypeBadge t={d.object_type.value} />
                  </KV>
                  <KV k="Type evidence">
                    <span className="text-[11px] text-muted">{d.object_type.determined_by}</span>
                  </KV>
                  <KV k="Operational status" title={d.operational_status.determined_by}>
                    <span className={d.operational_status.value === "UNKNOWN" ? "text-muted" : "text-ok"}>{d.operational_status.value}</span>
                  </KV>
                  <KV k="Mass">
                    <span className="text-muted">NOT AVAILABLE</span>
                  </KV>
                  <KV k="Size">
                    <span className="text-muted">NOT AVAILABLE</span>
                  </KV>
                </div>
                {d.state.geodetic ? (
                  <div className="rounded-lg border border-line-2 bg-panel p-3">
                    <div className="label-caps mb-2">Position at {utc(d.state.time)}</div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <div className="text-[10.5px] text-ink-2">Altitude</div>
                        <ScientificValue value={d.state.geodetic.alt_km} unit="km" digits={1} className="text-[15px]" />
                      </div>
                      <div>
                        <div className="text-[10.5px] text-ink-2">Latitude</div>
                        <ScientificValue value={d.state.geodetic.lat_deg} unit="°" digits={3} className="text-[15px]" />
                      </div>
                      <div>
                        <div className="text-[10.5px] text-ink-2">Longitude</div>
                        <ScientificValue value={d.state.geodetic.lon_deg} unit="°" digits={3} className="text-[15px]" />
                      </div>
                    </div>
                    <div className="mt-2 text-[10.5px] text-ink-2">
                      Speed <ScientificValue value={d.state.speed_kms ?? null} unit="km/s" digits={3} /> (TEME inertial)
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-[12px] text-danger">
                    SGP4 propagation failed at this time: {d.state.sgp4_error} (code {d.state.sgp4_error_code})
                  </div>
                )}
                <div className="divide-y divide-line-2">
                  <KV k="Element epoch">
                    <span className="num">{utc(d.element_set.epoch)}</span>
                  </KV>
                  <KV k="Element age">
                    <span className="flex items-center gap-2">
                      <span className="num">{ageDays(d.element_set.age_days)}</span>
                      <FreshnessBadge f={d.element_set.freshness} />
                    </span>
                  </KV>
                </div>
                {d.element_set.age_days > 14 && (
                  <div className="rounded-md border border-warn/40 bg-warn/5 p-2.5 text-[11px] text-warn">
                    Element set is {d.element_set.age_days.toFixed(0)} days old. SGP4 error grows with time from epoch, so positions far from it are approximate or may fail.
                    <button className="btn mt-2 h-7" onClick={() => setSimTime(new Date(d.element_set.epoch).getTime())}>
                      <Clock3 size={12} /> Set clock to element epoch
                    </button>
                  </div>
                )}
              </div>
            )}

            {tab === "Orbit" && (
              <div className="space-y-4">
                <div>
                  <div className="label-caps mb-1">Mean elements</div>
                  <p className="mb-1 text-[10.5px] text-muted">{d.mean_elements.kind}. Used for classification, not comparable with osculating values.</p>
                  <div className="divide-y divide-line-2">
                    <KV k="Semi-major axis a"><ScientificValue value={d.mean_elements.a_km} unit="km" /></KV>
                    <KV k="Eccentricity e"><ScientificValue value={d.mean_elements.e} digits={7} /></KV>
                    <KV k="Inclination i"><ScientificValue value={d.mean_elements.i_deg} unit="°" digits={4} /></KV>
                    <KV k="RAAN Ω"><ScientificValue value={d.mean_elements.raan_deg} unit="°" digits={4} /></KV>
                    <KV k="Arg. of perigee ω"><ScientificValue value={d.mean_elements.argp_deg} unit="°" digits={4} /></KV>
                    <KV k="Mean anomaly M"><ScientificValue value={d.mean_elements.mean_anomaly_deg} unit="°" digits={4} /></KV>
                    <KV k="Mean motion"><ScientificValue value={d.mean_elements.mean_motion_rev_day} unit="rev/day" digits={8} /></KV>
                  </div>
                </div>
                <div>
                  <div className="label-caps mb-1">Derived parameters</div>
                  <div className="divide-y divide-line-2">
                    <KV k="Perigee altitude"><ScientificValue value={d.derived.perigee_altitude_km} unit="km" digits={2} /></KV>
                    <KV k="Apogee altitude"><ScientificValue value={d.derived.apogee_altitude_km} unit="km" digits={2} /></KV>
                    <KV k="Period"><ScientificValue value={d.derived.period_min} unit="min" digits={3} /></KV>
                    <KV k="Specific energy"><ScientificValue value={d.derived.specific_energy_km2_s2} unit="km²/s²" /></KV>
                    <KV k="Angular momentum"><ScientificValue value={d.derived.specific_angular_momentum_km2_s} unit="km²/s" digits={1} /></KV>
                    <KV k="RAAN rate (J2)"><ScientificValue value={d.derived.raan_rate_deg_day} unit="°/day" digits={4} /></KV>
                    <KV k="Apsidal rate (J2)"><ScientificValue value={d.derived.argp_rate_deg_day} unit="°/day" digits={4} /></KV>
                    <KV k="v at perigee"><ScientificValue value={d.derived.velocity_perigee_kms} unit="km/s" /></KV>
                    <KV k="v at apogee"><ScientificValue value={d.derived.velocity_apogee_kms} unit="km/s" /></KV>
                  </div>
                </div>
                {d.state.osculating_elements && (
                  <div>
                    <div className="label-caps mb-1">Osculating elements at {utc(d.state.time, false)}</div>
                    <div className="divide-y divide-line-2">
                      <KV k="a"><ScientificValue value={d.state.osculating_elements.a_km} unit="km" /></KV>
                      <KV k="e"><ScientificValue value={d.state.osculating_elements.e} digits={7} /></KV>
                      <KV k="i"><ScientificValue value={d.state.osculating_elements.i_deg} unit="°" digits={4} /></KV>
                      <KV k="True anomaly ν">
                        {d.state.osculating_elements.undefined.includes("nu") ? <span className="text-muted">undefined (circular)</span> : <ScientificValue value={d.state.osculating_elements.nu_deg} unit="°" digits={4} />}
                      </KV>
                    </div>
                  </div>
                )}
                {d.history.length > 1 && (
                  <div>
                    <div className="label-caps mb-2">Element history ({d.history.length} sets)</div>
                    <div className="h-[140px]">
                      <ResponsiveContainer>
                        <LineChart data={d.history.map((h) => ({ t: h.epoch.slice(0, 10), perigee: h.perigee_alt_km, apogee: h.apogee_alt_km }))}>
                          <CartesianGrid stroke="#1A2639" />
                          <XAxis dataKey="t" tick={{ fill: "#64748B", fontSize: 10 }} />
                          <YAxis tick={{ fill: "#64748B", fontSize: 10 }} width={48} unit=" km" />
                          <Tooltip contentStyle={{ background: "#121D30", border: "1px solid #223149", fontSize: 11 }} />
                          <Line dataKey="perigee" stroke="#4DA3FF" dot={false} isAnimationActive={false} />
                          <Line dataKey="apogee" stroke="#36D6E8" dot={false} isAnimationActive={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === "State" && (
              <div className="space-y-4 text-[12px]">
                {d.state.teme ? (
                  <>
                    <div>
                      <div className="label-caps mb-1">TEME (SGP4 native frame)</div>
                      <KV k="r"><Vec v={d.state.teme.r_km} unit="km" /></KV>
                      <KV k="v"><Vec v={d.state.teme.v_kms} unit="km/s" /></KV>
                    </div>
                    <div>
                      <div className="label-caps mb-1">Earth-fixed</div>
                      <p className="mb-1 text-[10.5px] text-muted">{d.state.itrf?.frame}</p>
                      <KV k="r"><Vec v={d.state.itrf?.r_km} unit="km" /></KV>
                      <KV k="v"><Vec v={d.state.itrf?.v_kms} unit="km/s" /></KV>
                    </div>
                    <p className="text-[10.5px] leading-relaxed text-muted">
                      State propagated with SGP4 at {utc(d.state.time)} from the element set dated {utc(d.element_set.epoch)}.
                    </p>
                  </>
                ) : (
                  <ErrorState message={`SGP4 error ${d.state.sgp4_error_code}: ${d.state.sgp4_error}`} />
                )}
              </div>
            )}

            {tab === "Classification" && d.classification && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <OrbitBadges labels={d.classification.labels} />
                  <span className="num text-[10px] text-muted">{d.classification.algorithm_version}</span>
                </div>
                <ul className="space-y-1.5">
                  {d.classification.criteria.map((c) => (
                    <li key={c.label} className={`rounded-md border px-2.5 py-2 ${c.passed ? "border-ok/30 bg-ok/5" : "border-line-2"}`}>
                      <div className="flex items-center justify-between">
                        <span className="text-[12px] font-semibold text-ink">{c.label}</span>
                        {c.passed ? <span className="text-[11px] text-ok">✓ match</span> : <span className="text-[11px] text-muted">no match</span>}
                      </div>
                      <div className="mt-0.5 text-[10.5px] text-ink-2">{c.rule}</div>
                      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="num text-[11.5px] text-ink">
                          {c.value === null ? "—" : c.value.toFixed(c.label === "HEO" ? 5 : 3)}
                          <span className="ml-1 text-[10px] text-muted">{CRIT_UNIT[c.label]}</span>
                        </span>
                        <span className="num text-[10.5px] text-muted">{c.threshold}</span>
                      </div>
                    </li>
                  ))}
                </ul>
                <KV k="Regions crossed">
                  <span className="num">{d.classification.regions_crossed.join(", ") || "—"}</span>
                </KV>
                {d.classification.warnings.map((w) => (
                  <p key={w} className="rounded-md border border-warn/40 bg-warn/5 p-2 text-[11px] text-warn">
                    {w}
                  </p>
                ))}
              </div>
            )}

            {tab === "Source" && (
              <div className="space-y-3">
                <div className="divide-y divide-line-2">
                  <KV k="Provider"><span>{d.element_set.provenance.provider}</span></KV>
                  <KV k="Source"><span>{d.element_set.provenance.source}</span></KV>
                  <KV k="Retrieved"><span className="num">{utc(d.element_set.provenance.retrieved_at)}</span></KV>
                  <KV k="Ingestion run"><span className="num">#{d.element_set.provenance.ingestion_run_id}</span></KV>
                  <KV k="B* drag term"><ScientificValue value={d.element_set.bstar} unit="1/ER" digits={4} /></KV>
                  <KV k="Revolution #"><span className="num">{d.element_set.rev_number}</span></KV>
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="label-caps">Raw element set</span>
                    <button
                      className="btn h-7"
                      onClick={() => {
                        navigator.clipboard?.writeText(`${d.element_set.line1}\n${d.element_set.line2}`);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1200);
                      }}
                    >
                      {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <pre className="num overflow-x-auto rounded-md border border-line-2 bg-app p-2.5 text-[10.5px] leading-relaxed text-ink-2">
                    {d.element_set.line1}
                    {"\n"}
                    {d.element_set.line2}
                  </pre>
                </div>
                {d.element_set.provenance.url && <p className="break-all text-[10.5px] text-muted">{d.element_set.provenance.url}</p>}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
