export type OrbitLabel = "LEO" | "MEO" | "GEO" | "POLAR" | "SSO" | "HEO";
export const ORBIT_LABELS: OrbitLabel[] = ["LEO", "MEO", "GEO", "POLAR", "SSO", "HEO"];

export type ObjectType = "PAYLOAD" | "ROCKET BODY" | "DEBRIS" | "UNKNOWN";
export type Freshness = "fresh" | "aging" | "stale" | "future-epoch";

export interface Health {
  status: string;
  database: string;
  database_backend: string;
  engine_version: string;
  server_time: string;
}

export interface Stats {
  generated_at: string;
  tracked_objects: number;
  element_sets_stored: number;
  by_type: Record<string, number>;
  by_label: Record<OrbitLabel, number>;
  label_combinations: Record<string, number>;
  freshness: Record<Freshness, number>;
  newest_epoch: string | null;
  perigee_altitude_histogram: { edges_km: number[]; counts: number[] };
  inclination_histogram: { edges_deg: number[]; counts: number[] };
}

export interface ObjectRow {
  norad_id: number;
  name: string | null;
  intl_designator: string | null;
  object_type: ObjectType;
  operational_status: string;
  labels: OrbitLabel[];
  epoch: string;
  age_days: number;
  freshness: Freshness;
  mean_a_km: number;
  mean_e: number;
  mean_i_deg: number;
  perigee_alt_km: number;
  apogee_alt_km: number;
  period_min: number;
  source: string;
}

export interface ObjectList {
  total: number;
  offset: number;
  limit: number;
  items: ObjectRow[];
}

export interface Criterion {
  label: OrbitLabel;
  passed: boolean;
  rule: string;
  value: number | null;
  threshold: string;
}

export interface Classification {
  labels: OrbitLabel[];
  criteria: Criterion[];
  geo_type: string | null;
  regions_crossed: string[];
  status: string;
  warnings: string[];
  algorithm_version: string;
}

export interface ObjectDetail {
  norad_id: number;
  name: string | null;
  intl_designator: string | null;
  object_type: { value: ObjectType; determined_by: string };
  operational_status: { value: string; determined_by: string };
  physical_properties: { mass_kg: number | null; size_m: number | null; note: string };
  element_set: {
    id: number;
    epoch: string;
    age_days: number;
    freshness: Freshness;
    line1: string;
    line2: string;
    bstar: number;
    rev_number: number;
    provenance: { provider: string; source: string; url: string | null; retrieved_at: string; ingestion_run_id: number };
  };
  mean_elements: {
    a_km: number;
    e: number;
    i_deg: number;
    raan_deg: number;
    argp_deg: number;
    mean_anomaly_deg: number;
    mean_motion_rev_day: number;
    kind: string;
  };
  derived: {
    perigee_altitude_km: number;
    apogee_altitude_km: number;
    period_min: number;
    specific_energy_km2_s2: number;
    specific_angular_momentum_km2_s: number;
    raan_rate_deg_day: number;
    argp_rate_deg_day: number;
    velocity_perigee_kms: number;
    velocity_apogee_kms: number;
  };
  classification: Classification | null;
  state: {
    time: string;
    sgp4_error_code: number;
    sgp4_error: string;
    teme?: { frame: string; r_km: number[]; v_kms: number[] };
    itrf?: { frame: string; r_km: number[]; v_kms: number[] };
    geodetic?: { lat_deg: number; lon_deg: number; alt_km: number };
    speed_kms?: number;
    osculating_elements?: { a_km: number; e: number; i_deg: number; raan_deg: number; argp_deg: number; nu_deg: number; undefined: string[] };
  };
  history: { epoch: string; perigee_alt_km: number; apogee_alt_km: number; mean_i_deg: number }[];
}

export interface OrbitTrack {
  norad_id: number;
  frame: string;
  times: string[];
  ecef_km: [number, number, number][];
  valid: boolean[];
  errors: string[];
}

export interface Positions {
  time: string;
  frame: string;
  count: number;
  failed: number;
  norad_ids: number[];
  types: ObjectType[];
  ecef_km: number[];
}

export interface IngestionRun {
  id: number;
  provider: string;
  source: string;
  url: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  started_at: string | null;
  finished_at: string | null;
  records_received: number;
  records_new: number;
  records_duplicate: number;
  records_rejected: number;
  message: string | null;
  raw_sha256: string | null;
  raw_bytes: number | null;
}

export interface SourceSummary {
  id: number;
  provider: string;
  name: string;
  url: string | null;
  last_run: IngestionRun | null;
}

export interface Activity {
  id: number;
  at: string;
  kind: string;
  message: string;
}

export interface Providers {
  celestrak: {
    groups: { id: string; label: string; kind: string | null; section: string }[];
    presets: { id: string; label: string; groups: string[] }[];
    note: string;
    format: string;
  };
  [k: string]: unknown;
}

export interface ClassificationRules {
  algorithm_version: string;
  config: Record<string, number>;
  constants: { geo_altitude_km: number; sidereal_day_s: number; sso_raan_rate_deg_day: number };
  notes: string[];
}

// ------------------------------------------------------------ Phase 4
export type Priority = "HIGH" | "MEDIUM" | "LOW";

export interface ScreeningRun {
  id: number;
  primary_norad_id: number;
  primary_name: string | null;
  start: string;
  horizon_h: number;
  step_s: number;
  threshold_km: number;
  hbr_m: number;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  created_at: string;
  finished_at: string | null;
  stats: {
    candidates_total: number;
    candidates_after_shell_filter: number;
    grid_samples: number;
    pair_intervals_evaluated: number;
    intervals_flagged: number;
    refinements: number;
    events: number;
    secondaries_with_sgp4_errors: number;
    primary_sgp4_errors: number;
    runtime_s: number;
  } | null;
  warnings: string[];
  message: string | null;
  algorithm_version: string | null;
}

export interface ConjunctionEvent {
  id: number;
  run_id: number;
  primary_norad_id: number;
  primary_name: string | null;
  secondary_norad_id: number;
  secondary_name: string | null;
  tca: string;
  miss_distance_km: number;
  relative_speed_kms: number;
  approach_angle_deg: number;
  miss_rtn_km: [number, number, number];
  priority: Priority;
  pc_max_isotropic: number;
  covariance_status: string;
  prediction_span_days: number | null;
  data_confidence: "adequate" | "reduced" | "low" | null;
}

export interface PcAssessment {
  status: "computed" | "covariance-unavailable";
  covariance_source: string;
  pc: number | null;
  miss_distance_km: number;
  hbr_km: number;
  encounter_plane_miss_km: [number, number];
  encounter_plane_cov_km2: [[number, number], [number, number]] | null;
  mahalanobis: number | null;
  pc_max_isotropic: number;
  pc_max_sigma_km: number;
  sensitivity: { scale: number; pc: number }[];
  algorithm_version: string;
  assumptions: string[];
  ellipse_1sigma?: { semi_axes_km: [number, number]; angle_deg: number };
  saved_assessment_id?: number;
}

export interface ConjunctionDetail extends ConjunctionEvent {
  hbr_m: number;
  relative_trajectory_rtn: { t_s: number[]; R_km: number[]; T_km: number[]; N_km: number[]; frame: string };
  assessment: PcAssessment;
  element_sets: { primary: { id: number; epoch: string; source: string }; secondary: { id: number; epoch: string; source: string } };
  screening: ScreeningRun;
  saved_assessments: { id: number; created_at: string; covariance_source: string; inputs: Record<string, unknown>; pc: number | null }[];
}

// ------------------------------------------------------- external validation
export interface DatasetJob {
  id: number;
  kind: "kelvins-import" | "socrates-import" | "socrates-compare";
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  created_at: string;
  finished_at: string | null;
  params: Record<string, unknown> | null;
  files: { path: string; bytes: number; sha256: string; split?: string; modified?: string }[] | null;
  summary: Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  message: string | null;
}

export interface DatasetFiles {
  data_dir: string;
  exists: boolean;
  kelvins: Partial<Record<"train" | "test" | "test_private", { path: string; bytes: number }>>;
  socrates: { path: string; bytes: number }[];
}

export interface KelvinsEventRow {
  split: string;
  event_id: number;
  mission_id: number;
  cdm_count: number;
  last_time_to_tca_d: number;
  esa_risk: number | null;
  our_log10_pc: number | null;
  miss_m: number | null;
  chaser_type: string | null;
  geometry_status: string;
}

export interface KelvinsEventDetail {
  split: string;
  event_id: number;
  mission_id: number;
  mission_median_hbr_m: number | null;
  chaser_type: string | null;
  series: {
    time_to_tca_d: number;
    esa_risk: number | null;
    our_log10_pc: number | null;
    inferred_hbr_m: number | null;
    miss_m: number | null;
    esa_mahalanobis: number | null;
    our_mahalanobis: number | null;
    geometry_status: string;
  }[];
  last_cdm_plane: PcAssessment | null;
}

export interface SocratesRow {
  id: number;
  norad_1: number;
  name_1: string;
  status_1: string | null;
  norad_2: number;
  name_2: string;
  status_2: string | null;
  tca: string;
  range_km: number;
  relative_speed_kms: number;
  max_prob: number;
  dse_1: number;
  dse_2: number;
  compare_status: string | null;
  epoch_offset_1_s: number | null;
  epoch_offset_2_s: number | null;
  our_tca: string | null;
  our_range_km: number | null;
  our_relative_speed_kms: number | null;
  dt_s: number | null;
}
