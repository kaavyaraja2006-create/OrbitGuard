import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";

/** URL-backed tabs (?tab=...), so a tab can be linked and survives reloads. */
export function Tabs({ tabs }: { tabs: { id: string; label: ReactNode; content: ReactNode }[] }) {
  const [params, setParams] = useSearchParams();
  const active = tabs.find((t) => t.id === params.get("tab")) ?? tabs[0]!;
  return (
    <div>
      <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-line-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === active.id}
            onClick={() => setParams((p) => { p.set("tab", t.id); return p; }, { replace: true })}
            className={`relative whitespace-nowrap px-3.5 py-2.5 text-[12.5px] transition-colors ${t.id === active.id ? "text-ink" : "text-ink-2 hover:text-ink"}`}
          >
            {t.label}
            {t.id === active.id && <span className="absolute inset-x-2 -bottom-px h-[2px] rounded bg-cyan" />}
          </button>
        ))}
      </div>
      <div role="tabpanel">{active.content}</div>
    </div>
  );
}

export function Modal({ title, onClose, children, width = 520 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[8vh] backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className="panel w-full shadow-2xl" style={{ maxWidth: width }}>
        <div className="flex items-center justify-between border-b border-line-2 px-5 py-3">
          <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
          <button className="text-[18px] leading-none text-muted hover:text-ink" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
