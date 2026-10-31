"""Reference-frame and time conversions.

Implemented chain for SGP4 output:

    TEME  --R3(GMST)-->  PEF  ~=  ITRF   (polar motion neglected)

Documented approximations (see docs/mathematics):

* Polar motion (x_p, y_p ~ 0.3 arcsec) is neglected: position error of
  order 10 m at the Earth's surface, far below TLE accuracy (~1 km).
* UT1 is approximated by UTC (|UT1-UTC| < 0.9 s): up to ~0.4 km
  along the rotation direction at the equator. Acceptable for TLE-based
  visualisation; NOT acceptable for precise conjunction assessment, which
  should use proper EOP data (planned with Astropy/Orekit in Phase 4).
"""

from __future__ import annotations

import math
from datetime import datetime, timezone

import numpy as np
from sgp4.api import jday
from sgp4.propagation import gstime

from .constants import OMEGA_EARTH, R_EARTH, WGS84_E2

FRAME_TEME = "TEME"
FRAME_ITRF = "ITRF (PEF approx., polar motion neglected, UT1~UTC)"


def datetime_to_jd(dt: datetime) -> tuple[float, float]:
    """UTC datetime -> (jd whole, jd fraction) for maximum precision."""
    if dt.tzinfo is None:
        raise ValueError("Datetimes must be timezone-aware (UTC)")
    dt = dt.astimezone(timezone.utc)
    return jday(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second + dt.microsecond * 1e-6)


def gmst_rad(jd: float, fr: float = 0.0) -> float:
    """Greenwich Mean Sidereal Time (IAU-82, as used by SGP4), radians in [0, 2pi)."""
    return gstime(jd + fr)


def _r3(theta: float) -> np.ndarray:
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, s, 0.0], [-s, c, 0.0], [0.0, 0.0, 1.0]])


def teme_to_itrf(r_teme, v_teme, jd: float, fr: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    """Rotate TEME state to Earth-fixed. Accepts (3,) or (N,3) arrays."""
    theta = gmst_rad(jd, fr)
    rot = _r3(theta)
    r_t = np.atleast_2d(np.asarray(r_teme, dtype=float))
    v_t = np.atleast_2d(np.asarray(v_teme, dtype=float))
    r_f = r_t @ rot.T
    w = np.array([0.0, 0.0, OMEGA_EARTH])
    v_f = v_t @ rot.T - np.cross(w, r_f)
    if np.ndim(r_teme) == 1:
        return r_f[0], v_f[0]
    return r_f, v_f


def teme_to_itrf_many(r_teme: np.ndarray, jd: np.ndarray, fr: np.ndarray) -> np.ndarray:
    """Vectorised position rotation for N epochs: r_teme (N,3), jd/fr (N,)."""
    theta = np.array([gstime(a + b) for a, b in zip(np.ravel(jd), np.ravel(fr))])
    c, s = np.cos(theta), np.sin(theta)
    x, y, z = r_teme[:, 0], r_teme[:, 1], r_teme[:, 2]
    return np.column_stack((c * x + s * y, -s * x + c * y, z))


def ecef_to_geodetic(r_ecef) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """WGS-84 geodetic latitude/longitude (deg) and ellipsoidal height (km).

    Uses Bowring's iterative method; converges to < 1e-9 rad in a few
    iterations for all Earth-orbit radii. Accepts (3,) or (N,3).
    """
    r = np.atleast_2d(np.asarray(r_ecef, dtype=float))
    x, y, z = r[:, 0], r[:, 1], r[:, 2]
    lon = np.arctan2(y, x)
    rho = np.hypot(x, y)
    lat = np.arctan2(z, rho * (1.0 - WGS84_E2))
    for _ in range(6):
        sin_lat = np.sin(lat)
        n = R_EARTH / np.sqrt(1.0 - WGS84_E2 * sin_lat**2)
        lat = np.arctan2(z + WGS84_E2 * n * sin_lat, rho)
    sin_lat = np.sin(lat)
    cos_lat = np.cos(lat)
    n = R_EARTH / np.sqrt(1.0 - WGS84_E2 * sin_lat**2)
    # Height: use the better-conditioned form depending on latitude.
    with np.errstate(divide="ignore", invalid="ignore"):
        h = np.where(np.abs(cos_lat) > 1e-8, rho / cos_lat - n, np.abs(z) / np.abs(sin_lat) - n * (1 - WGS84_E2))
    lat_d, lon_d = np.degrees(lat), np.degrees(lon)
    if np.ndim(r_ecef) == 1:
        return lat_d[0], lon_d[0], h[0]
    return lat_d, lon_d, h


def geodetic_to_ecef(lat_deg, lon_deg, h_km) -> np.ndarray:
    lat, lon = np.radians(lat_deg), np.radians(lon_deg)
    n = R_EARTH / np.sqrt(1.0 - WGS84_E2 * np.sin(lat) ** 2)
    return np.array(
        [
            (n + h_km) * np.cos(lat) * np.cos(lon),
            (n + h_km) * np.cos(lat) * np.sin(lon),
            (n * (1 - WGS84_E2) + h_km) * np.sin(lat),
        ]
    )


def rtn_basis(r, v) -> np.ndarray:
    """Rows are the Radial, Transverse (along-track), Normal unit vectors."""
    r = np.asarray(r, dtype=float)
    v = np.asarray(v, dtype=float)
    R = r / np.linalg.norm(r)
    N = np.cross(r, v)
    N /= np.linalg.norm(N)
    T = np.cross(N, R)
    return np.vstack((R, T, N))
