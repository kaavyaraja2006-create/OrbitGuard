"""Reconstruct encounter geometry and covariance from ESA Kelvins CDM rows.

Dataset: Uriot, Izzo et al., "Collision Avoidance Challenge dataset", ESA,
Zenodo 10.5281/zenodo.4463683 (CC BY 4.0).

Units in the dataset (confirmed against the files): distances and sigmas in
metres, velocities in m/s, correlations dimensionless, ``risk`` = log10(Pc).
This module converts everything to km and km/s.

Frames. Relative position/velocity are given in the TARGET's RTN frame.
Each object's covariance is given in its OWN RTN frame, so the chaser's
covariance must be rotated into the target frame before the two are summed.
(Skipping that rotation gives a Mahalanobis distance ~9x wrong on the sample
rows; with it, ours matches ESA's ``mahalanobis_distance`` to < 0.4 %.)

The chaser's RTN axes are rebuilt from the data available in the CDM:
  * radial: same as the target's (positions differ by the miss distance only),
  * velocity: v_chaser = v_target + v_rel, with v_target ≈ (0, sqrt(mu/a_t), 0)
    in target RTN (near-circular approximation; t_j2k_ecc is ~0.004 in the
    sample, i.e. a radial-velocity error of about 0.2 deg in the frame).

The hard-body radius used by ESA is not in the dataset. It is inferred per
CDM from ESA's own risk value; a stable value within a mission is evidence
that this Pc model and ESA's agree.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Mapping

import numpy as np
from scipy.optimize import brentq

from .collision import encounter_plane, pc_2d, project_covariance

MU_EARTH = 398600.4418
RISK_FLOOR = -30.0  # the dataset floors negligible risk at -30


@dataclass
class CdmGeometry:
    r_rel_km: np.ndarray  # target RTN
    v_rel_kms: np.ndarray
    cov_target_km2: np.ndarray  # 3x3, target RTN
    cov_chaser_km2: np.ndarray  # 3x3, rotated into target RTN
    miss2_km: np.ndarray  # encounter-plane miss vector
    cov2_km2: np.ndarray  # encounter-plane combined covariance
    mahalanobis_3d: float


def _f(row: Mapping, key: str) -> float:
    v = row.get(key)
    if v is None:
        return math.nan
    try:
        return float(v)
    except (TypeError, ValueError):
        return math.nan


def _cov(sr: float, st: float, sn: float, ctr: float, cnr: float, cnt: float) -> np.ndarray:
    s = np.array([sr, st, sn])
    corr = np.array([[1.0, ctr, cnr], [ctr, 1.0, cnt], [cnr, cnt, 1.0]])
    return corr * np.outer(s, s)


def chaser_rtn_basis_in_target(v_rel_kms: np.ndarray, target_sma_km: float) -> np.ndarray:
    """Rows: chaser R, T, N expressed in target-RTN coordinates."""
    v_t = math.sqrt(MU_EARTH / target_sma_km)
    v_c = np.array([0.0, v_t, 0.0]) + v_rel_kms
    R = np.array([1.0, 0.0, 0.0])
    N = np.cross(R, v_c)
    N /= np.linalg.norm(N)
    T = np.cross(N, R)
    return np.vstack((R, T, N))


def geometry_from_row(row: Mapping) -> tuple[CdmGeometry | None, str | None]:
    """Build the encounter from one CDM row. Returns (geometry, None) or (None, reason)."""
    r = np.array([_f(row, f"relative_position_{a}") for a in "rtn"]) / 1000.0
    v = np.array([_f(row, f"relative_velocity_{a}") for a in "rtn"]) / 1000.0
    sma = _f(row, "t_j2k_sma")
    vals = {}
    for p in ("t", "c"):
        for k in ("sigma_r", "sigma_t", "sigma_n", "ct_r", "cn_r", "cn_t"):
            vals[f"{p}_{k}"] = _f(row, f"{p}_{k}")
    arr = np.concatenate([r, v, [sma], list(vals.values())])
    if not np.all(np.isfinite(arr)):
        return None, "missing value"
    if np.linalg.norm(v) <= 0:
        return None, "zero relative velocity"
    for p in ("t", "c"):
        if min(vals[f"{p}_sigma_r"], vals[f"{p}_sigma_t"], vals[f"{p}_sigma_n"]) <= 0:
            return None, "non-positive sigma"
        if max(abs(vals[f"{p}_ct_r"]), abs(vals[f"{p}_cn_r"]), abs(vals[f"{p}_cn_t"])) > 1:
            return None, "correlation outside [-1, 1]"
    Ct = _cov(*(vals[f"t_{k}"] for k in ("sigma_r", "sigma_t", "sigma_n", "ct_r", "cn_r", "cn_t"))) / 1e6
    Cc_own = _cov(*(vals[f"c_{k}"] for k in ("sigma_r", "sigma_t", "sigma_n", "ct_r", "cn_r", "cn_t"))) / 1e6
    B = chaser_rtn_basis_in_target(v, sma)
    Cc = B.T @ Cc_own @ B
    C = Ct + Cc
    try:
        if np.min(np.linalg.eigvalsh(C)) <= 0:
            return None, "combined covariance not positive definite"
        maha = float(math.sqrt(r @ np.linalg.solve(C, r)))
    except np.linalg.LinAlgError:
        return None, "singular covariance"
    basis, m2 = encounter_plane(r, v)
    C2 = project_covariance(basis, C)
    if np.min(np.linalg.eigvalsh(C2)) <= 0:
        return None, "projected covariance not positive definite"
    return CdmGeometry(r, v, Ct, Cc, m2, C2, maha), None


def pc(g: CdmGeometry, hbr_km: float) -> float:
    return pc_2d(g.miss2_km, g.cov2_km2, hbr_km)


def infer_hbr_km(g: CdmGeometry, log10_pc: float, h_ref_km: float = 1e-3) -> float | None:
    """Hard-body radius that reproduces a given Pc under this model (None if impossible)."""
    if not math.isfinite(log10_pc) or log10_pc <= RISK_FLOOR:
        return None
    target = 10.0**log10_pc
    p_ref = pc(g, h_ref_km)
    if p_ref <= 0:
        return None
    # Pc ∝ HBR² for HBR << sigma, so the fixed point h <- h * sqrt(target / Pc(h))
    # converges in a few evaluations; brentq is the fallback for large bodies.
    h = h_ref_km * math.sqrt(target / p_ref)
    for _ in range(12):
        p = pc(g, h)
        if p <= 0:
            break
        ratio = target / p
        h_new = h * math.sqrt(ratio)
        if abs(h_new - h) <= 1e-7 * h:
            return h_new
        h = h_new
    f = lambda x: math.log10(max(pc(g, x), 1e-300)) - log10_pc  # noqa: E731
    hi = max(h * 4, 1e-3)
    for _ in range(40):
        if f(hi) > 0:
            break
        hi *= 2
    else:
        return None
    try:
        return float(brentq(f, 1e-9, hi, xtol=1e-9))
    except ValueError:
        return None


# ---------------------------------------------------------------- SOCRATES
def parse_socrates_name(name: str) -> tuple[str, str | None]:
    """'STARLINK-6366 [+]' -> ('STARLINK-6366', '+')."""
    name = (name or "").strip()
    if name.endswith("]") and "[" in name:
        i = name.rfind("[")
        return name[:i].strip(), name[i + 1 : -1].strip() or None
    return name, None
