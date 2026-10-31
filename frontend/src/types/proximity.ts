import type { Freshness, OrbitLabel } from "./index";

export type Category = "active_satellite" | "inactive_satellite" | "satellite_unknown_status" | "rocket_body" | "debris" | "unknown";

export interface CatalogItem {
  norad_id: number;
  name: string | null;
  intl_designator: string | null;
  object_type: string;
  operational_status: string;
  category: Category;
  category_label: string;
  labels: OrbitLabel[];
  epoch: string;
  element_set_id: number;
  age_days: number;
  freshness: Freshness;
  perigee_alt_km?: number;
  apogee_alt_km?: number;
  i_deg?: number;
  period_min?: number | null;
}

export interface SearchResult {
  total: number;
  offset: number;
  limit: number;
  items: CatalogItem[];
  categories: Record<Category, string>;
}

export interface Geo {
  lat_deg: number;
  lon_deg: number;
  alt_km: number;
  ecef_km: number[];
}

export interface TrackState {
  time: string;
  sgp4_error_code: number;
  propagation: string;
  teme?: { r_km: number[]; v_kms: number[] };
  geodetic?: Geo;
  speed_kms?: number;
}

export interface MeanSummary {
  a_km: number;
  e: number;
  i_deg: number;
  raan_deg: number;
  argp_deg: number;
  period_min: number | null;
  perigee_alt_km: number;
  apogee_alt_km: number;
  kind: string;
}

export interface TrackedItem extends Partial<CatalogItem> {
  norad_id: number;
  status: "ok" | "propagation-failed" | "not-in-catalog";
  message?: string;
  state?: TrackState;
  mean_elements?: MeanSummary;
  orbit?: { frame: string; start: string; duration_s: number; step_s: number; ecef_km: number[][]; valid: boolean[]; errors: string[] };
}

export interface ConjunctionTag {
  event_id: number;
  priority: "HIGH" | "MEDIUM" | "LOW";
  tca: string;
  miss_distance_km: number;
}

export interface NearbyItem extends CatalogItem {
  mode: "current";
  distance_km: number;
  relative_speed_kms: number;
  range_rate_kms: number;
  motion: "closing" | "opening";
  r_rel_rtn_km: number[];
  position: Geo;
  propagation: string;
  conjunction: ConjunctionTag | null;
}

export interface NearbyResult {
  norad_id: number;
  status: "ok" | "propagation-failed" | "not-in-catalog";
  message?: string;
  satellite?: CatalogItem;
  state?: TrackState;
  radius_km: number;
  total: number;
  counts: Partial<Record<Category, number>>;
  items: NearbyItem[];
  offset?: number;
  limit?: number;
}

export interface ProximityScreen {
  mode: "current";
  time: string;
  radius_km: number;
  categories: Category[] | null;
  unique_nearby_objects: number;
  uncertainty: string;
  note: string;
  results: NearbyResult[];
}

export interface FutureWindow extends CatalogItem {
  mode: "future";
  secondary_id: number;
  tca: string;
  min_distance_km: number;
  relative_speed_kms: number;
  r_rel_rtn_km: number[];
  entry: string | null;
  exit: string | null;
  inside_at_start: boolean;
  duration_s: number;
  conjunction: ConjunctionTag | null;
}

export interface ProximityJob {
  id: number;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  created_at: string;
  finished_at: string | null;
  params: { norad_ids: number[]; start: string; horizon_h: number; radius_km: number; step_s: number; categories: Category[] | null };
  message: string | null;
  result?: {
    algorithm_version: string;
    start: string;
    end: string;
    uncertainty: string;
    satellites: {
      norad_id: number;
      satellite?: CatalogItem;
      status: string;
      warnings?: string[];
      stats: Record<string, number> | null;
      windows: FutureWindow[];
      total: number;
      unique_objects?: number;
    }[];
  };
}

export interface CompareRow {
  norad_id: number;
  name: string | null;
  category?: Category;
  labels?: OrbitLabel[];
  status: string;
  message?: string;
  altitude_km?: number | null;
  perigee_alt_km?: number;
  apogee_alt_km?: number;
  inclination_deg?: number;
  eccentricity?: number;
  period_min?: number | null;
  position?: { lat_deg: number; lon_deg: number } | null;
  speed_kms?: number;
  nearby_count?: number | null;
  epoch?: string;
  freshness?: Freshness;
}
