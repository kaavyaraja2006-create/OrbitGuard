"""Phase 4 validation numbers and a screening benchmark (synthetic catalog, labelled).

Run: python examples/phase4_validation.py
"""

from __future__ import annotations

import math
import time
from datetime import datetime, timezone

import numpy as np

from orbitguard_engine.collision import pc_2d, pc_max_isotropic, pc_monte_carlo
from orbitguard_engine.conjunction import Candidate, ScreeningConfig, satrec_from_elements, screen, shell_radii

print("== Pc integral vs analytic (zero miss, isotropic) ==")
for R, s in [(0.02, 0.1), (0.01, 0.5), (0.05, 0.05)]:
    exact = 1 - math.exp(-R * R / (2 * s * s))
    num = pc_2d(np.zeros(2), np.eye(2) * s * s, R)
    print(f"R={R} km sigma={s} km  exact={exact:.12e}  quadrature={num:.12e}  rel.err={abs(num - exact) / exact:.1e}")

print("\n== Pc integral vs Monte Carlo (offset, correlated covariance) ==")
cases = [
    (np.array([0.05, 0.02]), np.array([[0.01, 0.003], [0.003, 0.0025]]), 0.03),
    (np.array([0.5, -0.2]), np.array([[0.09, -0.02], [-0.02, 0.36]]), 0.02),
]
for miss, C, R in cases:
    pc = pc_2d(miss, C, R)
    mc, se = pc_monte_carlo(miss, C, R, n=4_000_000, seed=1)
    print(f"miss={miss.tolist()} R={R}: quadrature={pc:.6e}  MC={mc:.6e} +/- {se:.1e}  |diff|/SE={abs(pc - mc) / se:.2f}")

print("\n== Worst-case Pc over isotropic covariance vs small-body limit R^2/(e d^2) ==")
for d, R in [(1.0, 0.01), (0.2, 0.02), (5.0, 0.02)]:
    pmax, smax = pc_max_isotropic(d, R)
    print(f"d={d} km R={R} km: Pc_max={pmax:.6e} at sigma={smax:.4f} km;  limit={R * R / (math.e * d * d):.6e}, d/sqrt2={d / math.sqrt(2):.4f}")

print("\n== Screening benchmark (SYNTHETIC catalog of random LEO objects) ==")
epoch = datetime(2026, 10, 30, tzinfo=timezone.utc)
rng = np.random.default_rng(0)
prim = satrec_from_elements(epoch, 6378.135 + 550, 1e-4, 53.0, 10, 0, 0, satnum=1)
for n in (1000, 5000, 10000):
    cands = []
    for k in range(n):
        s = satrec_from_elements(epoch, 6378.135 + rng.uniform(300, 2000), rng.uniform(1e-4, 0.02), rng.uniform(0, 100), rng.uniform(0, 360), rng.uniform(0, 360), rng.uniform(0, 360), satnum=10 + k)
        rp, ra = shell_radii(s)
        cands.append(Candidate(10 + k, s, rp, ra))
    t0 = time.perf_counter()
    res = screen(prim, cands, epoch, ScreeningConfig(horizon_s=86400, step_s=60, threshold_km=10))
    st = res.stats
    print(f"N={n:>6}: after shell filter {st.candidates_after_shell_filter:>5}, pair-intervals {st.pair_intervals_evaluated:>11,}, "
          f"refinements {st.refinements:>3}, events {st.events:>3}, runtime {st.runtime_s:.2f} s")
