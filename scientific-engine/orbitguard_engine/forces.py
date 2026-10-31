"""Force models for numerical propagation of maneuverable (simulated) satellites.

All accelerations are in km/s^2 for positions in km, in a quasi-inertial frame
(the TEME frame of the propagation start epoch, held fixed; see numerical.py).
Every function accepts a batch of states: r has shape (N, 3).

Models
------
* Central gravity              -mu r / |r|^3                     (EGM-96 mu)
* Zonal harmonics J2, J3, J4   closed form (Vallado 2013, eq. 8-30 family),
                               checked in tests against the gradient of the potential
* Atmospheric drag             -1/2 (Cd A/m) rho |v_rel| v_rel, v_rel = v - w_E x r,
                               static exponential density (Vallado 2013, Table 8-4)
* Sun and Moon third body      mu_k [ (s - r)/|s - r|^3 - s/|s|^3 ]
                               low-precision ephemerides (Vallado 2013, Algorithms 29 and 31)
* Solar radiation pressure     cannonball, P = 4.56e-6 N/m^2 at 1 AU, cylindrical shadow

Simplifications are stated where they are made; none of these models is
claimed to be operational-grade.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import numpy as np

from .constants import MU_EARTH, OMEGA_EARTH, R_EARTH

J2_EGM96 = 1.08262668e-3
J3_EGM96 = -2.53265649e-6
J4_EGM96 = -1.61962159e-6
MU_SUN = 1.32712440018e11  # km^3/s^2
MU_MOON = 4902.800066  # km^3/s^2
AU_KM = 149597870.7
P_SRP_1AU = 4.56e-6  # N/m^2 (solar flux / c at 1 AU)
G0 = 9.80665  # m/s^2, standard gravity (rocket equation)

FRAME_INERTIAL = "TEME of the propagation start epoch, held fixed (quasi-inertial)"


@dataclass(frozen=True)
class ForceModel:
    """Which accelerations to include. Defaults: central gravity + J2 (the spec's baseline)."""

    j2: bool = True
    j3: bool = False
    j4: bool = False
    drag: bool = False
    srp: bool = False
    sun: bool = False
    moon: bool = False

    def describe(self) -> list[str]:
        terms = ["central gravity (mu=398600.4418)"]
        terms += [n for n, on in (("J2", self.j2), ("J3", self.j3), ("J4", self.j4)) if on]
        if self.drag:
            terms.append("drag (exponential atmosphere, Vallado Table 8-4, co-rotating)")
        if self.sun:
            terms.append("Sun third body")
        if self.moon:
            terms.append("Moon third body")
        if self.srp:
            terms.append("solar radiation pressure (cannonball, cylindrical shadow)")
        return terms

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def full() -> "ForceModel":
        return ForceModel(True, True, True, True, True, True, True)


# ------------------------------------------------------------------ gravity
def accel_central(r: np.ndarray, mu: float = MU_EARTH) -> np.ndarray:
    rn = np.linalg.norm(r, axis=1, keepdims=True)
    return -mu * r / rn**3


def accel_zonal(r: np.ndarray, j2: bool = True, j3: bool = False, j4: bool = False, mu: float = MU_EARTH, re: float = R_EARTH) -> np.ndarray:
    x, y, z = r[:, 0], r[:, 1], r[:, 2]
    r2 = x * x + y * y + z * z
    rn = np.sqrt(r2)
    zr2 = z * z / r2
    a = np.zeros_like(r)
    if j2:
        k = -1.5 * J2_EGM96 * mu * re**2 / rn**5
        a[:, 0] += k * x * (1 - 5 * zr2)
        a[:, 1] += k * y * (1 - 5 * zr2)
        a[:, 2] += k * z * (3 - 5 * zr2)
    if j3:
        k = -2.5 * J3_EGM96 * mu * re**3 / rn**7
        a[:, 0] += k * x * (3 * z - 7 * z**3 / r2)
        a[:, 1] += k * y * (3 * z - 7 * z**3 / r2)
        a[:, 2] += k * (6 * z * z - 7 * z**4 / r2 - 0.6 * r2)
    if j4:
        k = 1.875 * J4_EGM96 * mu * re**4 / rn**7
        a[:, 0] += k * x * (1 - 14 * zr2 + 21 * zr2**2)
        a[:, 1] += k * y * (1 - 14 * zr2 + 21 * zr2**2)
        a[:, 2] += k * z * (5 - 70.0 / 3.0 * zr2 + 21 * zr2**2)
    return a


def zonal_potential(r: np.ndarray, mu: float = MU_EARTH, re: float = R_EARTH, j2=True, j3=False, j4=False, central=True) -> np.ndarray:
    """Gravitational potential (km^2/s^2, sign convention a = +grad U). Used to verify accel_zonal."""
    rn = np.linalg.norm(r, axis=1)
    s = r[:, 2] / rn
    u = mu / rn if central else np.zeros_like(rn)
    if j2:
        u = u - mu / rn * J2_EGM96 * (re / rn) ** 2 * 0.5 * (3 * s**2 - 1)
    if j3:
        u = u - mu / rn * J3_EGM96 * (re / rn) ** 3 * 0.5 * (5 * s**3 - 3 * s)
    if j4:
        u = u - mu / rn * J4_EGM96 * (re / rn) ** 4 * 0.125 * (35 * s**4 - 30 * s**2 + 3)
    return u


# --------------------------------------------------------------- atmosphere
# Base altitude (km), nominal density (kg/m^3), scale height (km). Vallado (2013) Table 8-4.
_ATM = np.array(
    [
        (0, 1.225, 7.249), (25, 3.899e-2, 6.349), (30, 1.774e-2, 6.682), (40, 3.972e-3, 7.554),
        (50, 1.057e-3, 8.382), (60, 3.206e-4, 7.714), (70, 8.770e-5, 6.549), (80, 1.905e-5, 5.799),
        (90, 3.396e-6, 5.382), (100, 5.297e-7, 5.877), (110, 9.661e-8, 7.263), (120, 2.438e-8, 9.473),
        (130, 8.484e-9, 12.636), (140, 3.845e-9, 16.149), (150, 2.070e-9, 22.523), (180, 5.464e-10, 29.740),
        (200, 2.789e-10, 37.105), (250, 7.248e-11, 45.546), (300, 2.418e-11, 53.628), (350, 9.518e-12, 53.298),
        (400, 3.725e-12, 58.515), (450, 1.585e-12, 60.828), (500, 6.967e-13, 63.822), (600, 1.454e-13, 71.835),
        (700, 3.614e-14, 88.667), (800, 1.170e-14, 124.64), (900, 5.245e-15, 181.05), (1000, 3.019e-15, 268.00),
    ]
)


def density_exponential(h_km: np.ndarray) -> np.ndarray:
    """Static exponential atmosphere. Above 1000 km the last layer is extrapolated.

    It ignores solar and geomagnetic activity, which change thermospheric density by
    up to ~10x; drag results are therefore indicative, not predictive.
    """
    h = np.asarray(h_km, float)
    idx = np.clip(np.searchsorted(_ATM[:, 0], h, side="right") - 1, 0, len(_ATM) - 1)
    h0, rho0, H = _ATM[idx, 0], _ATM[idx, 1], _ATM[idx, 2]
    rho = rho0 * np.exp(-(h - h0) / H)
    return np.where(h < 0, _ATM[0, 1], rho)


def accel_drag(r: np.ndarray, v: np.ndarray, b_m2_per_kg: np.ndarray) -> np.ndarray:
    """b = Cd*A/m (m^2/kg) per sample. Spherical-Earth altitude (|r| - Re) for density lookup."""
    w = np.array([0.0, 0.0, OMEGA_EARTH])
    v_rel = v - np.cross(w, r)  # km/s
    h = np.linalg.norm(r, axis=1) - R_EARTH
    rho = density_exponential(h)
    speed = np.linalg.norm(v_rel, axis=1, keepdims=True)
    # (kg/m^3)(m^2/kg)(km/s)^2 -> 1e6 m^2/s^2 ... -> m/s^2 * 1e3 ... -> km/s^2 * 1e3
    return -0.5 * (b_m2_per_kg * rho)[:, None] * speed * v_rel * 1e3


# --------------------------------------------------------------- ephemerides
def _t_centuries(jd: float) -> float:
    return (jd - 2451545.0) / 36525.0


def sun_position_km(jd: float) -> np.ndarray:
    """Low-precision Sun vector (km), mean equator and equinox of date. Vallado Alg. 29 (~0.01 deg)."""
    t = _t_centuries(jd)
    lam_m = 280.460 + 36000.771 * t
    m = math.radians(357.5291092 + 35999.05034 * t)
    lam = math.radians(lam_m + 1.914666471 * math.sin(m) + 0.019994643 * math.sin(2 * m))
    r_au = 1.000140612 - 0.016708617 * math.cos(m) - 0.000139589 * math.cos(2 * m)
    eps = math.radians(23.439291 - 0.0130042 * t)
    return r_au * AU_KM * np.array([math.cos(lam), math.cos(eps) * math.sin(lam), math.sin(eps) * math.sin(lam)])


def moon_position_km(jd: float) -> np.ndarray:
    """Low-precision Moon vector (km), Vallado Alg. 31 (~0.3 deg, ~1,300 km)."""
    t = _t_centuries(jd)
    d = math.radians
    lam = (
        218.32 + 481267.8813 * t + 6.29 * math.sin(d(134.9 + 477198.85 * t)) - 1.27 * math.sin(d(259.2 - 413335.38 * t))
        + 0.66 * math.sin(d(235.7 + 890534.23 * t)) + 0.21 * math.sin(d(269.9 + 954397.70 * t))
        - 0.19 * math.sin(d(357.5 + 35999.05 * t)) - 0.11 * math.sin(d(186.6 + 966404.05 * t))
    )
    phi = (
        5.13 * math.sin(d(93.3 + 483202.03 * t)) + 0.28 * math.sin(d(228.2 + 960400.87 * t))
        - 0.28 * math.sin(d(318.3 + 6003.18 * t)) - 0.17 * math.sin(d(217.6 - 407332.20 * t))
    )
    par = (
        0.9508 + 0.0518 * math.cos(d(134.9 + 477198.85 * t)) + 0.0095 * math.cos(d(259.2 - 413335.38 * t))
        + 0.0078 * math.cos(d(235.7 + 890534.23 * t)) + 0.0028 * math.cos(d(269.9 + 954397.70 * t))
    )
    eps = d(23.439291 - 0.0130042 * t)
    lam, phi = d(lam), d(phi)
    rmag = R_EARTH / math.sin(d(par))
    return rmag * np.array(
        [
            math.cos(phi) * math.cos(lam),
            math.cos(eps) * math.cos(phi) * math.sin(lam) - math.sin(eps) * math.sin(phi),
            math.sin(eps) * math.cos(phi) * math.sin(lam) + math.cos(eps) * math.sin(phi),
        ]
    )


def accel_third_body(r: np.ndarray, s: np.ndarray, mu3: float) -> np.ndarray:
    d = s[None, :] - r
    dn = np.linalg.norm(d, axis=1, keepdims=True)
    return mu3 * (d / dn**3 - s / np.linalg.norm(s) ** 3)


def shadow_cylindrical(r: np.ndarray, s: np.ndarray) -> np.ndarray:
    """1 in sunlight, 0 in the Earth's cylindrical shadow."""
    sh = s / np.linalg.norm(s)
    proj = r @ sh
    perp = np.linalg.norm(r - proj[:, None] * sh[None, :], axis=1)
    return np.where((proj < 0) & (perp < R_EARTH), 0.0, 1.0)


def accel_srp(r: np.ndarray, s: np.ndarray, cr_a_over_m: np.ndarray) -> np.ndarray:
    """cr_a_over_m = Cr*A/m (m^2/kg). Pushes away from the Sun, scaled by 1/d^2 (AU)."""
    d = r - s[None, :]
    dn = np.linalg.norm(d, axis=1, keepdims=True)
    nu = shadow_cylindrical(r, s)
    mag = P_SRP_1AU * cr_a_over_m * nu * (AU_KM / dn[:, 0]) ** 2  # m/s^2
    return (mag * 1e-3)[:, None] * d / dn
