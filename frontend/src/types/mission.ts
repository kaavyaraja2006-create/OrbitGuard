/* eslint-disable @typescript-eslint/no-explicit-any */
export interface SpacecraftConfig {
  name: string;
  structure: { dry_mass_kg: number; area_m2: number; cd: number; cr: number };
  propulsion: { kind: string; thrust_n: number; isp_s: number; max_burn_s: number; max_dv_per_burn_ms: number; min_impulse_dv_ms: number; power_w: number };
  fuel: { propellant_initial_kg: number; propellant_remaining_kg: number; reserve_kg: number };
  attitude: { allowed_directions: string[]; pointing_accuracy_deg: number; magnitude_error_frac: number; min_lead_time_s: number; min_time_before_tca_s: number };
  mission: { alt_min_km: number; alt_max_km: number; inc_min_deg: number; inc_max_deg: number; ecc_max: number; preserve_sso: boolean; sso_rate_tol_deg_day: number; da_tol_km: number; di_tol_deg: number; de_tol: number };
  power: { available_power_w: number; max_burns_per_orbit: number };
}

export interface TwinSummary {
  wet_mass_kg: number;
  usable_propellant_kg: number;
  dv_available_ms: number;
  max_single_burn_dv_ms: number;
  burn_s_per_10_cm_s: number;
  propellant_g_per_10_cm_s: number;
  ballistic_coefficient_m2_kg: number;
  area_to_mass_m2_kg: number;
  validation_errors: string[];
  data_origin: string;
}

export interface Twin {
  id: number;
  name: string;
  organization_id: number;
  source_norad_id: number | null;
  source_name: string | null;
  source_element_set_id: number | null;
  state_source: string;
  epoch: string;
  state_teme: { r_km: number[]; v_kms: number[]; frame: string };
  osculating_elements: { a_km: number; e: number; i_deg: number; raan_deg: number; argp_deg: number; nu_deg: number; perigee_alt_km: number; apogee_alt_km: number };
  config: SpacecraftConfig;
  summary: TwinSummary;
  fuel_log: { plan_id: number; at: string; dv_ms: number; propellant_kg: number; remaining_kg: number }[];
  notes: string | null;
  label: string;
  plans?: { id: number; status: string; method: string; created_at: string; result_status: string | null }[];
}

export interface PropulsionPreset {
  id: number;
  key: string;
  name: string;
  thrust_n: number;
  isp_s: number;
  max_burn_s: number;
  max_dv_per_burn_ms: number;
  min_impulse_dv_ms: number;
  power_w: number;
  note: string;
}

export interface PerThreat {
  threat: string;
  miss_km: number;
  pc: number;
  tca: string;
}

export interface Candidate {
  t_m_s: number | null;
  t_m: string | null;
  dv_rtn_ms: number[];
  feasible: boolean;
  reasons: string[];
  per_threat: PerThreat[];
  terms: { R: number; F: number; M: number; U: number | null };
  J: number;
  dv_ms: number;
  propellant_kg: number;
  burn_s: number;
  da_km: number;
  de: number;
  di_deg: number;
  raan_rate_change_deg_day: number;
  sso_rate_deg_day: number;
  alt_min_km: number;
  alt_max_km: number;
  role?: string;
  monte_carlo?: any;
}

export interface PlanResult {
  status: "selected" | "no-maneuver-needed" | "no-feasible-candidate" | "no-robust-candidate" | "no-threats" | "invalid-spacecraft";
  message?: string;
  selected: Candidate | null;
  nominal: Candidate;
  threats: { id: string; name: string; kind: string; norad_id: number | null; label: string; sigma_rtn_km: number[]; track_status: string }[];
  threats_considered: string[];
  stages: any[];
  candidates_evaluated?: number;
  rejection_summary?: Record<string, number>;
  top_candidates?: Candidate[];
  shortlist?: Candidate[];
  monte_carlo?: { nominal: any; selected: any };
  validation?: any;
  explanation?: string[];
  config: any;
  uncertainty: any;
  spacecraft: TwinSummary;
  initial_state: { epoch: string; r_km: number[]; v_kms: number[]; frame: string; source: string };
  runtime_s?: number;
  safe_against_all_threats?: boolean;
  versions?: Record<string, string>;
  closest_attempt?: Candidate;
}

export interface PlanSummary {
  id: number;
  twin_id: number;
  twin_name: string | null;
  method: string;
  status: string;
  progress: number;
  stage: string | null;
  message: string | null;
  result_status: string | null;
  dv_ms: number | null;
  validation: string | null;
  applied_at: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface Plan extends PlanSummary {
  params: any;
  result: PlanResult | null;
}

export interface SimTrajectory {
  label: string;
  kind: "original" | "modified" | "alternative" | "threat";
  frame: string;
  start: string;
  step_s: number;
  ecef_km: number[][];
  vel_kms: number[][];
}

export interface Simulation {
  id: number;
  plan_id: number;
  twin_id: number;
  status: string;
  message: string | null;
  config: any;
  trajectories: SimTrajectory[];
  versions?: Record<string, string>;
  metrics: { name: string; value: number; unit: string; context: any }[];
}

export interface ExperimentRun {
  id: number;
  name: string;
  profile: string;
  seeds: number;
  status: string;
  progress: number;
  stage: string | null;
  message: string | null;
  created_at: string;
  finished_at: string | null;
  title: string;
  summary?: any[];
  runtime_s?: number;
  result?: any;
}

export interface AlertItem {
  id: number;
  severity: "info" | "warning" | "critical";
  kind: string;
  title: string;
  message: string;
  link: string | null;
  created_at: string;
  read: boolean;
}
