import { Link } from "react-router-dom";
import { ArrowRight, KeyRound } from "lucide-react";
import { AuthLayout } from "../../components/auth/AuthLayout";
import { PORTALS } from "../../lib/portals";

export function PortalHub() {
  return (
    <AuthLayout
      wide
      eyebrow="SECURE ACCESS"
      headline="One platform. Six mission roles. Each with its own door."
      blurb="Every role signs in through its own portal. The server checks that your account belongs to that portal and gives you only the permissions of your role."
    >
      <div className="mb-6">
        <h2 className="text-[22px] font-semibold tracking-tight text-ink">Choose your portal</h2>
        <p className="mt-1 text-[12.5px] text-ink-2">Accounts for restricted portals are issued by an administrator. Anyone can create a public account.</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {PORTALS.map((p) => (
          <Link
            key={p.slug}
            to={`/login/${p.slug}`}
            className="group panel relative flex flex-col overflow-hidden p-4 transition-all hover:-translate-y-0.5 hover:border-line hover:bg-elevated"
          >
            <span className="absolute inset-x-0 top-0 h-[2px] opacity-70 transition-opacity group-hover:opacity-100" style={{ background: `linear-gradient(90deg, ${p.accent}, transparent 80%)` }} />
            <div className="mb-3 flex items-center justify-between">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-line-2" style={{ color: p.accent, background: `color-mix(in srgb, ${p.accent} 10%, transparent)` }}>
                <p.icon size={17} />
              </span>
              <span className={`rounded px-1.5 py-0.5 text-[9.5px] font-semibold tracking-wider ${p.restricted ? "bg-hover text-ink-2" : "bg-cyan/10 text-cyan"}`}>
                {p.restricted ? "RESTRICTED" : "OPEN"}
              </span>
            </div>
            <div className="text-[13.5px] font-semibold text-ink">{p.label}</div>
            <div className="mt-1 text-[11.5px] leading-relaxed text-ink-2">{p.tagline}</div>
            <ul className="mt-3 flex-1 space-y-1 text-[11px] text-muted">
              {p.capabilities.map((c) => (
                <li key={c} className="flex gap-1.5">
                  <span style={{ color: p.accent }}>›</span> {c}
                </li>
              ))}
            </ul>
            <div className="mt-4 flex items-center justify-between text-[11.5px] font-medium" style={{ color: p.accent }}>
              <span className="num text-[10.5px] text-muted">/login/{p.slug}</span>
              <span className="flex items-center gap-1">
                Sign in <ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" />
              </span>
            </div>
          </Link>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-[12px]">
        <Link to="/forgot-password" className="flex items-center gap-1.5 text-ink-2 hover:text-ink">
          <KeyRound size={13} /> Forgot your password?
        </Link>
        <span className="text-ink-2">
          New here?{" "}
          <Link to="/register" className="text-cyan hover:underline">
            Create a public account
          </Link>
        </span>
      </div>
    </AuthLayout>
  );
}
