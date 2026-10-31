import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { AuthCard, AuthLayout, Notice } from "../../components/auth/AuthLayout";
import { PasswordField, passwordChecks } from "../../components/auth/PasswordField";
import { api, ApiError } from "../../services/api";
import { LoadingState } from "../../components/ui";

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.tokenInfo>> | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [portal, setPortal] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setInfo({ valid: false });
      return;
    }
    api.tokenInfo(token).then(setInfo).catch(() => setInfo({ valid: false }));
  }, [token]);

  const invite = info?.purpose === "invite";
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api.resetPassword(token, pw);
      setPortal(r.portal);
    } catch (e2) {
      setErr((e2 as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout eyebrow={invite ? "WELCOME ABOARD" : "ACCOUNT RECOVERY"} headline={invite ? "Set up your account." : "Choose a new password."} blurb="The link works once. After you save, every existing session of this account is signed out.">
      <AuthCard title={invite ? "Accept invitation" : "Set a new password"} subtitle={info?.valid ? `${info.role_label} · ${info.email_hint}` : undefined} icon={<KeyRound size={18} />} accent="#35D39A">
        {!info ? (
          <LoadingState />
        ) : portal ? (
          <div className="text-center">
            <CheckCircle2 size={34} className="mx-auto mb-3 text-ok" />
            <p className="text-[13px] text-ink">Password saved.</p>
            <Link to={`/login/${portal}`} className="btn btn-primary mt-5 inline-flex">
              Sign in
            </Link>
          </div>
        ) : !info.valid ? (
          <>
            <Notice kind="error">This link is invalid, already used, or expired.</Notice>
            <Link to="/forgot-password" className="btn w-full justify-center">
              Request a new link
            </Link>
          </>
        ) : (
          <form onSubmit={submit}>
            {err && <Notice kind="error">{err}</Notice>}
            <PasswordField value={pw} onChange={setPw} label="New password" autoComplete="new-password" showStrength />
            <PasswordField value={pw2} onChange={setPw2} label="Repeat new password" autoComplete="new-password" />
            {pw2 && pw !== pw2 && <p className="-mt-2 mb-3 text-[11px] text-danger">Passwords don't match</p>}
            <button className="btn btn-primary h-10 w-full justify-center text-[13px]" disabled={busy || pw !== pw2 || !passwordChecks(pw).every((c) => c.ok)}>
              {busy && <Loader2 size={15} className="animate-spin" />} Save password
            </button>
          </form>
        )}
      </AuthCard>
    </AuthLayout>
  );
}
