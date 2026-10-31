export type Role = "super_admin" | "org_admin" | "mission_manager" | "scientist" | "operator" | "public";
export type PortalSlug = "admin" | "org-admin" | "mission" | "science" | "operator" | "public";

export interface Me {
  id: number;
  email: string;
  full_name: string;
  job_title: string | null;
  role: Role;
  role_label: string;
  portal: PortalSlug;
  dashboard: string;
  organization: { id: number; name: string; kind: string } | null;
  department: { id: number; name: string } | null;
  is_active: boolean;
  email_verified: boolean;
  must_change_password: boolean;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  permissions: string[];
  session?: { id: number; portal: string; created_at: string; expires_at: string; idle_timeout_minutes: number };
  assigned_satellites?: { norad_id: number; name: string | null; in_catalog: boolean }[];
}

export interface AdminUser extends Omit<Me, "permissions" | "session" | "assigned_satellites"> {
  active_sessions?: number;
  manageable?: boolean;
}

export interface SessionRow {
  id: number;
  portal: string;
  created_at: string;
  last_seen_at: string;
  expires_at?: string;
  ip: string | null;
  user_agent: string | null;
  current?: boolean;
  active: boolean;
  revoked_reason: string | null;
}

export interface OrgRow {
  id: number;
  name: string;
  slug: string;
  kind: "platform" | "member" | "public";
  country: string | null;
  is_active: boolean;
  created_at: string;
  users: number;
  fleet_size: number;
  departments: { id: number; name: string }[];
}

export interface RolesMatrix {
  roles: { role: Role; label: string; portal: PortalSlug; dashboard: string; level: number; summary: string; permissions: string[] }[];
  permissions: { id: string; description: string; locked_to_super_admin: boolean }[];
  editable: boolean;
  org_assignable_roles: Role[];
}

export interface AdminOverview {
  scope: "platform" | "organization";
  organization: OrgRow;
  organizations: number;
  users_by_role: Record<Role, number>;
  users_total: number;
  active_sessions: number;
  locked_accounts: number;
  failed_logins_24h: number;
  logins_24h: number;
}

export interface SecurityEvent {
  id: number;
  at: string;
  kind: string;
  message: string;
  details: Record<string, unknown>;
}

export interface OutboxMail {
  id: number;
  to: string;
  subject: string;
  body: string;
  status: string;
  error: string | null;
  created_at: string;
}

export interface Fleet {
  organization_id: number;
  satellites: {
    norad_id: number;
    name: string | null;
    object_type: string;
    in_catalog: boolean;
    added_at: string;
    assigned_to: { assignment_id: number; user_id: number; full_name: string; email: string }[];
  }[];
  operators: { id: number; full_name: string; email: string }[];
  can_manage: boolean;
}
