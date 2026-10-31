import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2, MailCheck, XCircle } from "lucide-react";
import { AuthCard, AuthLayout } from "../../components/auth/AuthLayout";
import { LoadingState } from "../../components/ui";
import { api, ApiError } from "../../services/api";

export function VerifyEmail() {
  const [params] = useSearchParams();
  const [state, setState] = useState<{ ok: boolean; text: string; portal?: string } | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return; // tokens are single-use; React StrictMode would call twice
    once.current = true;
    const t = params.get("token");
    if (!t) return setState({ ok: false, text: "The verification link is incomplete." });
    api
      .verifyEmail(t)
      .then((r) => setState({ ok: true, text: "E-mail verified. You can sign in now.", portal: r.portal }))
      .catch((e) => setState({ ok: false, text: (e as ApiError).message }));
  }, [params]);
  return (
    <AuthLayout eyebrow="VERIFICATION" headline="Confirming your e-mail.">
      <AuthCard title="E-mail verification" icon={<MailCheck size={18} />} accent="#36D6E8">
        {!state ? (
          <LoadingState />
        ) : (
          <div className="text-center">
            {state.ok ? <CheckCircle2 size={34} className="mx-auto mb-3 text-ok" /> : <XCircle size={34} className="mx-auto mb-3 text-danger" />}
            <p className="text-[13px] text-ink">{state.text}</p>
            <Link to={`/login/${state.portal ?? "public"}`} className="btn btn-primary mt-5 inline-flex">
              Go to sign-in
            </Link>
          </div>
        )}
      </AuthCard>
    </AuthLayout>
  );
}
