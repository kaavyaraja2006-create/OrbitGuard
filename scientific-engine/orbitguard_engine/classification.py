"""Multi-label orbit regime classification.

The six categories overlap, so every label is evaluated independently and an
object may carry several (e.g. LEO + POLAR + SSO). Each decision records the
value that was tested, the threshold, and the outcome, so the result is
inspectable rather than a bare label.

Thresholds are *project conventions* exposed in :class:`ClassificationConfig`.
Notably the HEO eccentricity cut-off and the polar inclination band have no
single universal standard.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

from .constants import (
    GEO_ALTITUDE_KM,
    MU_EARTH,
    R_EARTH,
    SECONDS_PER_DAY,
    SIDEREAL_DAY_S,
    SSO_RAAN_RATE_DEG_DAY,
)
from .elements import derived_parameters

ALGORITHM_VERSION = "orbit-classification/1.0.0"

LABELS = ("LEO", "MEO", "GEO", "POLAR", "SSO", "HEO")


@dataclass(frozen=True)
class ClassificationConfig:
    leo_max_altitude_km: float = 2000.0  # whole orbit below this -> LEO
    meo_min_altitude_km: float = 2000.0
    geo_band_km: float = 200.0  # +/- band around GEO altitude for crossing checks
    # Geosynchronous: mean motion within tolerance of 1 rev per sidereal day.
    # 0.005 rev/day ~ +/-140 km in radius: keeps drifting GEO objects but
    # excludes IADC graveyard orbits (>= ~235 km above GEO).
    geosync_mean_motion_tol_rev_day: float = 0.005
    geostationary_max_e: float = 0.01
    geostationary_max_i_deg: float = 1.0
    polar_band_deg: float = 10.0  # |i - 90| <= band -> POLAR
    sso_rate_tol_deg_day: float = 0.05
    heo_min_eccentricity: float = 0.25  # project convention, not a standard
    reentry_warning_altitude_km: float = 120.0


@dataclass
class Criterion:
    label: str
    passed: bool
    rule: str
    value: float | None
    threshold: str


@dataclass
class ClassificationResult:
    labels: list[str]
    criteria: list[Criterion]
    geo_type: str | None  # "geostationary" | "geosynchronous" | None
    regions_crossed: list[str]
    status: str  # "classified" | "unclassified-regime"
    warnings: list[str] = field(default_factory=list)
    algorithm_version: str = ALGORITHM_VERSION
    config: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = asdict(self)
        return d


def classify_orbit(
    a_km: float,
    e: float,
    i_deg: float,
    *,
    mu: float = MU_EARTH,
    re: float = R_EARTH,
    config: ClassificationConfig | None = None,
) -> ClassificationResult:
    """Classify an orbit from (mean) semi-major axis, eccentricity and inclination."""
    cfg = config or ClassificationConfig()
    if not (a_km > 0 and 0 <= e < 1):
        raise ValueError("Classification requires a closed elliptical orbit (a > 0, 0 <= e < 1)")

    d = derived_parameters(a_km, e, i_deg, mu=mu, re=re)
    hp, ha = d.perigee_altitude_km, d.apogee_altitude_km
    sidereal_rev_per_day = SECONDS_PER_DAY / SIDEREAL_DAY_S  # ~1.00274
    mean_motion_rev_day = SECONDS_PER_DAY / d.period_s
    geo_lo, geo_hi = GEO_ALTITUDE_KM - cfg.geo_band_km, GEO_ALTITUDE_KM + cfg.geo_band_km

    crit: list[Criterion] = []

    def add(label: str, passed: bool, rule: str, value, threshold: str) -> None:
        crit.append(Criterion(label, bool(passed), rule, None if value is None else float(value), threshold))

    add("LEO", ha < cfg.leo_max_altitude_km, "apogee altitude below LEO ceiling", ha, f"< {cfg.leo_max_altitude_km:g} km")
    add(
        "MEO",
        hp >= cfg.meo_min_altitude_km and ha < geo_lo,
        "perigee and apogee altitude between LEO ceiling and GEO band",
        hp,
        f"perigee >= {cfg.meo_min_altitude_km:g} km and apogee < {geo_lo:.0f} km",
    )
    dn = abs(mean_motion_rev_day - sidereal_rev_per_day)
    geosync = dn <= cfg.geosync_mean_motion_tol_rev_day
    add(
        "GEO",
        geosync,
        "mean motion within tolerance of one revolution per sidereal day",
        mean_motion_rev_day,
        f"|n - {sidereal_rev_per_day:.5f}| <= {cfg.geosync_mean_motion_tol_rev_day} rev/day",
    )
    add("POLAR", abs(i_deg - 90.0) <= cfg.polar_band_deg, "inclination near 90 deg", i_deg, f"|i - 90| <= {cfg.polar_band_deg:g} deg")
    add(
        "SSO",
        abs(d.raan_rate_deg_day - SSO_RAAN_RATE_DEG_DAY) <= cfg.sso_rate_tol_deg_day,
        "J2 nodal precession matches Sun-synchronous rate",
        d.raan_rate_deg_day,
        f"{SSO_RAAN_RATE_DEG_DAY:.4f} +/- {cfg.sso_rate_tol_deg_day:g} deg/day",
    )
    add("HEO", e >= cfg.heo_min_eccentricity, "eccentricity at or above project HEO threshold", e, f">= {cfg.heo_min_eccentricity:g} (project convention)")

    labels = [c.label for c in crit if c.passed]

    geo_type = None
    if geosync:
        geo_type = (
            "geostationary"
            if e <= cfg.geostationary_max_e and i_deg <= cfg.geostationary_max_i_deg
            else "geosynchronous"
        )

    regions: list[str] = []
    if hp < cfg.leo_max_altitude_km:
        regions.append("LEO")
    if hp < geo_lo and ha >= cfg.meo_min_altitude_km:
        regions.append("MEO")
    if hp <= geo_hi and ha >= geo_lo:
        regions.append("GEO-band")
    if ha > geo_hi:
        regions.append("above-GEO")

    warnings: list[str] = []
    if hp < cfg.reentry_warning_altitude_km:
        warnings.append(f"Perigee altitude {hp:.1f} km is below {cfg.reentry_warning_altitude_km:g} km: object may be re-entering")
    if "SSO" in labels and e > 0.05:
        warnings.append("SSO rate matched but eccentricity is high; first-order J2 estimate is less reliable")

    has_regime = any(lbl in labels for lbl in ("LEO", "MEO", "GEO", "HEO"))
    status = "classified" if has_regime else "unclassified-regime"
    if not has_regime:
        warnings.append("Orbit is outside the configured LEO/MEO/GEO/HEO definitions (e.g. graveyard or high orbit)")

    return ClassificationResult(
        labels=labels,
        criteria=crit,
        geo_type=geo_type,
        regions_crossed=regions,
        status=status,
        warnings=warnings,
        config=asdict(cfg),
    )


def required_sso_inclination_deg(a_km: float, e: float = 0.0, mu: float = MU_EARTH, re: float = R_EARTH) -> float | None:
    """Inclination at which first-order J2 precession equals the Sun-synchronous rate.

    Returns None when no inclination can achieve it (orbit too high).
    """
    from .constants import J2

    n = math.sqrt(mu / a_km**3)
    p = a_km * (1 - e * e)
    target = math.radians(SSO_RAAN_RATE_DEG_DAY) / SECONDS_PER_DAY
    cos_i = -target / (1.5 * J2 * n * (re / p) ** 2)
    if abs(cos_i) > 1:
        return None
    return math.degrees(math.acos(cos_i))
