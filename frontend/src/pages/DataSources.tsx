import { useEffect, useRef, useState } from "react";
import { CloudDownload, FileUp, RefreshCw } from "lucide-react";
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel, StatusIndicator } from "../components/ui";
import { api } from "../services/api";
import { useAsync } from "../services/useAsync";
import { useApp } from "../stores/app";
import { useCan } from "../stores/auth";
import { utc } from "../lib/format";
import type { IngestionRun } from "../types";

export function RunsTable({ runs }: { runs: IngestionRun[] }) {
  if (!runs.length) return <EmptyState title="No ingestion runs yet" />;
  return (
    <table className="w-full min-w-[820px] text-[12px]">
      <thead className="sticky top-0 bg-panel">
        <tr className="border-b border-line-2 text-left text-[10px] uppercase tracking-wider text-muted">
          <th className="px-3 py-2 font-semibold">Run</th>
          <th className="px-3 font-semibold">Source</th>
          <th className="px-3 font-semibold">Status</th>
          <th className="px-3 text-right font-semibold">New</th>
          <th className="px-3 text-right font-semibold">Dup.</th>
          <th className="px-3 text-right font-semibold">Rejected</th>
          <th className="px-3 font-semibold">Started</th>
          <th className="px-3 font-semibold">Details</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} className="border-b border-line-2/70 align-top">
            <td className="num px-3 py-2 text-ink-2">#{r.id}</td>
            <td className="px-3 py-2">
              <span className="text-ink">{r.source}</span>
              <span className="block text-[10.5px] text-muted">{r.provider}</span>
            </td>
            <td className="px-3 py-2"><StatusIndicator status={r.status} /></td>
            <td className="num px-3 py-2 text-right text-ok">{r.records_new}</td>
            <td className="num px-3 py-2 text-right text-ink-2">{r.records_duplicate}</td>
            <td className={`num px-3 py-2 text-right ${r.records_rejected ? "text-danger" : "text-ink-2"}`}>{r.records_rejected}</td>
            <td className="num px-3 py-2 text-[11px] text-ink-2">{utc(r.started_at)}</td>
            <td className="max-w-[340px] px-3 py-2 text-[11px] text-ink-2">
              {r.message ?? (r.raw_sha256 ? <span className="num text-muted" title={r.raw_sha256}>sha256 {r.raw_sha256.slice(0, 12)}… · {r.raw_bytes?.toLocaleString()} B</span> : "—")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DataSources() {
  const bump = useApp((s) => s.bumpData);
  const canIngest = useCan()("data:ingest");
  const providers = useAsync(() => api.providers(), []);
  const [groups, setGroups] = useState<string[]>(["stations"]);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<string>("");
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const runs = useAsync(() => api.runs(40), []);
  const active = (runs.data ?? []).some((r) => r.status === "queued" || r.status === "running");
  const prevActive = useRef(false);

  // Poll while jobs are queued/running; refresh catalog views when they finish.
  useEffect(() => {
    if (!active) {
      if (prevActive.current) bump();
      prevActive.current = false;
      return;
    }
    prevActive.current = true;
    const id = setInterval(runs.reload, 1500);
    return () => clearInterval(id);
  }, [active, runs.reload, bump]);

  const startCelestrak = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.ingestCelestrak(groups, force);
      setMsg({ kind: "ok", text: `Queued run${r.run_ids.length > 1 ? "s" : ""} ${r.run_ids.map((i) => `#${i}`).join(", ")}` });
      runs.reload();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const upload = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.upload(label.trim(), text, kind || null);
      setMsg({
        kind: r.status === "succeeded" ? "ok" : "err",
        text: `Upload run #${r.id}: ${r.records_new} new, ${r.records_duplicate} duplicate, ${r.records_rejected} rejected${r.message ? ` — ${r.message}` : ""}`,
      });
      if (r.status === "succeeded") {
        setText("");
        bump();
      }
      runs.reload();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setText(await f.text());
    if (!label) setLabel(f.name.replace(/\.[^.]+$/, ""));
  };

  return (
    <div>
      <PageHeader eyebrow="Data" title="DATA SOURCES" subtitle="Ingest real orbital data. Element sets are stored append-only with provenance; nothing is overwritten or fabricated." />

      {msg && (
        <div className={`mb-4 rounded-lg border px-3 py-2 text-[12px] ${msg.kind === "ok" ? "border-ok/40 bg-ok/5 text-ok" : "border-danger/40 bg-danger/5 text-danger"}`} role="status">
          {msg.text}
        </div>
      )}

      {!canIngest && (
        <div className="mb-4 rounded-lg border border-line-2 bg-panel px-3 py-2 text-[12px] text-ink-2">
          Read-only: your role can see data sources and ingestion history. Downloads and uploads are done by administrators and mission managers.
        </div>
      )}
      {canIngest && <div className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title="CelesTrak GP data" subtitle="Public, no authentication. Downloads are limited to once per 2 h per group.">
          {providers.error ? (
            <ErrorState message={providers.error} onRetry={providers.reload} />
          ) : !providers.data ? (
            <LoadingState />
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-2">
                {providers.data.celestrak.presets.map((pr) => (
                  <button key={pr.id} className="btn" onClick={() => setGroups(pr.groups)} title={pr.groups.join(", ")}>
                    {pr.label}
                  </button>
                ))}
                <button className="btn" onClick={() => setGroups([])}>
                  Clear
                </button>
              </div>
              <div className="max-h-[340px] space-y-3 overflow-y-auto pr-1">
                {Array.from(new Set(providers.data.celestrak.groups.map((g) => g.section))).map((section) => (
                  <div key={section}>
                    <div className="label-caps mb-1">{section}</div>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {providers.data!.celestrak.groups
                        .filter((g) => g.section === section)
                        .map((g) => (
                          <label key={g.id} className="flex cursor-pointer items-center gap-2.5 rounded-md border border-line-2 px-2.5 py-1.5 hover:bg-hover">
                            <input
                              type="checkbox"
                              className="accent-cyan"
                              checked={groups.includes(g.id)}
                              onChange={(e) => setGroups((s) => (e.target.checked ? [...s, g.id] : s.filter((x) => x !== g.id)))}
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-[12px] text-ink">{g.label}</span>
                              <span className="num text-[10px] text-muted">{g.id}</span>
                            </span>
                          </label>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-muted">
                Overlapping groups are fine: each object is stored once, with every element set kept as history. Data is fetched as {providers.data.celestrak.format}.
              </p>
              <div className="mt-3 flex items-center gap-3">
                <button className="btn btn-primary" disabled={!groups.length || busy} onClick={startCelestrak}>
                  <CloudDownload size={14} /> Ingest {groups.length} group{groups.length === 1 ? "" : "s"}
                </button>
                <label className="flex items-center gap-1.5 text-[11.5px] text-ink-2">
                  <input type="checkbox" className="accent-warn" checked={force} onChange={(e) => setForce(e.target.checked)} />
                  Ignore 2-hour refresh limit
                </label>
              </div>
            </>
          )}
        </Panel>

        <Panel title="Upload TLE file" subtitle="2-line or 3-line (named) format. Checksums are verified; failures are reported per line.">
          <div className="space-y-2.5">
            <div className="flex flex-wrap gap-2">
              <input className="input min-w-[200px] flex-1" placeholder="Source label (required)" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Source label" />
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Object kind">
                <option value="">Object kind: unknown</option>
                <option value="payload">All payloads</option>
                <option value="debris">All debris</option>
              </select>
              <input ref={fileRef} type="file" accept=".txt,.tle,.3le" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
              <button className="btn" onClick={() => fileRef.current?.click()}>
                <FileUp size={13} /> Choose file
              </button>
            </div>
            <textarea
              className="input num h-[150px] w-full resize-y py-2 text-[10.5px] leading-relaxed"
              placeholder={"ISS (ZARYA)\n1 25544U 98067A   ...\n2 25544  51.6416 ..."}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="TLE text"
            />
            <button className="btn btn-primary" disabled={!label.trim() || text.trim().length < 20 || busy} onClick={upload}>
              <FileUp size={14} /> Ingest upload
            </button>
          </div>
        </Panel>
      </div>}

      <Panel
        title="Ingestion runs"
        subtitle={active ? "Jobs in progress. Refreshing automatically." : undefined}
        bodyClassName="p-0 overflow-x-auto"
        actions={
          <button className="btn h-7" onClick={runs.reload}>
            <RefreshCw size={12} /> Refresh
          </button>
        }
      >
        {runs.error ? <ErrorState message={runs.error} onRetry={runs.reload} /> : !runs.data ? <LoadingState /> : <RunsTable runs={runs.data} />}
      </Panel>

      <Panel title="Other providers" className="mt-4">
        <ul className="space-y-2 text-[12px]">
          <li className="flex justify-between gap-4">
            <span className="text-ink">Space-Track.org (full catalog, TLE history, CDMs)</span>
            <span className="text-right text-muted">Not implemented yet. Needed for ALL debris and rocket bodies; requires a free account.</span>
          </li>
          <li className="flex justify-between gap-4">
            <span className="text-ink">ESA DISCOS (mass, size, shape)</span>
            <span className="text-muted">Not implemented. Needs an API token.</span>
          </li>
        </ul>
      </Panel>
    </div>
  );
}
