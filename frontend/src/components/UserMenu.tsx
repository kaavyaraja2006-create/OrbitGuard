import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronDown, LayoutDashboard, LogOut, UserCog } from "lucide-react";
import { useAuth } from "../stores/auth";
import { ROLE_COLOR, RoleBadge, initials } from "../lib/roles";

export function UserMenu() {
  const me = useAuth((s) => s.me);
  const logout = useAuth((s) => s.logout);
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  if (!me) return null;
  return (
    <div ref={box} className="relative">
      <button className="flex items-center gap-2 rounded-md border border-line-2 bg-panel py-1 pl-1 pr-2 hover:bg-hover" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <span className="flex h-7 w-7 items-center justify-center rounded text-[11px] font-semibold text-app" style={{ background: ROLE_COLOR[me.role] }}>
          {initials(me.full_name)}
        </span>
        <span className="hidden text-left leading-tight lg:block">
          <span className="block max-w-[140px] truncate text-[12px] text-ink">{me.full_name}</span>
          <span className="block max-w-[140px] truncate text-[10px] text-muted">{me.organization?.name}</span>
        </span>
        <ChevronDown size={13} className="text-muted" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-50 mt-1.5 w-[260px] overflow-hidden rounded-lg border border-line bg-elevated shadow-2xl">
          <div className="border-b border-line-2 px-3.5 py-3">
            <div className="truncate text-[12.5px] text-ink">{me.full_name}</div>
            <div className="truncate text-[11px] text-muted">{me.email}</div>
            <div className="mt-2">
              <RoleBadge role={me.role} />
            </div>
            <div className="mt-1.5 text-[10.5px] text-ink-2">
              {me.organization?.name}
              {me.department ? ` · ${me.department.name}` : ""}
            </div>
          </div>
          <Link role="menuitem" to={me.dashboard} onClick={() => setOpen(false)} className="flex items-center gap-2 px-3.5 py-2 text-[12px] text-ink hover:bg-hover">
            <LayoutDashboard size={13} /> My dashboard
          </Link>
          <Link role="menuitem" to="/account" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3.5 py-2 text-[12px] text-ink hover:bg-hover">
            <UserCog size={13} /> Account & security
          </Link>
          <button
            role="menuitem"
            className="flex w-full items-center gap-2 border-t border-line-2 px-3.5 py-2 text-left text-[12px] text-danger hover:bg-hover"
            onClick={async () => {
              await logout();
              nav(`/login/${me.portal}`, { replace: true });
            }}
          >
            <LogOut size={13} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
