"""Collision probability for short-term encounters.

Model (standard short-encounter assumptions, e.g. Foster & Estes 1992,
Chan 2008, Alfano 2005):

* rectilinear relative motion during the encounter,
* position uncertainty Gaussian and constant over the encounter,
* objects represented by a combined hard-body sphere of radius HBR.

Under these assumptions the 3-D problem collapses onto the *encounter plane*
(perpendicular to the relative velocity at TCA):

    Pc = ∬_{x²+y² ≤ HBR²} N(x | m, C₂) dx dy

where m is the projected miss vector and C₂ the projected combined
covariance. The integral is evaluated by Gauss-Legendre quadrature in polar
coordinates (validated against analytic cases and Monte Carlo).

Covariance is NEVER invented here. When none is available, only the
geometric miss distance and a clearly-labelled worst-case bound are reported.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import numpy as np
from scipy.optimize import minimize_scalar

from .frames import rtn_basis

ALGORITHM_VERSION = "pc-2d-gauss-legendre/1.0.0"


def rtn_to_inertial_cov(r, v, cov_rtn) -> np.ndarray:
    """Rotate a 3x3 position covariance from the object's RTN frame to inertial."""
    B = rtn_basis(r, v)  # rows: R, T, N in inertial coordinates
    C = np.asarray(cov_rtn, dtype=float)
    return B.T @ C @ B


def diag_cov(sigma_r_km: float, sigma_t_km: float, sigma_n_km: float) -> np.ndarray:
    return np.diag([sigma_r_km**2, sigma_t_km**2, sigma_n_km**2])


def encounter_plane(r_rel, v_rel) -> tuple[np.ndarray, np.ndarray]:
    """Return (basis 2x3, miss 2-vector). x-axis along the miss vector, z along v_rel."""
    r = np.asarray(r_rel, dtype=float)
    v = np.asarray(v_rel, dtype=float)
    z = v / np.linalg.norm(v)
    r_perp = r - np.dot(r, z) * z
    m = np.linalg.norm(r_perp)
    if m > 1e-12:
        x = r_perp / m
    else:  # head-on through the centre: any perpendicular axis works
        trial = np.array([1.0, 0.0, 0.0]) if abs(z[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        x = trial - np.dot(trial, z) * z
        x /= np.linalg.norm(x)
    y = np.cross(z, x)
    return np.vstack((x, y)), np.array([m, 0.0])


def project_covariance(basis: np.ndarray, cov3: np.ndarray) -> np.ndarray:
    return basis @ np.asarray(cov3, dtype=float) @ basis.T


_GRID_CACHE: dict[tuple[int, int], tuple[np.ndarray, ...]] = {}


def _unit_grid(n_r: int, n_theta: int):
    """Quadrature nodes on the unit disc (cached): rho, cos, sin, weights."""
    key = (n_r, n_theta)
    if key not in _GRID_CACHE:
        xr, wr = np.polynomial.legendre.leggauss(n_r)
        rho = 0.5 * (xr + 1.0)  # [-1,1] -> [0,1]
        th = np.linspace(0.0, 2.0 * math.pi, n_theta, endpoint=False)
        R, TH = np.meshgrid(rho, th, indexing="ij")
        W = (0.5 * wr)[:, None] * (2.0 * math.pi / n_theta) * R  # includes the polar Jacobian
        _GRID_CACHE[key] = (R * np.cos(TH), R * np.sin(TH), W)
    return _GRID_CACHE[key]


def pc_2d(miss2: np.ndarray, cov2: np.ndarray, hbr_km: float, n_r: int = 48, n_theta: int = 96) -> float:
    """Probability that the true relative position lies within the hard-body disc."""
    C = np.asarray(cov2, dtype=float)
    if hbr_km <= 0:
        raise ValueError("Hard-body radius must be positive")
    det = C[0, 0] * C[1, 1] - C[0, 1] * C[1, 0]
    if not (C[0, 0] > 0 and det > 0):  # 2x2 positive-definiteness (Sylvester)
        raise ValueError("Projected covariance must be positive definite")
    inv = np.linalg.inv(C)
    norm = 1.0 / (2.0 * math.pi * math.sqrt(det))
    ux, uy, w = _unit_grid(n_r, n_theta)
    X = hbr_km * ux - miss2[0]
    Y = hbr_km * uy - miss2[1]
    q = inv[0, 0] * X * X + 2.0 * inv[0, 1] * X * Y + inv[1, 1] * Y * Y
    # area element scales with HBR^2 (rho dr dtheta, rho and dr both ∝ HBR)
    return float(norm * hbr_km * hbr_km * np.sum(np.exp(-0.5 * q) * w))


def pc_monte_carlo(miss2, cov2, hbr_km: float, n: int = 2_000_000, seed: int = 0) -> tuple[float, float]:
    """Monte Carlo estimate (value, standard error) for validation."""
    rng = np.random.default_rng(seed)
    s = rng.multivariate_normal(np.asarray(miss2, float), np.asarray(cov2, float), size=n)
    hits = np.count_nonzero(np.einsum("ij,ij->i", s, s) <= hbr_km**2)
    p = hits / n
    return p, math.sqrt(max(p * (1 - p), 1e-300) / n)


def pc_max_isotropic(miss_km: float, hbr_km: float) -> tuple[float, float]:
    """Worst-case Pc over all *isotropic* covariances (sigma), and the maximising sigma.

    Useful when no covariance exists. It is NOT an upper bound for elongated
    covariances, which can give higher values; it is labelled accordingly.
    For HBR << d the maximum tends to HBR² / (e d²) at sigma = d/√2.
    """
    if miss_km <= hbr_km:
        return 1.0, 0.0

    def neg(log_s: float) -> float:
        s = math.exp(log_s)
        return -pc_2d(np.array([miss_km, 0.0]), np.eye(2) * s * s, hbr_km)

    s0 = miss_km / math.sqrt(2.0)
    res = minimize_scalar(neg, bounds=(math.log(s0) - 3, math.log(s0) + 3), method="bounded", options={"xatol": 1e-6})
    return float(-res.fun), float(math.exp(res.x))


@dataclass
class PcAssessment:
    status: str  # "computed" | "covariance-unavailable"
    covariance_source: str  # e.g. "user-assumed (RTN sigmas)" | "CDM" | "none"
    pc: float | None
    miss_distance_km: float
    hbr_km: float
    encounter_plane_miss_km: list[float]
    encounter_plane_cov_km2: list[list[float]] | None
    mahalanobis: float | None
    pc_max_isotropic: float
    pc_max_sigma_km: float
    sensitivity: list[dict]  # Pc vs covariance scale factor
    algorithm_version: str = ALGORITHM_VERSION
    assumptions: tuple[str, ...] = (
        "short-term encounter, rectilinear relative motion",
        "Gaussian position uncertainty, constant over the encounter",
        "spherical combined hard body of radius HBR",
        "primary and secondary errors independent (no cross-covariance)",
    )

    def to_dict(self) -> dict:
        return asdict(self)


SCALE_FACTORS = (0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0)


def assess(
    r_rel,
    v_rel,
    hbr_km: float,
    *,
    cov_primary_inertial: np.ndarray | None = None,
    cov_secondary_inertial: np.ndarray | None = None,
    covariance_source: str = "none",
) -> PcAssessment:
    basis, miss2 = encounter_plane(r_rel, v_rel)
    miss = float(np.linalg.norm(np.asarray(r_rel, float)))
    pmax, smax = pc_max_isotropic(float(miss2[0]), hbr_km)
    if cov_primary_inertial is None or cov_secondary_inertial is None:
        return PcAssessment(
            status="covariance-unavailable",
            covariance_source="none",
            pc=None,
            miss_distance_km=miss,
            hbr_km=hbr_km,
            encounter_plane_miss_km=miss2.tolist(),
            encounter_plane_cov_km2=None,
            mahalanobis=None,
            pc_max_isotropic=pmax,
            pc_max_sigma_km=smax,
            sensitivity=[],
        )
    C3 = np.asarray(cov_primary_inertial, float) + np.asarray(cov_secondary_inertial, float)
    C2 = project_covariance(basis, C3)
    pc = pc_2d(miss2, C2, hbr_km)
    maha = float(math.sqrt(miss2 @ np.linalg.inv(C2) @ miss2))
    sens = [{"scale": k, "pc": pc_2d(miss2, C2 * k * k, hbr_km)} for k in SCALE_FACTORS]
    return PcAssessment(
        status="computed",
        covariance_source=covariance_source,
        pc=pc,
        miss_distance_km=miss,
        hbr_km=hbr_km,
        encounter_plane_miss_km=miss2.tolist(),
        encounter_plane_cov_km2=C2.tolist(),
        mahalanobis=maha,
        pc_max_isotropic=pmax,
        pc_max_sigma_km=smax,
        sensitivity=sens,
    )
