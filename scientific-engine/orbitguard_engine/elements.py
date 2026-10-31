"""Classical orbital elements and derived orbit parameters.

Conventions follow Vallado, *Fundamentals of Astrodynamics and Applications*
(algorithms RV2COE / COE2RV). Angles are returned in degrees in the public
dataclasses and handled in radians internally.

Special cases (circular and/or equatorial orbits) make some angles undefined.
Rather than inventing a value, the result flags them in ``undefined`` and
reports the substitute angle that *is* defined (argument of latitude, true
longitude of periapsis, or true longitude).
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

import numpy as np

from .constants import J2, MU_EARTH, R_EARTH, SECONDS_PER_DAY

SMALL = 1e-10  # threshold for e ~ 0 and i ~ 0 tests


@dataclass
class ClassicalElements:
    a_km: float  # semi-major axis (inf for parabolic)
    e: float
    i_deg: float
    raan_deg: float
    argp_deg: float
    nu_deg: float
    p_km: float  # semi-latus rectum
    undefined: list[str] = field(default_factory=list)
    arglat_deg: float | None = None  # argument of latitude (circular inclined)
    truelon_deg: float | None = None  # true longitude (circular equatorial)
    lonper_deg: float | None = None  # longitude of periapsis (elliptical equatorial)

    def to_dict(self) -> dict:
        return asdict(self)


def _angle(a: np.ndarray, b: np.ndarray) -> float:
    c = float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
    return math.acos(max(-1.0, min(1.0, c)))


def rv_to_coe(r_km, v_kms, mu: float = MU_EARTH) -> ClassicalElements:
    """Convert an inertial state vector to classical orbital elements."""
    r = np.asarray(r_km, dtype=float)
    v = np.asarray(v_kms, dtype=float)
    rmag = np.linalg.norm(r)
    vmag = np.linalg.norm(v)
    if rmag <= 0:
        raise ValueError("Position vector must be non-zero")

    h = np.cross(r, v)
    hmag = np.linalg.norm(h)
    if hmag < SMALL:
        raise ValueError("Rectilinear trajectory (zero angular momentum) is not supported")

    k = np.array([0.0, 0.0, 1.0])
    n = np.cross(k, h)
    nmag = np.linalg.norm(n)

    e_vec = ((vmag**2 - mu / rmag) * r - np.dot(r, v) * v) / mu
    e = float(np.linalg.norm(e_vec))

    energy = vmag**2 / 2.0 - mu / rmag
    a = -mu / (2.0 * energy) if abs(e - 1.0) > SMALL else math.inf
    p = hmag**2 / mu

    i = math.acos(max(-1.0, min(1.0, h[2] / hmag)))

    circular = e < SMALL
    equatorial = nmag < SMALL or i < SMALL or abs(i - math.pi) < SMALL

    undefined: list[str] = []
    raan = argp = nu = 0.0
    arglat = truelon = lonper = None

    if not equatorial:
        raan = math.acos(max(-1.0, min(1.0, n[0] / nmag)))
        if n[1] < 0:
            raan = 2 * math.pi - raan
    else:
        undefined.append("raan")

    if not circular and not equatorial:
        argp = _angle(n, e_vec)
        if e_vec[2] < 0:
            argp = 2 * math.pi - argp
    else:
        undefined.append("argp")

    if not circular:
        nu = _angle(e_vec, r)
        if np.dot(r, v) < 0:
            nu = 2 * math.pi - nu
    else:
        undefined.append("nu")

    if circular and not equatorial:
        u = _angle(n, r)
        if r[2] < 0:
            u = 2 * math.pi - u
        arglat = math.degrees(u)
    if not circular and equatorial:
        lp = math.acos(max(-1.0, min(1.0, e_vec[0] / e)))
        if e_vec[1] < 0:
            lp = 2 * math.pi - lp
        if i > math.pi / 2:
            lp = 2 * math.pi - lp
        lonper = math.degrees(lp)
    if circular and equatorial:
        tl = math.acos(max(-1.0, min(1.0, r[0] / rmag)))
        if r[1] < 0:
            tl = 2 * math.pi - tl
        if i > math.pi / 2:
            tl = 2 * math.pi - tl
        truelon = math.degrees(tl)

    return ClassicalElements(
        a_km=a,
        e=e,
        i_deg=math.degrees(i),
        raan_deg=math.degrees(raan),
        argp_deg=math.degrees(argp),
        nu_deg=math.degrees(nu),
        p_km=p,
        undefined=undefined,
        arglat_deg=arglat,
        truelon_deg=truelon,
        lonper_deg=lonper,
    )


def coe_to_rv(
    p_km: float,
    e: float,
    i_deg: float,
    raan_deg: float,
    argp_deg: float,
    nu_deg: float,
    mu: float = MU_EARTH,
) -> tuple[np.ndarray, np.ndarray]:
    """Classical elements -> inertial position (km) and velocity (km/s).

    For circular or equatorial orbits pass the substitute angle in place of
    the undefined one (Vallado convention): e.g. argument of latitude in
    ``nu_deg`` with ``argp_deg=0`` for circular inclined orbits.
    """
    i, raan, argp, nu = (math.radians(x) for x in (i_deg, raan_deg, argp_deg, nu_deg))
    cnu, snu = math.cos(nu), math.sin(nu)
    denom = 1.0 + e * cnu
    if denom <= 0:
        raise ValueError("True anomaly not reachable on this conic")
    r_pqw = np.array([p_km * cnu / denom, p_km * snu / denom, 0.0])
    sp = math.sqrt(mu / p_km)
    v_pqw = np.array([-sp * snu, sp * (e + cnu), 0.0])

    co, so = math.cos(raan), math.sin(raan)
    cw, sw = math.cos(argp), math.sin(argp)
    ci, si = math.cos(i), math.sin(i)
    rot = np.array(
        [
            [co * cw - so * sw * ci, -co * sw - so * cw * ci, so * si],
            [so * cw + co * sw * ci, -so * sw + co * cw * ci, -co * si],
            [sw * si, cw * si, ci],
        ]
    )
    return rot @ r_pqw, rot @ v_pqw


@dataclass
class DerivedParameters:
    perigee_radius_km: float
    apogee_radius_km: float
    perigee_altitude_km: float
    apogee_altitude_km: float
    period_s: float
    period_min: float
    mean_motion_rad_s: float
    specific_energy_km2_s2: float
    specific_angular_momentum_km2_s: float
    raan_rate_deg_day: float  # J2 secular nodal precession
    argp_rate_deg_day: float  # J2 secular apsidal rotation
    velocity_perigee_kms: float
    velocity_apogee_kms: float

    def to_dict(self) -> dict:
        return asdict(self)


def j2_secular_rates(a_km: float, e: float, i_deg: float, mu: float = MU_EARTH, re: float = R_EARTH, j2: float = J2):
    """First-order J2 secular rates of RAAN and argument of perigee (rad/s).

    dΩ/dt = -(3/2) J2 n (Re/p)^2 cos i
    dω/dt =  (3/4) J2 n (Re/p)^2 (5 cos^2 i - 1)
    """
    n = math.sqrt(mu / a_km**3)
    p = a_km * (1.0 - e * e)
    factor = j2 * n * (re / p) ** 2
    ci = math.cos(math.radians(i_deg))
    raan_dot = -1.5 * factor * ci
    argp_dot = 0.75 * factor * (5.0 * ci * ci - 1.0)
    return raan_dot, argp_dot


def derived_parameters(a_km: float, e: float, i_deg: float, mu: float = MU_EARTH, re: float = R_EARTH) -> DerivedParameters:
    """Geometric and dynamic parameters of a closed (elliptical) orbit."""
    if not (a_km > 0 and 0 <= e < 1):
        raise ValueError("Derived parameters are defined here for elliptical orbits only")
    rp = a_km * (1.0 - e)
    ra = a_km * (1.0 + e)
    n = math.sqrt(mu / a_km**3)
    period = 2.0 * math.pi / n
    energy = -mu / (2.0 * a_km)
    p = a_km * (1.0 - e * e)
    h = math.sqrt(mu * p)
    raan_dot, argp_dot = j2_secular_rates(a_km, e, i_deg, mu=mu, re=re)
    to_deg_day = math.degrees(1.0) * SECONDS_PER_DAY
    return DerivedParameters(
        perigee_radius_km=rp,
        apogee_radius_km=ra,
        perigee_altitude_km=rp - re,
        apogee_altitude_km=ra - re,
        period_s=period,
        period_min=period / 60.0,
        mean_motion_rad_s=n,
        specific_energy_km2_s2=energy,
        specific_angular_momentum_km2_s=h,
        raan_rate_deg_day=raan_dot * to_deg_day,
        argp_rate_deg_day=argp_dot * to_deg_day,
        velocity_perigee_kms=math.sqrt(mu * (2.0 / rp - 1.0 / a_km)),
        velocity_apogee_kms=math.sqrt(mu * (2.0 / ra - 1.0 / a_km)),
    )
