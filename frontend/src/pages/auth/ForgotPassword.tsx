import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, KeyRound, Loader2 } from "lucide-react";
import { AuthCard, AuthLayout, Field, Notice } from "../../components/auth/AuthLayout";
import { api, ApiError } from "../../services/api";

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.forgotPassword(email.trim());
      setMsg({ kind: "ok", text: r.message });
    } catch (e2) {
      setMsg({ kind: "error", text: (e2 as ApiError).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout eyebrow="ACCOUNT RECOVERY" headline="Reset your password." blurb="We e-mail a single-use link that expires after a short time. Resetting signs you out of every device.">
      <Link to="/login" className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-ink-2 hover:text-ink">
        <ArrowLeft size={13} /> Back to sign-in
      </Link>
      <AuthCard title="Forgot password" subtitle="Enter the e-mail address of your account. Works for every portal." icon={<KeyRound size={18} />} accent="#F5B942">
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
        <form onSubmit={submit}>
          <Field label="E-mail" htmlFor="email">
            <input id="email" type="email" className="input h-10 w-full text-[13px]" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus required />
          </Field>
          <button className="btn btn-primary h-10 w-full justify-center text-[13px]" disabled={busy || !email.includes("@")}>
            {busy && <Loader2 size={15} className="animate-spin" />} Send reset link
          </button>
        </form>
      </AuthCard>
    </AuthLayout>
  );
}
