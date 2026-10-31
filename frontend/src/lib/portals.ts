import type { LucideIcon } from "lucide-react";
import { Building2, FlaskConical, Globe2, Radar, SatelliteDish, ShieldCheck } from "lucide-react";
import type { PortalSlug, Role } from "../types/auth";

export interface PortalMeta {
  slug: PortalSlug;
  role: Role;
  label: string;
  short: string;
  icon: LucideIcon;
  accent: string;
  tagline: string;
  capabilities: string[];
  dashboard: string;
  restricted: boolean;
}

/** Presentation only. Which account may use which portal is decided by the server. */
export const PORTALS: PortalMeta[] = [
  {
    slug: "admin",
    role: "super_admin",
    label: "Super Administrator",
    short: "Platform control",
    icon: ShieldCheck,
    accent: "#FF647C",
    tagline: "Platform governance, identity and access control.",
    capabilities: ["Organisations and every user account", "Roles and the permission matrix", "Security events and e-mail log"],
    dashboard: "/admin",
    restricted: true,
  },
  {
    slug: "org-admin",
    role: "org_admin",
    label: "Organization Administrator",
    short: "Organisation console",
    icon: Building2,
    accent: "#A78BFA",
    tagline: "Your agency's people, departments and satellite fleet.",
    capabilities: ["Invite and manage your team", "Departments and fleet satellites", "Operator assignments"],
    dashboard: "/org",
    restricted: true,
  },
  {
    slug: "mission",
    role: "mission_manager",
    label: "Mission Operations Manager",
    short: "Mission control",
    icon: Radar,
    accent: "#F5B942",
    tagline: "The fleet's conjunction picture and screening decisions.",
    capabilities: ["Fleet-wide conjunction overview", "Screening and risk assessment", "Assign satellites to operators"],
    dashboard: "/mission",
    restricted: true,
  },
  {
    slug: "science",
    role: "scientist",
    label: "Scientist / Research Analyst",
    short: "Research lab",
    icon: FlaskConical,
    accent: "#35D39A",
    tagline: "Validation against ESA Kelvins and CelesTrak SOCRATES.",
    capabilities: ["Kelvins CDM Pc reconstruction", "SOCRATES cross-checks", "Collision-probability studies"],
    dashboard: "/science",
    restricted: true,
  },
  {
    slug: "operator",
    role: "operator",
    label: "Satellite Operator / Engineer",
    short: "Operator console",
    icon: SatelliteDish,
    accent: "#4DA3FF",
    tagline: "Monitoring and screening for the satellites assigned to you.",
    capabilities: ["Your assigned satellites", "Their conjunction events", "Nearby-object detection"],
    dashboard: "/operator",
    restricted: true,
  },
  {
    slug: "public",
    role: "public",
    label: "Public User",
    short: "Public tracker",
    icon: Globe2,
    accent: "#36D6E8",
    tagline: "Follow real satellites in 3D, propagated from public orbital data.",
    capabilities: ["Live 3D satellite positions", "Orbit classification", "Nearby objects right now"],
    dashboard: "/public",
    restricted: false,
  },
];

export const portalBySlug = (slug?: string) => PORTALS.find((p) => p.slug === slug);
export const portalByRole = (role?: string) => PORTALS.find((p) => p.role === role);
