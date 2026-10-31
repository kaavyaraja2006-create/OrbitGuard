"""Closest approach for a specific pair near a reference time (used to compare
ORBITGUARD with external conjunction reports such as CelesTrak SOCRATES)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np
from sgp4.api import Satrec

from .conjunction import refine_tca
from .frames import datetime_to_jd


@dataclass
class PairApproach:
    tca: datetime
    miss_km: float
    relative_speed_kms: float


def closest_approach_near(a: Satrec, b: Satrec, t_ref: datetime, half_window_s: float = 300.0, coarse_step_s: float = 1.0) -> PairApproach | None:
    """Coarse 1 s scan over ±window, then Brent refinement (1 ms)."""
    jd0, fr0 = datetime_to_jd(t_ref)
    ts = np.arange(-half_window_s, half_window_s + 1e-9, coarse_step_s)
    jd = np.full(ts.size, jd0)
    fr = fr0 + ts / 86400.0
    e1, r1, v1 = a.sgp4_array(jd, fr)
    e2, r2, v2 = b.sgp4_array(jd, fr)
    ok = (e1 == 0) & (e2 == 0)
    if not ok.any():
        return None
    d = np.linalg.norm(r2 - r1, axis=1)
    d[~ok] = np.inf
    k = int(np.argmin(d))
    ref = refine_tca(a, b, jd0, fr0, ts[max(k - 2, 0)], ts[min(k + 2, ts.size - 1)])
    if ref is None:
        return None
    t, miss = ref
    _, ra, va = a.sgp4(jd0, fr0 + t / 86400.0)
    _, rb, vb = b.sgp4(jd0, fr0 + t / 86400.0)
    return PairApproach(t_ref + timedelta(seconds=t), miss, float(np.linalg.norm(np.subtract(vb, va))))
