import type {
  DatasetFiles,
  DatasetJob,
  KelvinsEventDetail,
  KelvinsEventRow,
  SocratesRow,
  Activity,
  ConjunctionDetail,
  ConjunctionEvent,
  PcAssessment,
  ScreeningRun,
  ClassificationRules,
  Health,
  IngestionRun,
  ObjectDetail,
  ObjectList,
  OrbitTrack,
  Positions,
  Providers,
  SourceSummary,
  Stats,
} from "../types";
import type { AdminOverview, AdminUser, Fleet, Me, OrgRow, OutboxMail, RolesMatrix, SecurityEvent, SessionRow } from "../types/auth";
import type { AlertItem, ExperimentRun, Plan, PlanSummary, PropulsionPreset, Simulation, SpacecraftConfig, Twin } from "../types/mission";
import type { CompareRow, NearbyResult, ProximityJob, ProximityScreen, SearchResult, TrackedItem } from "../types/proximity";

const BASE = "/api/v1";

export class ApiError extends Error {
  status: number;
  /** Machine-readable reason from the backend, e.g. "wrong_portal", "locked". */
  code?: string;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Fired when the server says the session is gone (expired, revoked, signed out elsewhere). */
export const UNAUTHORIZED_EVENT = "orbitguard:unauthorized";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      credentials: "same-origin", // HttpOnly session cookie; JavaScript never sees the token
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, "Backend unreachable. Is the API running on port 8000?");
  }
  if (!res.ok) {
    let detail = res.statusText;
    let code: string | undefined;
    let extra: Record<string, unknown> = {};
    try {
      const body = await res.json();
      const d = body.detail;
      if (typeof d === "string") detail = d;
      else if (d && typeof d === "object" && "message" in d) {
        detail = String(d.message);
        code = d.code;
        extra = d;
      } else if (Array.isArray(d)) detail = d.map((x: { msg?: string; loc?: string[] }) => `${x.loc?.slice(-1)[0] ?? ""}: ${x.msg ?? ""}`).join("; ");
      else detail = JSON.stringify(d ?? body);
    } catch {
      /* non-JSON error */
    }
    if (res.status === 401 && !path.startsWith("/auth/login") && !path.startsWith("/auth/me")) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(res.status, detail, code, extra);
  }
  return res.json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
const put = <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: "DELETE" });

function qs(params: Record<string, string | number | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Anonymous landing-page summary: real counts and a bounded SGP4 sample. */
export interface Showcase {
  generated_at: string;
  frame: string;
  tracked_objects: number;
  by_type: Record<string, number>;
  newest_epoch: string | null;
  last_ingestion: string | null;
  sample: { count: number; of: number; types: string[]; ecef_km: number[] };
  tracks: { norad_id: number; name: string | null; type: string; period_min: number; ecef_km: number[] }[];
  label: string;
}

export const api = {
  health: () => request<Health>("/health"),
  showcase: () => request<Showcase>("/public/showcase"),
  stats: () => request<Stats>("/stats"),
  density: (p: { types?: string; alt_max_km?: number; alt_bin_km?: number; inc_bin_deg?: number } = {}) =>
    request<{ types: string[]; objects: number; plotted: number; outside_range: number; alt_edges_km: number[]; inc_edges_deg: number[]; counts: number[][]; source: string }>(`/stats/density${qs(p)}`),
  objects: (p: { q?: string; object_type?: string; label?: string; freshness?: string; sort?: string; order?: string; limit?: number; offset?: number }) =>
    request<ObjectList>(`/objects${qs(p)}`),
  object: (id: number, at?: string) => request<ObjectDetail>(`/objects/${id}${qs({ at })}`),
  orbit: (id: number, start?: string) => request<OrbitTrack>(`/objects/${id}/orbit${qs({ start })}`),
  positions: (at?: string) => request<Positions>(`/positions${qs({ at })}`),
  rules: () => request<ClassificationRules>("/orbits/classification-rules"),
  providers: () => request<Providers>("/ingestion/providers"),
  runs: (limit = 30) => request<IngestionRun[]>(`/ingestion/runs${qs({ limit })}`),
  sources: () => request<SourceSummary[]>("/ingestion/sources"),
  activity: (limit = 20) => request<Activity[]>(`/ingestion/activity${qs({ limit })}`),
  ingestCelestrak: (groups: string[], force: boolean) =>
    request<{ run_ids: number[] }>("/ingestion/celestrak", { method: "POST", body: JSON.stringify({ groups, force }) }),
  screen: (body: { primary_norad_id: number; start?: string; horizon_h: number; step_s: number; threshold_km: number; hbr_m: number }) =>
    request<{ run_id: number }>("/conjunctions/screen", { method: "POST", body: JSON.stringify(body) }),
  screeningRuns: (limit = 30) => request<ScreeningRun[]>(`/conjunctions/runs${qs({ limit })}`),
  conjunctions: (p: { run_id?: number; primary_norad_id?: number; upcoming_only?: boolean; latest_run_per_primary?: boolean; limit?: number }) =>
    request<ConjunctionEvent[]>(
      `/conjunctions${qs({ ...p, upcoming_only: p.upcoming_only ? "true" : undefined, latest_run_per_primary: p.latest_run_per_primary ? "true" : undefined })}`,
    ),
  conjunction: (id: number) => request<ConjunctionDetail>(`/conjunctions/${id}`),
  risk: (id: number, body: { hbr_m: number; primary_sigma_rtn_km: number[] | null; secondary_sigma_rtn_km: number[] | null }) =>
    request<PcAssessment>(`/conjunctions/${id}/risk`, { method: "POST", body: JSON.stringify(body) }),
  datasetFiles: () => request<DatasetFiles>("/validation/files"),
  datasetJobs: (limit = 30) => request<DatasetJob[]>(`/validation/jobs${qs({ limit })}`),
  kelvinsImport: () => request<{ job_id: number }>("/validation/kelvins/import", { method: "POST" }),
  kelvinsSummary: () => request<DatasetJob | null>("/validation/kelvins/summary"),
  kelvinsScatter: (limit = 3000) =>
    request<{ total: number; shown: number; points: { esa: number; ours: number; mission: number }[] }>(`/validation/kelvins/scatter${qs({ limit })}`),
  kelvinsEvents: (p: { split?: string; mission_id?: number; min_risk?: number; limit?: number }) => request<KelvinsEventRow[]>(`/validation/kelvins/events${qs(p)}`),
  kelvinsEvent: (split: string, id: number) => request<KelvinsEventDetail>(`/validation/kelvins/events/${split}/${id}`),
  socratesImport: (path?: string) => request<{ job_id: number }>("/validation/socrates/import", { method: "POST", body: JSON.stringify({ path: path ?? null }) }),
  socratesCompare: (import_id: number, limit: number) =>
    request<{ job_id: number }>("/validation/socrates/compare", { method: "POST", body: JSON.stringify({ import_id, limit }) }),
  socratesRows: (import_id: number, compared_only: boolean, limit = 300) =>
    request<SocratesRow[]>(`/validation/socrates/conjunctions${qs({ import_id, compared_only: compared_only ? "true" : undefined, limit })}`),
  // ---------------------------------------------------------------- auth
  portals: () => request<{ portal: string; role: string; label: string; summary: string; self_registration: boolean }[]>("/auth/portals"),
  login: (portal: string, email: string, password: string, remember: boolean) =>
    post<{ user: Me; session_expires_at: string }>(`/auth/login/${portal}`, { email, password, remember }),
  logout: () => post<{ ok: boolean }>("/auth/logout"),
  me: () => request<Me>("/auth/me"),
  register: (email: string, full_name: string, password: string) =>
    post<{ message: string; verification_required: boolean }>("/auth/register", { email, full_name, password }),
  verifyEmail: (token: string) => post<{ ok: boolean; portal: string }>("/auth/verify-email", { token }),
  resendVerification: (email: string) => post<{ message: string }>("/auth/resend-verification", { email }),
  forgotPassword: (email: string) => post<{ message: string }>("/auth/forgot-password", { email }),
  tokenInfo: (token: string) =>
    request<{ valid: boolean; purpose?: "reset" | "invite"; email_hint?: string; portal?: string; role_label?: string; expires_at?: string }>(`/auth/token-info${qs({ token })}`),
  resetPassword: (token: string, new_password: string) => post<{ ok: boolean; portal: string }>("/auth/reset-password", { token, new_password }),
  changePassword: (current_password: string, new_password: string) =>
    post<{ ok: boolean; other_sessions_revoked: number }>("/auth/change-password", { current_password, new_password }),
  mySessions: () => request<SessionRow[]>("/auth/sessions"),
  revokeMySession: (id: number) => del<{ ok: boolean }>(`/auth/sessions/${id}`),
  revokeOtherSessions: () => post<{ revoked: number }>("/auth/sessions/revoke-others"),

  // --------------------------------------------------------------- admin
  adminOverview: () => request<AdminOverview>("/admin/overview"),
  adminRoles: () => request<RolesMatrix>("/admin/roles"),
  setRolePermissions: (role: string, permissions: string[]) => put<{ role: string; permissions: string[] }>(`/admin/roles/${role}/permissions`, { permissions }),
  adminOrgs: () => request<OrgRow[]>("/admin/organizations"),
  createOrg: (name: string, country: string | null) => post<OrgRow>("/admin/organizations", { name, country }),
  updateOrg: (id: number, body: Partial<{ name: string; country: string | null; is_active: boolean }>) => patch<OrgRow>(`/admin/organizations/${id}`, body),
  createDept: (orgId: number, name: string) => post<{ id: number; name: string }>(`/admin/organizations/${orgId}/departments`, { name }),
  deleteDept: (id: number) => del<{ ok: boolean }>(`/admin/departments/${id}`),
  adminUsers: (p: { q?: string; role?: string; organization_id?: number; status?: string; limit?: number; offset?: number }) =>
    request<{ total: number; offset: number; limit: number; items: AdminUser[] }>(`/admin/users${qs(p)}`),
  createUser: (body: { email: string; full_name: string; role: string; organization_id?: number | null; department_id?: number | null; job_title?: string | null; initial_password?: string | null }) =>
    post<AdminUser>("/admin/users", body),
  updateUser: (id: number, body: Partial<{ full_name: string; job_title: string | null; role: string; organization_id: number; department_id: number; clear_department: boolean; is_active: boolean }>) =>
    patch<AdminUser>(`/admin/users/${id}`, body),
  unlockUser: (id: number) => post<AdminUser>(`/admin/users/${id}/unlock`),
  sendReset: (id: number) => post<{ message: string }>(`/admin/users/${id}/send-reset`),
  revokeUserSessions: (id: number) => post<{ revoked: number }>(`/admin/users/${id}/revoke-sessions`),
  userSessions: (id: number) => request<SessionRow[]>(`/admin/users/${id}/sessions`),
  securityEvents: (limit = 100) => request<SecurityEvent[]>(`/admin/security-events${qs({ limit })}`),
  outbox: (limit = 50) => request<OutboxMail[]>(`/admin/outbox${qs({ limit })}`),
  fleet: (organization_id?: number) => request<Fleet>(`/fleet${qs({ organization_id })}`),
  addFleetSat: (norad_id: number, organization_id?: number) => post<{ ok: boolean }>("/fleet/satellites", { norad_id, organization_id }),
  removeFleetSat: (norad_id: number, organization_id?: number) => del<{ ok: boolean }>(`/fleet/satellites/${norad_id}${qs({ organization_id })}`),
  assign: (user_id: number, norad_id: number) => post<{ id: number }>("/fleet/assignments", { user_id, norad_id }),
  unassign: (id: number) => del<{ ok: boolean }>(`/fleet/assignments/${id}`),

  // ------------------------------------------------- tracking & proximity
  search: (p: { q?: string; category?: string; label?: string; limit?: number; offset?: number }) => request<SearchResult>(`/objects/search${qs(p)}`),
  multiSelect: (norad_ids: number[], at: string, include_orbit = true) =>
    post<{ time: string; items: TrackedItem[] }>("/tracking/multi-select", { norad_ids, at, include_orbit }),
  compare: (norad_ids: number[], at: string, radius_km: number, categories: string[] | null) =>
    post<{ time: string; radius_km: number; rows: CompareRow[] }>("/tracking/compare", { norad_ids, at, radius_km, categories }),
  nearby: (id: number, p: { at: string; radius_km: number; categories?: string; limit?: number; offset?: number }) =>
    request<NearbyResult>(`/tracking/${id}/nearby${qs(p)}`),
  proximityScreen: (body: { norad_ids: number[]; at: string; radius_km: number; categories: string[] | null; limit: number; offset: number }) =>
    post<ProximityScreen>("/proximity/screen", body),
  proximityPredict: (body: { norad_ids: number[]; start: string; horizon_h: number; radius_km: number; step_s: number; categories: string[] | null }) =>
    post<{ job_id: number }>("/proximity/predict", body),
  proximityJob: (id: number, limit = 200, offset = 0) => request<ProximityJob>(`/proximity/jobs/${id}${qs({ limit, offset })}`),

  // ------------------------------------------------- phases 5-8
  twinPresets: () => request<{ default_config: SpacecraftConfig; directions: string[]; propulsion: PropulsionPreset[]; label: string }>("/digital-twins/presets"),
  twins: () => request<Twin[]>("/digital-twins"),
  twin: (id: number) => request<Twin>(`/digital-twins/${id}`),
  createTwin: (body: Record<string, unknown>) => post<Twin>("/digital-twins", body),
  updateTwin: (id: number, body: { name?: string; config?: SpacecraftConfig; notes?: string | null }) => patch<Twin>(`/digital-twins/${id}`, body),
  deleteTwin: (id: number) => del<{ ok: boolean }>(`/digital-twins/${id}`),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  propagateTwin: (id: number, body: Record<string, unknown>) => post<any>(`/digital-twins/${id}/propagate`, body),
  screenTwin: (id: number, horizon_h: number, threshold_km: number, start?: string) =>
    post<{ start: string; objects_screened: number; encounters: { norad_id: number; name: string | null; tca: string; miss_km: number; relative_speed_kms: number }[]; note: string }>(
      `/digital-twins/${id}/threats/screen${qs({ horizon_h, threshold_km, start })}`,
    ),
  applyPlan: (twinId: number, planId: number) => post<Twin>(`/digital-twins/${twinId}/apply/${planId}`),
  optimize: (body: Record<string, unknown>) => post<{ plan_id: number }>("/maneuvers/optimize", body),
  plans: (twin_id?: number) => request<PlanSummary[]>(`/maneuvers${qs({ twin_id })}`),
  plan: (id: number) => request<Plan>(`/maneuvers/${id}`),
  createSimulation: (plan_id: number, fidelity = "validation", alternative_index?: number) =>
    post<{ simulation_id: number }>("/simulations", { plan_id, fidelity, alternative_index: alternative_index ?? null }),
  simulations: (plan_id?: number) => request<{ id: number; plan_id: number; status: string; message: string | null; fidelity: string; alternative_index?: number | null; created_at: string }[]>(`/simulations${qs({ plan_id })}`),
  simulation: (id: number) => request<Simulation>(`/simulations/${id}`),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transfer: (body: Record<string, unknown>) => post<any>("/transfers", body),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transferPresets: () => request<Record<string, any>>("/transfers/presets"),
  experimentCatalog: () => request<{ name: string; title: string; question: string }[]>("/research/experiments/catalog"),
  experiments: () => request<ExperimentRun[]>("/research/experiments"),
  experiment: (id: number) => request<ExperimentRun>(`/research/experiments/${id}`),
  startExperiment: (name: string, seeds: number, profile: string) => post<{ experiment_id: number }>("/research/experiments", { name, seeds, profile }),
  alerts: () => request<{ unread: number; items: AlertItem[] }>("/alerts"),
  alertsReadAll: () => post<{ ok: boolean }>("/alerts/read-all"),

  upload: (label: string, text: string, object_kind: string | null) =>
    request<IngestionRun>("/ingestion/upload", { method: "POST", body: JSON.stringify({ label, text, object_kind }) }),
};
