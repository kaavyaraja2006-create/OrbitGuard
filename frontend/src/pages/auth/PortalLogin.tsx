import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Loader2, LogIn } from "lucide-react";
import { AuthCard, AuthLayout, Field, Notice } from "../../components/auth/AuthLayout";
import { PasswordField } from "../../components/auth/PasswordField";
import { portalBySlug } from "../../lib/portals";
import { api, ApiError } from "../../services/api";
import { useAuth } from "../../stores/auth";

export function PortalLogin() {
  const { portal } = useParams();
  const meta = portalBySlug(portal);
  const nav = useNavigate();
  const loc = useLocation();
  const login = useAuth((s) => s.login);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  if (!meta) return <Navigate to="/login" replace />;
  const next = new URLSearchParams(loc.search).get("next");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setInfo(null);
    try {
      const me = await login(meta.slug, email.trim(), password, remember);
      const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : null;
      nav(me.must_change_password ? "/change-password" : safeNext ?? me.dashboard, { replace: true });
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2 : new ApiError(0, String(e2)));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    try {
      const r = await api.resendVerification(email.trim());
      setInfo(r.message);
      setErr(null);
    } catch (e2) {
      setErr(e2 as ApiError);
    }
  };

  const other = err?.code === "wrong_portal" ? portalBySlug(String(err.extra.portal)) : undefined;

  return (
    <AuthLayout
      accent={meta.accent}
      eyebrow={meta.short.toUpperCase()}
      headline={meta.label}
      blurb={meta.tagline}
      aside={
        <ul className="mt-5 space-y-1.5 text-[12px] text-ink-2">
          {meta.capabilities.map((c) => (
            <li key={c} className="flex gap-2">
              <span style={{ color: meta.accent }}>●</span>
              {c}
            </li>
          ))}
        </ul>
      }
    >
      <Link to="/login" className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-ink-2 hover:text-ink">
        <ArrowLeft size={13} /> All portals
      </Link>
      <AuthCard title={`${meta.label} sign-in`} subtitle={meta.restricted ? "Restricted portal. Accounts are issued by your administrator." : "Sign in to the public satellite tracker."} icon={<meta.icon size={18} />} accent={meta.accent}>
        {err && (
          <Notice kind="error">
            {err.message}
            {other && (
              <div className="mt-1.5">
                <Link to={`/login/${other.slug}`} className="font-medium underline" onClick={() => setErr(null)}>
                  Go to the {other.label} portal →
                </Link>
              </div>
            )}
            {err.code === "email_not_verified" && (
              <button type="button" className="mt-1.5 block font-medium underline" onClick={resend}>
                Send a new verification link
              </button>
            )}
            {err.code === "locked" && (
              <Link to="/forgot-password" className="mt-1.5 block font-medium underline">
                Reset password
              </Link>
            )}
          </Notice>
        )}
        {info && <Notice kind="ok">{info}</Notice>}
        <form onSubmit={submit} noValidate>
          <Field label="Work e-mail" htmlFor="email">
            <input id="email" type="email" className="input h-10 w-full text-[13px]" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required />
          </Field>
          <PasswordField value={password} onChange={setPassword} />
          <div className="mb-5 flex items-center justify-between text-[12px]">
            <label className="flex cursor-pointer items-center gap-2 text-ink-2">
              <input type="checkbox" className="accent-cyan" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Keep me signed in
            </label>
            <Link to="/forgot-password" className="text-ink-2 hover:text-ink">
              Forgot password?
            </Link>
          </div>
          <button className="btn btn-primary h-10 w-full justify-center text-[13px]" disabled={busy || !email || !password} style={{ borderColor: meta.accent }}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <LogIn size={15} />} Sign in
          </button>
        </form>
        {!meta.restricted && (
          <p className="mt-5 text-center text-[12px] text-ink-2">
            No account?{" "}
            <Link to="/register" className="text-cyan hover:underline">
              Create one
            </Link>
          </p>
        )}
      </AuthCard>
    </AuthLayout>
  );
}
