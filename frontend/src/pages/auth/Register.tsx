import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, MailCheck, UserPlus } from "lucide-react";
import { AuthCard, AuthLayout, Field, Notice } from "../../components/auth/AuthLayout";
import { PasswordField, passwordChecks } from "../../components/auth/PasswordField";
import { api, ApiError } from "../../services/api";

export function Register() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const valid = name.trim().length >= 2 && email.includes("@") && passwordChecks(pw, email, name).every((c) => c.ok) && pw === pw2;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api.register(email.trim(), name.trim(), pw);
      setDone(r.message);
    } catch (e2) {
      setErr((e2 as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout eyebrow="PUBLIC ACCESS" headline="Watch the real orbital environment." blurb="A public account gives read-only access to live 3D positions, orbit classification and nearby-object detection, all computed from public orbital data.">
      <AuthCard title="Create a public account" subtitle="Restricted roles (operators, scientists, administrators) are created by an administrator, not here." icon={<UserPlus size={18} />} accent="#36D6E8">
        {done ? (
          <div className="text-center">
            <MailCheck size={34} className="mx-auto mb-3 text-ok" />
            <p className="text-[13px] text-ink">{done}</p>
            <p className="mt-2 text-[11.5px] text-muted">Development installs without SMTP print the link in the backend terminal.</p>
            <Link to="/login/public" className="btn btn-primary mt-5 inline-flex">
              Go to sign-in
            </Link>
          </div>
        ) : (
          <form onSubmit={submit}>
            {err && <Notice kind="error">{err}</Notice>}
            <Field label="Full name" htmlFor="name">
              <input id="name" className="input h-10 w-full text-[13px]" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            </Field>
            <Field label="E-mail" htmlFor="email">
              <input id="email" type="email" className="input h-10 w-full text-[13px]" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            </Field>
            <PasswordField value={pw} onChange={setPw} autoComplete="new-password" showStrength email={email} name={name} />
            <PasswordField value={pw2} onChange={setPw2} label="Repeat password" autoComplete="new-password" />
            {pw2 && pw !== pw2 && <p className="-mt-2 mb-3 text-[11px] text-danger">Passwords don't match</p>}
            <button className="btn btn-primary h-10 w-full justify-center text-[13px]" disabled={!valid || busy}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />} Create account
            </button>
            <p className="mt-5 text-center text-[12px] text-ink-2">
              Already registered?{" "}
              <Link to="/login/public" className="text-cyan hover:underline">
                Sign in
              </Link>
            </p>
          </form>
        )}
      </AuthCard>
    </AuthLayout>
  );
}
