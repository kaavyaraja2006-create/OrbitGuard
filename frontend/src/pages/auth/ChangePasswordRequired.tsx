import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Loader2, ShieldAlert } from "lucide-react";
import { AuthCard, AuthLayout, Notice } from "../../components/auth/AuthLayout";
import { PasswordField, passwordChecks } from "../../components/auth/PasswordField";
import { api, ApiError } from "../../services/api";
import { useAuth } from "../../stores/auth";

/** Shown when an administrator created the account with an initial password. The API refuses all data calls until this is done. */
export function ChangePasswordRequired() {
  const me = useAuth((s) => s.me);
  const refresh = useAuth((s) => s.refresh);
  const logout = useAuth((s) => s.logout);
  const nav = useNavigate();
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!me) return <Navigate to="/login" replace />;
  if (!me.must_change_password) return <Navigate to={me.dashboard} replace />;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.changePassword(cur, pw);
      const m = await refresh();
      nav(m?.dashboard ?? "/", { replace: true });
    } catch (e2) {
      setErr((e2 as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout eyebrow="FIRST SIGN-IN" headline={`Welcome, ${me.full_name.split(" ")[0]}.`} blurb="Your administrator set a temporary password. Choose your own before continuing.">
      <AuthCard title="Choose your password" subtitle={`${me.role_label} · ${me.email}`} icon={<ShieldAlert size={18} />} accent="#F5B942">
        {err && <Notice kind="error">{err}</Notice>}
        <form onSubmit={submit}>
          <PasswordField value={cur} onChange={setCur} label="Temporary password" />
          <PasswordField value={pw} onChange={setPw} label="New password" autoComplete="new-password" showStrength email={me.email} name={me.full_name} />
          <PasswordField value={pw2} onChange={setPw2} label="Repeat new password" autoComplete="new-password" />
          <button className="btn btn-primary h-10 w-full justify-center text-[13px]" disabled={busy || !cur || pw !== pw2 || !passwordChecks(pw, me.email, me.full_name).every((c) => c.ok)}>
            {busy && <Loader2 size={15} className="animate-spin" />} Save and continue
          </button>
          <button type="button" className="mt-3 w-full text-center text-[12px] text-ink-2 hover:text-ink" onClick={() => logout().then(() => nav("/login"))}>
            Sign out instead
          </button>
        </form>
      </AuthCard>
    </AuthLayout>
  );
}
