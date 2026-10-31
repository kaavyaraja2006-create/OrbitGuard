"""Proximity detection: which objects are within a radius of a satellite.

Proximity is *geometry only*. It answers "how close", never "how likely to
collide"; collision probability needs covariance and lives in ``collision``.

Current proximity (one instant t)
---------------------------------
All objects are propagated with SGP4 to the same t, so every state is in the
same TEME frame at the same time. For the selected satellite P and object B::

    r_rel = r_B - r_P            (km, TEME)
    d     = |r_rel|              (frame-invariant: rotations preserve length)
    v_rel = v_B - v_P            (km/s)
    range_rate = (r_rel . v_rel) / d     (< 0 closing, > 0 opening)

r_rel is also given in P's RTN frame (radial, along-track, cross-track).
Comparing altitudes is not used anywhere: two objects at the same altitude can
be on opposite sides of the Earth.

Future proximity (window [t0, t0 + H])
--------------------------------------
1. Apogee/perigee shell filter with pad = radius + 50 km.
2. Vectorised SGP4 on a uniform grid (step h). In every interval the relative
   motion is linearised and its closest distance found in closed form
   (same method as conjunction screening), so a fast fly-through between two
   samples is not missed.
3. Consecutive flagged intervals form one *proximity window*. Its minimum is
   refined with bounded Brent minimisation on the true SGP4 distance around the
   best interval, and the entry/exit times of the sphere are found with
   Brent root-finding on f(t) = |r_rel(t)| - R.
"""

from __future__ import annotations

import math
import time as _time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta

import numpy as np
from scipy.optimize import brentq
from sgp4.api import Satrec, SatrecArray

from .conjunction import Candidate, _grid, _state, apogee_perigee_filter, refine_tca, shell_radii
from .frames import rtn_basis

ALGORITHM_VERSION = "proximity/1.0.0"


# ----------------------------------------------------------------- current
@dataclass
class NearbyObject:
    index: int  # row in the input arrays
    distance_km: float
    r_rel_teme_km: list[float]
    r_rel_rtn_km: list[float]
    v_rel_kms: float
    range_rate_kms: float


def current_proximity(r_p, v_p, r_all, v_all, ok, radius_km: float, exclude: int | None = None) -> list[NearbyObject]:
    """Objects within ``radius_km`` of the satellite at one common instant.

    ``r_all``/``v_all`` are (N, 3) TEME states at the same time as ``r_p``/``v_p``;
    ``ok`` marks rows that propagated without SGP4 error. Sorted by distance.
    """
    if radius_km <= 0:
        raise ValueError("radius must be positive")
    r_p = np.asarray(r_p, float)
    v_p = np.asarray(v_p, float)
    dr = np.asarray(r_all, float) - r_p
    d = np.linalg.norm(dr, axis=1)
    mask = np.asarray(ok, bool) & (d <= radius_km)
    if exclude is not None:
        mask[exclude] = False
    idx = np.nonzero(mask)[0]
    if idx.size == 0:
        return []
    basis = rtn_basis(r_p, v_p)
    dv = np.asarray(v_all, float)[idx] - v_p
    out = []
    for k, i in enumerate(idx):
        di = float(d[i])
        out.append(
            NearbyObject(
                index=int(i),
                distance_km=di,
                r_rel_teme_km=dr[i].tolist(),
                r_rel_rtn_km=(basis @ dr[i]).tolist(),
                v_rel_kms=float(np.linalg.norm(dv[k])),
                range_rate_kms=float(dr[i] @ dv[k] / di) if di > 0 else 0.0,
            )
        )
    out.sort(key=lambda o: o.distance_km)
    return out


# ------------------------------------------------------------------ future
@dataclass(frozen=True)
class ProximityConfig:
    horizon_s: float = 24 * 3600.0
    step_s: float = 60.0
    radius_km: float = 10.0
    shell_pad_km: float = 50.0
    chunk_size: int = 256
    refine_tol_s: float = 1e-3

    @property
    def linear_margin_km(self) -> float:
        # slack for the in-interval linearisation (curvature of relative motion)
        return max(5.0, 0.05 * self.radius_km)


@dataclass
class ProximityWindow:
    secondary_id: int
    tca: datetime
    min_distance_km: float
    relative_speed_kms: float
    r_rel_rtn_km: list[float]
    entry: datetime | None  # None if already inside at the window start
    exit: datetime | None  # None if still inside at the horizon end
    inside_at_start: bool
    duration_s: float

    def to_dict(self) -> dict:
        d = asdict(self)
        for k in ("tca", "entry", "exit"):
            d[k] = d[k].isoformat() if d[k] else None
        return d


@dataclass
class ProximityStats:
    candidates_total: int = 0
    candidates_after_shell_filter: int = 0
    grid_samples: int = 0
    intervals_flagged: int = 0
    refinements: int = 0
    windows: int = 0
    secondaries_with_sgp4_errors: int = 0
    primary_sgp4_errors: int = 0
    runtime_s: float = 0.0


@dataclass
class ProximityResult:
    windows: list[ProximityWindow]
    stats: ProximityStats
    config: ProximityConfig
    start: datetime
    algorithm_version: str = ALGORITHM_VERSION
    warnings: list[str] = field(default_factory=list)


def _dist(primary: Satrec, secondary: Satrec, jd0: float, fr0: float, t: float) -> float | None:
    e1, r1, _ = _state(primary, jd0, fr0, t)
    e2, r2, _ = _state(secondary, jd0, fr0, t)
    if e1 or e2:
        return None
    return float(np.linalg.norm(r2 - r1))


def _crossing(primary, secondary, jd0, fr0, radius, t_out, t_in, tol) -> float | None:
    """Time in [t_out, t_in] (either order) where the distance equals ``radius``.

    Requires distance(t_out) > radius >= distance(t_in)."""

    def f(t):
        d = _dist(primary, secondary, jd0, fr0, t)
        return 1e9 if d is None else d - radius

    a, b = (t_out, t_in) if t_out < t_in else (t_in, t_out)
    fa, fb = f(a), f(b)
    if fa * fb > 0:
        return None
    try:
        return float(brentq(f, a, b, xtol=min(tol, 1e-5)))  # 10 µs: ~0.1 m at 10 km/s
    except ValueError:
        return None


def predict_proximity(primary: Satrec, candidates: list[Candidate], start: datetime, cfg: ProximityConfig | None = None, progress=None) -> ProximityResult:
    cfg = cfg or ProximityConfig()
    if start.tzinfo is None:
        raise ValueError("start must be timezone-aware UTC")
    if cfg.horizon_s <= 0 or cfg.step_s <= 0 or cfg.radius_km <= 0:
        raise ValueError("horizon, step and radius must be positive")
    t_wall = _time.perf_counter()
    stats = ProximityStats(candidates_total=len(candidates))
    warnings: list[str] = []
    kept = apogee_perigee_filter(shell_radii(primary), candidates, cfg.shell_pad_km + cfg.radius_km)
    stats.candidates_after_shell_filter = len(kept)

    from .conjunction import ScreeningConfig

    jd0, fr0, t, jd_arr, fr_arr = _grid(start, ScreeningConfig(horizon_s=cfg.horizon_s, step_s=cfg.step_s))
    stats.grid_samples = len(t)
    ep, rp, vp = primary.sgp4_array(jd_arr, fr_arr)
    p_ok = ep == 0
    stats.primary_sgp4_errors = int((~p_ok).sum())
    if not p_ok.any():
        stats.runtime_s = _time.perf_counter() - t_wall
        return ProximityResult([], stats, cfg, start, warnings=["Selected satellite could not be propagated over the horizon (SGP4 error)"])
    if stats.primary_sgp4_errors:
        warnings.append(f"Selected satellite: SGP4 failed at {stats.primary_sgp4_errors} of {len(t)} grid times; those intervals were skipped")

    h = cfg.step_s
    limit = cfg.radius_km + cfg.linear_margin_km
    t_end = float(t[-1])
    windows: list[ProximityWindow] = []

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
        d_samp = np.linalg.norm(dr, axis=2)
        d_int = np.minimum(np.minimum(d_lin, d_samp[:, 1:]), d_samp[:, :-1])
        valid = ok[:, :-1] & ok[:, 1:]
        flagged = valid & (d_int <= limit)
        stats.intervals_flagged += int(flagged.sum())

        for i in np.nonzero(flagged.any(axis=1))[0]:
            sec = chunk[i].satrec
            ks = np.nonzero(flagged[i])[0]
            groups: list[list[int]] = [[int(ks[0])]]
            for k in ks[1:]:
                (groups[-1].append(int(k)) if k == groups[-1][-1] + 1 else groups.append([int(k)]))
            for g in groups:
                best = min(g, key=lambda k: d_int[i, k])
                lo = max(0.0, float(t[best]) - h)
                hi = min(t_end, float(t[best + 1]) + h)
                stats.refinements += 1
                ref = refine_tca(primary, sec, jd0, fr0, lo, hi, cfg.refine_tol_s)
                if ref is None:
                    continue
                tca, dmin = ref
                # Brent may stop on the grid bound; a sample can be closer.
                for k in (best, best + 1):
                    if d_samp[i, k] < dmin:
                        tca, dmin = float(t[k]), float(d_samp[i, k])
                if dmin > cfg.radius_km:
                    continue
                # entry: last time before TCA outside the sphere
                d0 = _dist(primary, sec, jd0, fr0, 0.0)
                inside_at_start = d0 is not None and d0 <= cfg.radius_km and g[0] == 0
                entry_s = None
                if not inside_at_start:
                    t_out = max(0.0, float(t[g[0]]) - h)
                    d_out = _dist(primary, sec, jd0, fr0, t_out)
                    if d_out is not None and d_out > cfg.radius_km:
                        entry_s = _crossing(primary, sec, jd0, fr0, cfg.radius_km, t_out, tca, cfg.refine_tol_s)
                    if entry_s is None:
                        entry_s = float(t[g[0]])  # resolution-limited fallback
                t_out = min(t_end, float(t[g[-1] + 1]) + h)
                d_out = _dist(primary, sec, jd0, fr0, t_out)
                exit_s = None
                if d_out is not None and d_out > cfg.radius_km:
                    exit_s = _crossing(primary, sec, jd0, fr0, cfg.radius_km, t_out, tca, cfg.refine_tol_s)
                    if exit_s is None:
                        exit_s = float(t[g[-1] + 1])
                e1, r1, v1 = _state(primary, jd0, fr0, tca)
                _, r2, v2 = _state(sec, jd0, fr0, tca)
                t_a = 0.0 if inside_at_start else (entry_s if entry_s is not None else 0.0)
                t_b = exit_s if exit_s is not None else t_end
                windows.append(
                    ProximityWindow(
                        secondary_id=chunk[i].object_id,
                        tca=start + timedelta(seconds=tca),
                        min_distance_km=dmin,
                        relative_speed_kms=float(np.linalg.norm(v2 - v1)),
                        r_rel_rtn_km=(rtn_basis(r1, v1) @ (r2 - r1)).tolist(),
                        entry=None if inside_at_start else start + timedelta(seconds=entry_s),
                        exit=None if exit_s is None else start + timedelta(seconds=exit_s),
                        inside_at_start=inside_at_start,
                        duration_s=max(0.0, t_b - t_a),
                    )
                )
        if progress:
            progress(min(1.0, (c0 + len(chunk)) / max(1, len(kept))))

    windows.sort(key=lambda w: w.tca)
    stats.windows = len(windows)
    stats.runtime_s = _time.perf_counter() - t_wall
    return ProximityResult(windows, stats, cfg, start, warnings=warnings)


__all__ = ["current_proximity", "NearbyObject", "ProximityConfig", "ProximityWindow", "ProximityResult", "predict_proximity", "ALGORITHM_VERSION"]
