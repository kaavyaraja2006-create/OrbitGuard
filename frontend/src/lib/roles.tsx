import type { Role } from "../types/auth";

export const ROLE_LABEL: Record<Role, string> = {
  super_admin: "Super Administrator",
  org_admin: "Organization Administrator",
  mission_manager: "Mission Operations Manager",
  scientist: "Scientist / Research Analyst",
  operator: "Satellite Operator / Engineer",
  public: "Public User",
};

export const ROLE_COLOR: Record<Role, string> = {
  super_admin: "#FF647C",
  org_admin: "#A78BFA",
  mission_manager: "#F5B942",
  scientist: "#35D39A",
  operator: "#4DA3FF",
  public: "#36D6E8",
};

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-px text-[10px] font-semibold tracking-wide"
      style={{ color: ROLE_COLOR[role], background: `color-mix(in srgb, ${ROLE_COLOR[role]} 13%, transparent)` }}
    >
      {ROLE_LABEL[role]}
    </span>
  );
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
