"""Conjunction screening and time-of-closest-approach (TCA) refinement.

Pipeline for one primary against N secondaries over a horizon:

1. **Apogee/perigee filter** (Hoots et al. 1984). Two orbits whose radial
   shells don't overlap (plus a pad) cannot conjunct and are dropped.
2. **Time-grid screening.** All objects are propagated with vectorised SGP4 on
   a uniform grid. Within every grid interval the *relative* motion is
   linearised, giving the closest distance inside that interval in closed form:
       tau* = clamp(-(dr . dv) / |dv|^2, 0, h),  d_lin = |dr + dv tau*|
   This avoids missing fast encounters that fall between samples (at
   ~15 km/s relative speed an object moves 900 km in a 60 s step).
3. **Refinement.** Flagged intervals are refined with bounded Brent
   minimisation of the true SGP4 distance (tolerance 1 ms).

All positions are TEME; distances and relative speeds are frame-invariant.
"""

from __future__ import annotations

import math
import time as _time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone

import numpy as np
from scipy.optimize import minimize_scalar
from sgp4.api import SatrecArray, Satrec

from .constants import RE_WGS72
from .frames import datetime_to_jd, rtn_basis

ALGORITHM_VERSION = "conjunction-screening/1.0.0"


@dataclass(frozen=True)
class ScreeningConfig:
    horizon_s: float = 86400.0
    step_s: float = 60.0
    threshold_km: float = 10.0  # report events with miss distance <= this
    linear_margin_km: float = 5.0  # extra slack for the linearised interval test
    shell_pad_km: float = 50.0  # apogee/perigee filter pad (covers TLE error + perturbations)
    chunk_size: int = 256
    refine_tol_s: float = 1e-3


@dataclass
class Candidate:
    object_id: int
    satrec: Satrec
    perigee_radius_km: float
    apogee_radius_km: float


@dataclass
class ConjunctionEvent:
    secondary_id: int
    tca: datetime
    miss_distance_km: float
    relative_speed_kms: float
    r_rel_teme_km: list[float]  # secondary - primary at TCA
    v_rel_teme_kms: list[float]
    miss_rtn_km: list[float]  # relative position in primary's RTN frame
    approach_angle_deg: float  # angle between the two velocity vectors
    primary_r_km: list[float]
    primary_v_kms: list[float]
    secondary_r_km: list[float]
    secondary_v_kms: list[float]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["tca"] = self.tca.isoformat()
        return d


@dataclass
class ScreeningStats:
    candidates_total: int = 0
    candidates_after_shell_filter: int = 0
    grid_samples: int = 0
    pair_intervals_evaluated: int = 0
    intervals_flagged: int = 0
    refinements: int = 0
    events: int = 0
    secondaries_with_sgp4_errors: int = 0
    primary_sgp4_errors: int = 0
    runtime_s: float = 0.0


@dataclass
class ScreeningResult:
    events: list[ConjunctionEvent]
    stats: ScreeningStats
    config: ScreeningConfig
    start: datetime
    algorithm_version: str = ALGORITHM_VERSION
    warnings: list[str] = field(default_factory=list)


def shell_radii(sat: Satrec) -> tuple[float, float]:
    """Perigee and apogee radius (km) from SGP4 mean elements."""
    a = sat.a * sat.radiusearthkm
    return a * (1 - sat.ecco), a * (1 + sat.ecco)


def apogee_perigee_filter(primary: tuple[float, float], cands: list[Candidate], pad_km: float) -> list[Candidate]:
    rp, ra = primary
    return [c for c in cands if not (c.perigee_radius_km > ra + pad_km or c.apogee_radius_km < rp - pad_km)]


def _grid(start: datetime, cfg: ScreeningConfig):
    jd0, fr0 = datetime_to_jd(start)
    n = int(math.floor(cfg.horizon_s / cfg.step_s)) + 1
    t = np.arange(n) * cfg.step_s
    return jd0, fr0, t, np.full(n, jd0), fr0 + t / 86400.0


def _state(sat: Satrec, jd0: float, fr0: float, t_s: float):
    e, r, v = sat.sgp4(jd0, fr0 + t_s / 86400.0)
    return e, np.array(r), np.array(v)


def refine_tca(primary: Satrec, secondary: Satrec, jd0: float, fr0: float, t_lo: float, t_hi: float, tol: float = 1e-3):
    """Bounded Brent minimisation of the SGP4 distance. Returns (t, d) or None on SGP4 error."""

    def dist(t: float) -> float:
        e1, r1, _ = _state(primary, jd0, fr0, t)
        e2, r2, _ = _state(secondary, jd0, fr0, t)
        if e1 or e2:
            return 1e12
        return float(np.linalg.norm(r2 - r1))

    res = minimize_scalar(dist, bounds=(t_lo, t_hi), method="bounded", options={"xatol": tol})
    if res.fun >= 1e11:
        return None
    return float(res.x), float(res.fun)


def _event(primary: Satrec, secondary: Satrec, sid: int, jd0: float, fr0: float, start: datetime, t: float) -> ConjunctionEvent:
    _, r1, v1 = _state(primary, jd0, fr0, t)
    _, r2, v2 = _state(secondary, jd0, fr0, t)
    dr, dv = r2 - r1, v2 - v1
    basis = rtn_basis(r1, v1)
    cosang = float(np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2)))
    return ConjunctionEvent(
        secondary_id=sid,
        tca=start + timedelta(seconds=t),
        miss_distance_km=float(np.linalg.norm(dr)),
        relative_speed_kms=float(np.linalg.norm(dv)),
        r_rel_teme_km=dr.tolist(),
        v_rel_teme_kms=dv.tolist(),
        miss_rtn_km=(basis @ dr).tolist(),
        approach_angle_deg=math.degrees(math.acos(max(-1.0, min(1.0, cosang)))),
        primary_r_km=r1.tolist(),
        primary_v_kms=v1.tolist(),
        secondary_r_km=r2.tolist(),
        secondary_v_kms=v2.tolist(),
    )


def screen(primary: Satrec, candidates: list[Candidate], start: datetime, cfg: ScreeningConfig | None = None, progress=None) -> ScreeningResult:
    """Screen one primary against candidates. ``progress(fraction)`` is called per chunk."""
    cfg = cfg or ScreeningConfig()
    if start.tzinfo is None:
        raise ValueError("start must be timezone-aware UTC")
    if cfg.step_s <= 0 or cfg.horizon_s <= 0 or cfg.threshold_km <= 0:
        raise ValueError("horizon, step and threshold must be positive")
    t_start = _time.perf_counter()
    stats = ScreeningStats(candidates_total=len(candidates))
    warnings: list[str] = []

    kept = apogee_perigee_filter(shell_radii(primary), candidates, cfg.shell_pad_km + cfg.threshold_km)
    stats.candidates_after_shell_filter = len(kept)

    jd0, fr0, t, jd_arr, fr_arr = _grid(start, cfg)
    stats.grid_samples = len(t)
    ep, rp, vp = primary.sgp4_array(jd_arr, fr_arr)
    p_ok = ep == 0
    stats.primary_sgp4_errors = int((~p_ok).sum())
    if not p_ok.any():
        stats.runtime_s = _time.perf_counter() - t_start
        return ScreeningResult([], stats, cfg, start, warnings=["Primary could not be propagated over the horizon (SGP4 error)"])
    if stats.primary_sgp4_errors:
        warnings.append(f"Primary SGP4 failed at {stats.primary_sgp4_errors} of {len(t)} grid times; those intervals were skipped")

    h = cfg.step_s
    limit = cfg.threshold_km + cfg.linear_margin_km
    events: list[ConjunctionEvent] = []

    for c0 in range(0, len(kept), cfg.chunk_size):
        chunk = kept[c0 : c0 + cfg.chunk_size]
        es, rs, vs = SatrecArray([c.satrec for c in chunk]).sgp4(jd_arr, fr_arr)
        ok = (es == 0) & p_ok[None, :]
        stats.secondaries_with_sgp4_errors += int(((es != 0).any(axis=1)).sum())

        dr = rs - rp[None]
        dv = vs - vp[None]
        dr0, dv0 = dr[:, :-1], dv[:, :-1]
        dvv = np.einsum("ijk,ijk->ij", dv0, dv0)
        tau = np.where(dvv > 0, -np.einsum("ijk,ijk->ij", dr0, dv0) / np.where(dvv > 0, dvv, 1.0), 0.0)
        tau = np.clip(tau, 0.0, h)
        d_lin = np.linalg.norm(dr0 + dv0 * tau[..., None], axis=2)
        # endpoints too (the true minimum can sit exactly on a sample)
        d_end = np.linalg.norm(dr[:, 1:], axis=2)
        d_int = np.minimum(d_lin, d_end)
        valid = ok[:, :-1] & ok[:, 1:]
        stats.pair_intervals_evaluated += int(valid.sum())
        flagged = valid & (d_int <= limit)
        stats.intervals_flagged += int(flagged.sum())

        for i in np.nonzero(flagged.any(axis=1))[0]:
            ks = np.nonzero(flagged[i])[0]
            # group consecutive flagged intervals into one window per encounter
            groups: list[list[int]] = [[int(ks[0])]]
            for k in ks[1:]:
                (groups[-1].append(int(k)) if k == groups[-1][-1] + 1 else groups.append([int(k)]))
            for g in groups:
                lo = max(0.0, t[g[0]] - h)
                hi = min(t[-1], t[g[-1] + 1] + h)
                stats.refinements += 1
                ref = refine_tca(primary, chunk[i].satrec, jd0, fr0, lo, hi, cfg.refine_tol_s)
                if ref is None:
                    continue
                tca, dmin = ref
                if dmin <= cfg.threshold_km:
                    ev = _event(primary, chunk[i].satrec, chunk[i].object_id, jd0, fr0, start, tca)
                    if not any(e.secondary_id == ev.secondary_id and abs((e.tca - ev.tca).total_seconds()) < 1.0 for e in events):
                        events.append(ev)
        if progress:
            progress(min(1.0, (c0 + len(chunk)) / max(1, len(kept))))

    events.sort(key=lambda e: e.tca)
    stats.events = len(events)
    stats.runtime_s = _time.perf_counter() - t_start
    return ScreeningResult(events, stats, cfg, start, warnings=warnings)


def relative_trajectory(primary: Satrec, secondary: Satrec, tca: datetime, half_window_s: float = 120.0, step_s: float = 2.0):
    """Secondary's position relative to the primary, in the primary's RTN frame, around TCA.

    Returns dict with times (s from TCA) and R/T/N arrays in km.
    """
    jd0, fr0 = datetime_to_jd(tca)
    ts = np.arange(-half_window_s, half_window_s + 1e-9, step_s)
    out = {"t_s": [], "R_km": [], "T_km": [], "N_km": []}
    for t in ts:
        e1, r1, v1 = _state(primary, jd0, fr0, float(t))
        e2, r2, _ = _state(secondary, jd0, fr0, float(t))
        if e1 or e2:
            continue
        rel = rtn_basis(r1, v1) @ (r2 - r1)
        out["t_s"].append(float(t))
        out["R_km"].append(float(rel[0]))
        out["T_km"].append(float(rel[1]))
        out["N_km"].append(float(rel[2]))
    return out


def satrec_from_elements(epoch: datetime, a_km: float, e: float, i_deg: float, raan_deg: float, argp_deg: float, m_deg: float, bstar: float = 0.0, satnum: int = 99999) -> Satrec:
    """Build an SGP4 satellite from mean elements (used for controlled test scenarios)."""
    from sgp4.api import WGS72

    sat = Satrec()
    epoch_days = (epoch - datetime(1949, 12, 31, tzinfo=timezone.utc)).total_seconds() / 86400.0
    mu = 398600.8
    n_rad_min = math.sqrt(mu / a_km**3) * 60.0
    sat.sgp4init(
        WGS72, "i", satnum, epoch_days, bstar, 0.0, 0.0, e, math.radians(argp_deg), math.radians(i_deg), math.radians(m_deg % 360.0), n_rad_min, math.radians(raan_deg)
    )
    return sat


__all__ = [
    "ScreeningConfig",
    "Candidate",
    "ConjunctionEvent",
    "ScreeningResult",
    "screen",
    "refine_tca",
    "relative_trajectory",
    "shell_radii",
    "apogee_perigee_filter",
    "satrec_from_elements",
    "RE_WGS72",
]
