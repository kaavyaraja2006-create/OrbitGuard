from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# Repository layout: <repo>/backend/app/core/config.py  ->  <repo>/data/raw
_DEFAULT_DATA_DIR = Path(__file__).resolve().parents[3] / "data" / "raw"


def _list(name: str, default: str) -> list[str]:
    return [x.strip() for x in os.getenv(name, default).split(",") if x.strip()]


@dataclass(frozen=True)
class Settings:
    database_url: str = os.getenv("ORBITGUARD_DATABASE_URL", "sqlite:///./orbitguard.db")
    celestrak_base_url: str = os.getenv("ORBITGUARD_CELESTRAK_URL", "https://celestrak.org/NORAD/elements/gp.php")
    # CelesTrak asks clients not to re-download the same group more often than
    # every 2 hours (data only updates that often); we enforce it client-side.
    celestrak_min_refresh_hours: float = float(os.getenv("ORBITGUARD_CELESTRAK_MIN_REFRESH_H", "2"))
    http_timeout_s: float = float(os.getenv("ORBITGUARD_HTTP_TIMEOUT_S", "60"))
    cors_origins: list[str] = field(default_factory=lambda: _list("ORBITGUARD_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"))
    user_agent: str = "ORBITGUARD/0.1 (research prototype)"
    # Local folder holding downloaded datasets (Kelvins, SOCRATES). Read server-side only.
    data_dir: Path = Path(os.getenv("ORBITGUARD_DATA_DIR", str(_DEFAULT_DATA_DIR)))

    # ---- authentication / sessions
    session_cookie: str = "og_session"
    # Secure cookies need HTTPS. Turn on in production (ORBITGUARD_COOKIE_SECURE=1).
    cookie_secure: bool = os.getenv("ORBITGUARD_COOKIE_SECURE", "0") == "1"
    session_hours: float = float(os.getenv("ORBITGUARD_SESSION_HOURS", "12"))
    session_remember_days: float = float(os.getenv("ORBITGUARD_SESSION_REMEMBER_DAYS", "14"))
    session_idle_minutes: float = float(os.getenv("ORBITGUARD_SESSION_IDLE_MINUTES", "120"))
    max_failed_logins: int = int(os.getenv("ORBITGUARD_MAX_FAILED_LOGINS", "5"))
    lockout_minutes: float = float(os.getenv("ORBITGUARD_LOCKOUT_MINUTES", "15"))
    reset_token_minutes: float = float(os.getenv("ORBITGUARD_RESET_TOKEN_MINUTES", "30"))
    invite_token_hours: float = float(os.getenv("ORBITGUARD_INVITE_TOKEN_HOURS", "72"))
    require_email_verification: bool = os.getenv("ORBITGUARD_REQUIRE_EMAIL_VERIFICATION", "1") == "1"
    # Only behind a reverse proxy you control: take the client IP from X-Forwarded-For.
    trust_proxy: bool = os.getenv("ORBITGUARD_TRUST_PROXY", "0") == "1"
    allow_public_registration: bool = os.getenv("ORBITGUARD_ALLOW_PUBLIC_REGISTRATION", "1") == "1"
    # Base URL of the web UI, used in e-mailed links.
    public_url: str = os.getenv("ORBITGUARD_PUBLIC_URL", "http://localhost:5173").rstrip("/")
    # ---- outgoing mail (optional). Without SMTP_HOST mail is kept in the outbox and printed to the console.
    smtp_host: str | None = os.getenv("ORBITGUARD_SMTP_HOST") or None
    smtp_port: int = int(os.getenv("ORBITGUARD_SMTP_PORT", "587"))
    smtp_user: str | None = os.getenv("ORBITGUARD_SMTP_USER") or None
    smtp_password: str | None = os.getenv("ORBITGUARD_SMTP_PASSWORD") or None
    smtp_from: str = os.getenv("ORBITGUARD_SMTP_FROM", "ORBITGUARD <no-reply@orbitguard.local>")
    smtp_starttls: bool = os.getenv("ORBITGUARD_SMTP_STARTTLS", "1") == "1"


settings = Settings()

# Groups offered in the UI. Keys are CelesTrak GP "GROUP" identifiers
# (https://celestrak.org/NORAD/elements/). "section" groups them in the UI.
CELESTRAK_GROUPS: dict[str, dict] = {
    # Special interest
    "stations": {"label": "Space stations (ISS, Tiangong)", "kind": "payload", "section": "Special interest"},
    "visual": {"label": "100 brightest (Hubble, ISS, large R/B)", "kind": None, "section": "Special interest"},
    "active": {"label": "ALL active satellites (~10,000+)", "kind": "payload", "active_list": True, "section": "Special interest"},
    "last-30-days": {"label": "Launched in the last 30 days", "kind": None, "section": "Special interest"},
    # Earth observation and weather
    "weather": {"label": "Weather (NOAA, GOES, Meteosat, Metop)", "kind": "payload", "section": "Weather & Earth"},
    "resource": {"label": "Earth resources (Landsat, Sentinel, Cartosat)", "kind": "payload", "section": "Weather & Earth"},
    "sar": {"label": "Synthetic aperture radar", "kind": "payload", "section": "Weather & Earth"},
    # Science
    "science": {"label": "Space & Earth science (Hubble, Swift, ...)", "kind": "payload", "section": "Science"},
    "geodetic": {"label": "Geodetic (LAGEOS, laser-ranging targets)", "kind": "payload", "section": "Science"},
    # Navigation
    "gnss": {"label": "All GNSS (GPS, Galileo, GLONASS, BeiDou)", "kind": "payload", "section": "Navigation"},
    "gps-ops": {"label": "GPS operational", "kind": "payload", "section": "Navigation"},
    # Communications
    "geo": {"label": "Active geosynchronous", "kind": "payload", "section": "Communications"},
    "starlink": {"label": "Starlink", "kind": "payload", "section": "Communications"},
    "oneweb": {"label": "OneWeb", "kind": "payload", "section": "Communications"},
    "iridium-NEXT": {"label": "Iridium NEXT", "kind": "payload", "section": "Communications"},
    # Small satellites
    "cubesat": {"label": "CubeSats", "kind": "payload", "section": "Small satellites"},
    # Debris (CelesTrak publishes these three clouds; full debris/R/B catalog needs Space-Track)
    "fengyun-1c-debris": {"label": "Fengyun-1C ASAT test debris", "kind": "debris", "section": "Debris"},
    "iridium-33-debris": {"label": "Iridium 33 collision debris", "kind": "debris", "section": "Debris"},
    "cosmos-2251-debris": {"label": "Cosmos 2251 collision debris", "kind": "debris", "section": "Debris"},
}

CELESTRAK_PRESETS: dict[str, dict] = {
    "famous": {
        "label": "Famous & large satellites",
        "groups": ["stations", "visual", "science", "weather", "resource", "gnss", "geo"],
    },
    "public-catalog": {
        "label": "Everything CelesTrak publishes",
        "groups": ["active", "visual", "last-30-days", "fengyun-1c-debris", "iridium-33-debris", "cosmos-2251-debris"],
    },
}
