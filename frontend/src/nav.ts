import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BarChart3,
  Box,
  Clapperboard,
  Database,
  FileText,
  FlaskConical,
  Gauge,
  Globe2,
  Layers,
  Orbit,
  Radar,
  Route,
  ShieldAlert,
  Shuffle,
  Sparkles,
  Trash2,
} from "lucide-react";

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Phase in which the module becomes functional. Built items have built: true. */
  phase: number;
  built: boolean;
  summary: string;
  /** Permission the backend requires for this page's data. Items the user lacks are hidden. */
  perm?: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    title: "Overview",
    items: [{ path: "/", label: "Mission Overview", icon: Gauge, phase: 1, built: true, perm: "catalog:read", summary: "Catalog status, globe and system health" }],
  },
  {
    title: "Space Intelligence",
    items: [
      { path: "/environment", label: "Space Environment", icon: Globe2, phase: 1, built: true, perm: "catalog:read", summary: "3D propagated positions of every tracked object" },
      { path: "/orbits", label: "Orbit Intelligence", icon: Orbit, phase: 2, built: true, perm: "catalog:read", summary: "Six-label multi-label orbit classification" },
      { path: "/tracking", label: "Satellite Tracking", icon: Radar, phase: 3, built: true, perm: "catalog:read", summary: "Search, filter and inspect catalog objects" },
      { path: "/debris", label: "Debris Monitoring", icon: Trash2, phase: 3, built: true, perm: "catalog:read", summary: "Debris and rocket bodies with metadata gaps shown" },
    ],
  },
  {
    title: "Safety Analysis",
    items: [
      { path: "/collision", label: "Collision Assessment", icon: ShieldAlert, phase: 4, built: true, perm: "conjunction:read", summary: "Broad-phase screening, TCA refinement and Pc where covariance exists" },
      { path: "/threats", label: "Threat Monitoring", icon: Activity, phase: 4, built: true, perm: "conjunction:read", summary: "Prioritised conjunction events over the screening horizon" },
    ],
  },
  {
    title: "Simulation",
    items: [
      { path: "/digital-twin", label: "Digital Twin", icon: Box, phase: 5, built: true, perm: "twin:read", summary: "Configurable spacecraft: mass, propulsion, fuel, mission limits" },
      { path: "/maneuvers", label: "Maneuver Optimization", icon: Sparkles, phase: 6, built: true, perm: "twin:read", summary: "Candidate generation and multi-threat optimisation" },
      { path: "/simulation", label: "Simulation Laboratory", icon: Route, phase: 7, built: true, perm: "twin:read", summary: "Before/after trajectories with numerical propagation" },
      { path: "/scenario", label: "Scenario Visualizer", icon: Clapperboard, phase: 7, built: true, perm: "twin:read", summary: "Guided cinematic replay: approach, burn, avoided encounters, alternatives" },
      { path: "/transfers", label: "Orbit Transfer Lab", icon: Shuffle, phase: 7, built: true, perm: "orbits:compute", summary: "Hohmann, plane change and orbit raising, idealised" },
    ],
  },
  {
    title: "Research",
    items: [
      { path: "/validation", label: "Validation", icon: FlaskConical, phase: 4, built: true, perm: "validation:read", summary: "Checks against ESA Kelvins CDMs and CelesTrak SOCRATES" },
      { path: "/research", label: "Research Analytics", icon: BarChart3, phase: 8, built: true, perm: "research:read", summary: "Baselines, ablations and robustness experiments" },
      { path: "/audit", label: "Reports & Audit", icon: FileText, phase: 1, built: true, perm: "audit:read", summary: "Maneuver reports, ingestion history and audit trail" },
    ],
  },
  {
    title: "Data",
    items: [{ path: "/data", label: "Data Sources", icon: Database, phase: 1, built: true, perm: "data:read", summary: "Ingest CelesTrak groups or upload TLE files" }],
  },
];

export const ALL_ITEMS = NAV.flatMap((g) => g.items);

/** Groups visible to a user with the given permissions (UI only; the API enforces the same rules). */
export function navFor(perms: string[]): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.perm || perms.includes(i.perm)) })).filter((g) => g.items.length);
}
export const LayersIcon = Layers;
