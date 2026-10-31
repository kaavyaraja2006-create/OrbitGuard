"""Role hierarchy, portals and the permission catalogue.

Every API route declares the permission it needs; the role -> permission
matrix below is the default and is stored in ``role_permissions`` so a
Super Administrator can adjust it. A few permissions are *locked* to the
Super Administrator and can never be granted to another role.
"""

from __future__ import annotations

SUPER_ADMIN = "super_admin"
ORG_ADMIN = "org_admin"
MISSION_MANAGER = "mission_manager"
SCIENTIST = "scientist"
OPERATOR = "operator"
PUBLIC = "public"

# Highest privilege first.
ROLES: dict[str, dict] = {
    SUPER_ADMIN: {
        "label": "Super Administrator",
        "portal": "admin",
        "dashboard": "/admin",
        "level": 100,
        "summary": "Platform owner: organisations, all users, roles and permissions, data sources.",
    },
    ORG_ADMIN: {
        "label": "Organization Administrator",
        "portal": "org-admin",
        "dashboard": "/org",
        "level": 80,
        "summary": "Runs one organisation: its users, departments, satellite fleet and assignments.",
    },
    MISSION_MANAGER: {
        "label": "Mission Operations Manager",
        "portal": "mission",
        "dashboard": "/mission",
        "level": 60,
        "summary": "Oversees the fleet's conjunction picture, screening, and operator assignments.",
    },
    SCIENTIST: {
        "label": "Scientist / Research Analyst",
        "portal": "science",
        "dashboard": "/science",
        "level": 50,
        "summary": "Validation against ESA Kelvins and SOCRATES, collision-probability studies.",
    },
    OPERATOR: {
        "label": "Satellite Operator / Engineer",
        "portal": "operator",
        "dashboard": "/operator",
        "level": 40,
        "summary": "Monitors and screens the satellites assigned to them.",
    },
    PUBLIC: {
        "label": "Public User",
        "portal": "public",
        "dashboard": "/public",
        "level": 10,
        "summary": "Read-only satellite tracking and orbit visualisation.",
    },
}

PORTALS: dict[str, str] = {v["portal"]: k for k, v in ROLES.items()}  # portal slug -> role

# Roles an Organization Administrator may hand out inside their own organisation.
ORG_ASSIGNABLE_ROLES = (MISSION_MANAGER, SCIENTIST, OPERATOR)

PERMISSIONS: dict[str, str] = {
    # catalogue / tracking
    "catalog:read": "View the satellite catalogue, positions, orbits and statistics",
    "orbits:compute": "Use the classification and propagation tools",
    "proximity:current": "Nearby-object detection at a single instant",
    "proximity:predict": "Future proximity prediction over a time horizon",
    # data
    "data:read": "View data sources, ingestion runs and history",
    "data:ingest": "Download from CelesTrak and upload TLE files",
    "audit:read": "View the platform audit log",
    # conjunctions
    "conjunction:read": "View conjunction events and screening runs",
    "conjunction:screen": "Start conjunction screenings",
    "risk:assess": "Compute collision probability with assumed covariance",
    "conjunction:all_objects": "Screen any catalogue object (not only assigned satellites)",
    # research
    "validation:read": "View Kelvins / SOCRATES validation results",
    "validation:run": "Run dataset imports and comparisons",
    # fleet
    "fleet:read": "View the organisation's satellite fleet and assignments",
    "fleet:manage": "Add/remove fleet satellites and assign them to operators",
    # digital twin / maneuvers / simulation (Phases 5-7)
    "twin:read": "View simulated satellites (digital twins)",
    "twin:manage": "Create and edit digital twins",
    "maneuver:plan": "Run maneuver optimisation for a digital twin",
    "simulation:run": "Run before/after trajectory simulations",
    "reports:read": "Open technical reports",
    "alerts:read": "Receive system alerts",
    # research (Phase 8)
    "research:read": "View research experiments and results",
    "research:run": "Run research experiments",
    # administration
    "users:manage_org": "Manage users and departments in one's own organisation",
    "users:manage_all": "Manage every user and organisation",
    "permissions:manage": "Edit the role/permission matrix",
    "email:read_outbox": "Read the outgoing e-mail log",
}

# Permissions that existed before Phase 5. Databases created earlier have already been
# offered these; anything not in this set is "new" on upgrade and gets its default grants.
LEGACY_PERMISSIONS_V1 = {
    "catalog:read", "orbits:compute", "proximity:current", "proximity:predict", "data:read", "data:ingest",
    "audit:read", "conjunction:read", "conjunction:screen", "risk:assess", "conjunction:all_objects",
    "validation:read", "validation:run", "fleet:read", "fleet:manage", "users:manage_org", "users:manage_all",
    "permissions:manage", "email:read_outbox",
}

# Never grantable to anyone except the Super Administrator.
LOCKED_TO_SUPER_ADMIN = {"users:manage_all", "permissions:manage", "email:read_outbox"}

DEFAULT_ROLE_PERMISSIONS: dict[str, set[str]] = {
    SUPER_ADMIN: set(PERMISSIONS),
    ORG_ADMIN: {
        "catalog:read", "orbits:compute", "proximity:current", "proximity:predict",
        "data:read", "data:ingest", "audit:read",
        "conjunction:read", "conjunction:screen", "risk:assess", "conjunction:all_objects",
        "fleet:read", "fleet:manage", "users:manage_org",
        "twin:read", "twin:manage", "maneuver:plan", "simulation:run", "reports:read", "alerts:read", "research:read",
    },
    MISSION_MANAGER: {
        "catalog:read", "orbits:compute", "proximity:current", "proximity:predict",
        "data:read", "data:ingest", "audit:read",
        "conjunction:read", "conjunction:screen", "risk:assess", "conjunction:all_objects",
        "validation:read", "fleet:read", "fleet:manage",
        "twin:read", "twin:manage", "maneuver:plan", "simulation:run", "reports:read", "alerts:read", "research:read",
    },
    SCIENTIST: {
        "catalog:read", "orbits:compute", "proximity:current", "proximity:predict",
        "data:read", "conjunction:read", "conjunction:screen", "risk:assess", "conjunction:all_objects",
        "validation:read", "validation:run",
        "twin:read", "twin:manage", "maneuver:plan", "simulation:run", "reports:read", "alerts:read", "research:read", "research:run",
    },
    OPERATOR: {
        "catalog:read", "orbits:compute", "proximity:current", "proximity:predict",
        "data:read", "conjunction:read", "conjunction:screen", "risk:assess", "fleet:read",
        "twin:read", "twin:manage", "maneuver:plan", "simulation:run", "reports:read", "alerts:read",
    },
    PUBLIC: {"catalog:read", "orbits:compute", "proximity:current"},
}

for _r, _p in DEFAULT_ROLE_PERMISSIONS.items():
    assert _p <= set(PERMISSIONS), _r
    assert _r == SUPER_ADMIN or not (_p & LOCKED_TO_SUPER_ADMIN), _r
