import type { ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { ShieldOff } from "lucide-react";
import { OrbitLoader } from "./ui";
import { useAuth } from "../stores/auth";
import { ROLE_LABEL } from "../lib/roles";

export function FullScreenLoading({ label = "Checking session" }: { label?: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2.5 bg-app text-ink-2" role="status">
      <OrbitLoader size={26} /> {label}…
    </div>
  );
}

/** Anyone not signed in goes to the portal hub. (The API would refuse them anyway.) */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, me } = useAuth();
  const loc = useLocation();
  if (status === "loading") return <FullScreenLoading />;
  if (status === "anonymous" || !me)
    return <Navigate to={loc.pathname === "/" ? "/welcome" : `/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (me.must_change_password && loc.pathname !== "/change-password") return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

export function Forbidden({ need }: { need?: string }) {
  const me = useAuth((s) => s.me);
  return (
    <div className="mx-auto mt-16 max-w-[460px] panel p-8 text-center">
      <ShieldOff size={30} className="mx-auto mb-3 text-danger" />
      <h1 className="text-[17px] font-semibold text-ink">Not available for your role</h1>
      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">
        You're signed in as <span className="text-ink">{me ? ROLE_LABEL[me.role] : "—"}</span>. This area needs{" "}
        {need ? <code className="num rounded bg-hover px-1 text-[11.5px] text-ink">{need}</code> : "a different role"}. The server refuses these requests too, so changing the
        address doesn't help.
      </p>
      {me && (
        <Link to={me.dashboard} className="btn btn-primary mt-5 inline-flex">
          Go to my dashboard
        </Link>
      )}
    </div>
  );
}

export function RequirePerm({ perm, children }: { perm: string; children: ReactNode }) {
  const me = useAuth((s) => s.me);
  if (!me?.permissions.includes(perm)) return <Forbidden need={perm} />;
  return <>{children}</>;
}

export function RequireRole({ roles, children }: { roles: string[]; children: ReactNode }) {
  const me = useAuth((s) => s.me);
  if (!me || !roles.includes(me.role)) return <Forbidden />;
  return <>{children}</>;
}
