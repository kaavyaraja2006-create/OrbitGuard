import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Lock } from "lucide-react";
import { Logo } from "../AppSidebar";
import { OrbitalScene } from "./OrbitalScene";
import { SpaceBackground } from "../fx/SpaceBackground";

export function AuthLayout({
  children,
  accent = "#36D6E8",
  eyebrow,
  headline,
  blurb,
  aside,
  wide = false,
}: {
  children: ReactNode;
  accent?: string;
  eyebrow?: string;
  headline?: ReactNode;
  blurb?: ReactNode;
  aside?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-full bg-app">
      <div className="relative hidden w-[46%] max-w-[760px] overflow-hidden border-r border-line-2 bg-[#050912] lg:block">
        <SpaceBackground density={0.00012} />
        <div className="absolute inset-0 tech-grid opacity-25" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_45%,rgba(54,214,232,0.08),transparent_70%)]" />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="aspect-square w-[118%] -translate-y-[6%] opacity-95">
            <OrbitalScene accent={accent} />
          </div>
        </div>
        <div className="absolute inset-x-0 top-0 p-8">
          <Link to="/welcome" aria-label="ORBITGUARD home">
            <Logo collapsed={false} />
          </Link>
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#050912] via-[#050912]/90 to-transparent p-10 pt-24">
          {eyebrow && (
            <div className="mb-2 text-[10.5px] font-semibold tracking-[0.22em]" style={{ color: accent }}>
              {eyebrow}
            </div>
          )}
          {headline && <h1 className="font-display max-w-[460px] text-[30px] font-semibold leading-tight tracking-tight text-ink">{headline}</h1>}
          {blurb && <div className="mt-3 max-w-[460px] text-[13px] leading-relaxed text-ink-2">{blurb}</div>}
          {aside}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-6 py-5 lg:hidden">
          <Link to="/login">
            <Logo collapsed={false} />
          </Link>
        </div>
        <div className="flex flex-1 items-center justify-center px-5 py-8">
          <div className={`w-full ${wide ? "max-w-[980px]" : "max-w-[420px]"}`}>{children}</div>
        </div>
        <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-6 pb-5 text-[10.5px] text-muted">
          <span className="flex items-center gap-1.5">
            <Lock size={11} /> Session cookie is HttpOnly; passwords are scrypt-hashed server-side
          </span>
          <span>ORBITGUARD research platform · never commands real spacecraft</span>
        </footer>
      </div>
    </div>
  );
}

export function AuthCard({ title, subtitle, children, icon, accent }: { title: string; subtitle?: ReactNode; children: ReactNode; icon?: ReactNode; accent?: string }) {
  return (
    <div className="panel og-enter relative overflow-hidden p-7 shadow-2xl shadow-black/40">
      <span className="absolute inset-x-0 top-0 h-[2px]" style={{ background: `linear-gradient(90deg, ${accent ?? "var(--color-cyan)"}, transparent 75%)` }} />
      <div className="mb-6 flex items-start gap-3">
        {icon && (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line" style={{ color: accent, background: `color-mix(in srgb, ${accent} 10%, transparent)` }}>
            {icon}
          </span>
        )}
        <div>
          <h2 className="text-[19px] font-semibold tracking-tight text-ink">{title}</h2>
          {subtitle && <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{subtitle}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

export function Notice({ kind, children }: { kind: "error" | "ok" | "info" | "warn"; children: ReactNode }) {
  const c = { error: "border-danger/40 bg-danger/[0.07] text-danger", ok: "border-ok/40 bg-ok/[0.07] text-ok", info: "border-blue/40 bg-blue/[0.07] text-ink", warn: "border-warn/40 bg-warn/[0.07] text-warn" }[kind];
  return (
    <div role={kind === "error" ? "alert" : "status"} className={`mb-4 rounded-lg border px-3 py-2.5 text-[12px] leading-relaxed ${c}`}>
      {children}
    </div>
  );
}

export function Field({ label, children, hint, htmlFor }: { label: string; children: ReactNode; hint?: ReactNode; htmlFor?: string }) {
  return (
    <div className="mb-4">
      <label htmlFor={htmlFor} className="mb-1.5 block text-[11.5px] font-medium text-ink-2">
        {label}
      </label>
      {children}
      {hint && <div className="mt-1 text-[10.5px] text-muted">{hint}</div>}
    </div>
  );
}
