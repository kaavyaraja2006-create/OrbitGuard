import { Ban, KeyRound, Lock, Users } from "lucide-react";
import { MetricCard } from "../../components/ui";
import { Tabs } from "../../components/Tabs";
import { api } from "../../services/api";
import { useAsync } from "../../services/useAsync";
import { fmtInt } from "../../lib/format";
import { ROLE_COLOR, ROLE_LABEL } from "../../lib/roles";
import type { AdminOverview, Role } from "../../types/auth";
import { UsersPanel } from "../admin/UsersPanel";
import { OrganizationsPanel, DepartmentsPanel } from "../admin/OrgPanels";
import { PermissionsPanel } from "../admin/PermissionsPanel";
import { OutboxPanel, SecurityEventsPanel } from "../admin/SecurityPanels";
import { FleetPanel } from "../admin/FleetPanel";
import { DashboardHero } from "./common";

function Metrics({ ov }: { ov: AdminOverview | null }) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <MetricCard label="Users" value={ov ? fmtInt(ov.users_total) : "—"} icon={<Users size={15} />} hint={ov?.scope === "platform" ? `${ov.organizations} organisations` : ov?.organization.name} />
      <MetricCard label="Active sessions" value={ov ? fmtInt(ov.active_sessions) : "—"} accent="var(--color-ok)" icon={<KeyRound size={15} />} hint={ov ? `${ov.logins_24h} sign-ins in 24 h` : " "} />
      <MetricCard label="Failed sign-ins · 24 h" value={ov ? fmtInt(ov.failed_logins_24h) : "—"} accent="var(--color-warn)" icon={<Ban size={15} />} hint="Wrong password or unknown account" />
      <MetricCard label="Locked accounts" value={ov ? fmtInt(ov.locked_accounts) : "—"} accent="var(--color-danger)" icon={<Lock size={15} />} hint="Unlock from the Users tab" />
    </div>
  );
}

function RoleBar({ ov }: { ov: AdminOverview }) {
  const total = Math.max(1, ov.users_total);
  const roles = Object.keys(ov.users_by_role) as Role[];
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-hover">
        {roles.map((r) => (
          <span key={r} style={{ width: `${(100 * ov.users_by_role[r]) / total}%`, background: ROLE_COLOR[r] }} title={`${ROLE_LABEL[r]}: ${ov.users_by_role[r]}`} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-2">
        {roles.map((r) => (
          <span key={r} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: ROLE_COLOR[r] }} /> {ROLE_LABEL[r]} <span className="num text-ink">{ov.users_by_role[r]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function SuperAdminDashboard() {
  const ov = useAsync(() => api.adminOverview(), [], 30000);
  return (
    <div>
      <DashboardHero title="Platform administration">{ov.data && <RoleBar ov={ov.data} />}</DashboardHero>
      <Metrics ov={ov.data} />
      <Tabs
        tabs={[
          { id: "users", label: "Users", content: <UsersPanel scope="platform" /> },
          { id: "orgs", label: "Organisations", content: <OrganizationsPanel /> },
          { id: "permissions", label: "Roles & permissions", content: <PermissionsPanel /> },
          { id: "security", label: "Security events", content: <SecurityEventsPanel /> },
          { id: "mail", label: "E-mail log", content: <OutboxPanel /> },
        ]}
      />
    </div>
  );
}

export function OrgAdminDashboard() {
  const ov = useAsync(() => api.adminOverview(), [], 30000);
  return (
    <div>
      <DashboardHero title="Organisation console">{ov.data && <RoleBar ov={ov.data} />}</DashboardHero>
      <Metrics ov={ov.data} />
      <Tabs
        tabs={[
          { id: "users", label: "Team", content: <UsersPanel scope="organization" /> },
          { id: "fleet", label: "Fleet & assignments", content: <FleetPanel /> },
          { id: "departments", label: "Departments", content: ov.data ? <div className="max-w-[560px]"><DepartmentsPanel org={ov.data.organization} onChange={ov.reload} /></div> : null },
          { id: "permissions", label: "Role permissions", content: <PermissionsPanel /> },
          { id: "security", label: "Security events", content: <SecurityEventsPanel /> },
        ]}
      />
    </div>
  );
}
