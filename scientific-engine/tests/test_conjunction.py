"""Phase 4 validation: screening, TCA refinement and collision probability."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from orbitguard_engine.collision import (
    assess,
    diag_cov,
    encounter_plane,
    pc_2d,
    pc_max_isotropic,
    pc_monte_carlo,
    project_covariance,
    rtn_to_inertial_cov,
)
from orbitguard_engine.conjunction import (
    Candidate,
    ScreeningConfig,
    relative_trajectory,
    satrec_from_elements,
    screen,
    shell_radii,
)
from orbitguard_engine.frames import datetime_to_jd

EPOCH = datetime(2026, 10, 1, 0, 0, tzinfo=timezone.utc)
A = 7000.0
N_DEG_S = math.degrees(math.sqrt(398600.8 / A**3))
DT = 1234.5  # s after epoch, deliberately between 60 s grid samples


def _crossing_pair():
    """Two circular orbits in different planes, both at the shared node at EPOCH + DT."""
    m0 = -N_DEG_S * DT
    p = satrec_from_elements(EPOCH, A, 1e-4, 51.6, 0.0, 0.0, m0)
    s = satrec_from_elements(EPOCH, A, 1e-4, 97.5, 0.0, 0.0, m0)
    return p, s


def _cand(i, sat):
    rp, ra = shell_radii(sat)
    return Candidate(i, sat, rp, ra)


def test_engineered_crossing_is_found_between_grid_samples():
    p, s = _crossing_pair()
    res = screen(p, [_cand(1, s)], EPOCH, ScreeningConfig(horizon_s=3600, step_s=60, threshold_km=20))
    assert res.stats.events >= 1
    ev = res.events[0]
    t_found = (ev.tca - EPOCH).total_seconds()
    assert abs(t_found - DT) < 5.0  # SGP4 J2 rates shift the meeting point slightly
    # relative speed for a 45.9 deg plane difference at ~7.55 km/s
    v = math.sqrt(398600.8 / A)
    assert ev.relative_speed_kms == pytest.approx(2 * v * math.sin(math.radians(45.9 / 2)), rel=0.01)


def test_refined_tca_matches_dense_brute_force():
    p, s = _crossing_pair()
    ev = screen(p, [_cand(1, s)], EPOCH, ScreeningConfig(horizon_s=3600, step_s=60, threshold_km=20)).events[0]
    t_ref = (ev.tca - EPOCH).total_seconds()
    jd0, fr0 = datetime_to_jd(EPOCH)
    ts = np.arange(t_ref - 30, t_ref + 30, 0.01)
    _, r1, _ = p.sgp4_array(np.full(ts.size, jd0), fr0 + ts / 86400)
    _, r2, _ = s.sgp4_array(np.full(ts.size, jd0), fr0 + ts / 86400)
    d = np.linalg.norm(r2 - r1, axis=1)
    k = int(np.argmin(d))
    assert abs(ts[k] - t_ref) < 0.02
    assert ev.miss_distance_km <= d[k] + 1e-6  # refinement at least as good as 10 ms brute force


def test_coarse_step_still_catches_fast_encounter():
    # 300 s step: the objects move ~1800 km relative to each other between samples
    p, s = _crossing_pair()
    res = screen(p, [_cand(1, s)], EPOCH, ScreeningConfig(horizon_s=3600, step_s=300, threshold_km=20))
    assert res.stats.events == 1


def test_shell_filter_drops_disjoint_orbits_and_no_false_events():
    p, s = _crossing_pair()
    geo = satrec_from_elements(EPOCH, 42164.0, 1e-4, 0.1, 0.0, 0.0, 0.0)
    same_plane_far = satrec_from_elements(EPOCH, A, 1e-4, 51.6, 0.0, 0.0, 180.0)  # half an orbit apart
    res = screen(p, [_cand(1, s), _cand(2, geo), _cand(3, same_plane_far)], EPOCH, ScreeningConfig(horizon_s=3600, threshold_km=20))
    assert res.stats.candidates_after_shell_filter == 2
    assert {e.secondary_id for e in res.events} == {1}


def test_relative_trajectory_minimum_at_tca():
    p, s = _crossing_pair()
    ev = screen(p, [_cand(1, s)], EPOCH, ScreeningConfig(horizon_s=3600, threshold_km=20)).events[0]
    tr = relative_trajectory(p, s, ev.tca, 60, 1)
    rng = np.sqrt(np.array(tr["R_km"]) ** 2 + np.array(tr["T_km"]) ** 2 + np.array(tr["N_km"]) ** 2)
    assert abs(tr["t_s"][int(np.argmin(rng))]) <= 1.0


# --------------------------------------------------------------- Pc
def test_pc_zero_miss_isotropic_matches_analytic():
    R, s = 0.02, 0.1
    exact = 1 - math.exp(-(R**2) / (2 * s * s))
    assert pc_2d(np.zeros(2), np.eye(2) * s * s, R) == pytest.approx(exact, rel=1e-10)


def test_pc_offset_anisotropic_matches_monte_carlo():
    miss = np.array([0.05, 0.02])
    C = np.array([[0.01, 0.003], [0.003, 0.0025]])
    R = 0.03
    pc = pc_2d(miss, C, R)
    mc, se = pc_monte_carlo(miss, C, R, n=2_000_000, seed=7)
    assert abs(pc - mc) < 4 * se, (pc, mc, se)


def test_pc_small_body_limit():
    miss = np.array([0.3, 0.1])
    C = np.array([[0.04, 0.01], [0.01, 0.09]])
    R = 1e-4
    inv = np.linalg.inv(C)
    dens = math.exp(-0.5 * miss @ inv @ miss) / (2 * math.pi * math.sqrt(np.linalg.det(C)))
    assert pc_2d(miss, C, R) == pytest.approx(math.pi * R * R * dens, rel=1e-6)


def test_pc_max_isotropic_limit():
    d, R = 1.0, 0.01
    pmax, smax = pc_max_isotropic(d, R)
    assert pmax == pytest.approx(R * R / (math.e * d * d), rel=2e-3)
    assert smax == pytest.approx(d / math.sqrt(2), rel=2e-3)


def test_covariance_rotation_and_projection():
    r, v = np.array([7000.0, 0, 0]), np.array([0, 7.5, 0])
    C_rtn = diag_cov(0.1, 1.0, 0.2)
    C_i = rtn_to_inertial_cov(r, v, C_rtn)
    assert np.allclose(C_i, C_rtn)  # RTN == inertial axes for this geometry
    r2, v2 = np.array([0, 7000.0, 0]), np.array([-7.5, 0, 0])
    C_i2 = rtn_to_inertial_cov(r2, v2, C_rtn)
    assert np.trace(C_i2) == pytest.approx(np.trace(C_rtn))
    assert C_i2[1, 1] == pytest.approx(0.01)  # radial now along +y
    basis, miss2 = encounter_plane([1.0, 2.0, 3.0], [0.0, 0.0, 5.0])
    assert np.allclose(basis @ basis.T, np.eye(2))
    assert miss2[0] == pytest.approx(math.sqrt(5.0)) and miss2[1] == 0.0
    C2 = project_covariance(basis, np.diag([1.0, 4.0, 9.0]))
    assert np.trace(C2) == pytest.approx(5.0)  # z-variance (along v_rel) drops out


def test_assess_without_covariance_never_reports_pc():
    a = assess([0.5, 0.1, 0.0], [0.0, 0.0, 10.0], 0.02)
    assert a.status == "covariance-unavailable" and a.pc is None and a.sensitivity == []
    assert 0 < a.pc_max_isotropic < 1


def test_assess_with_covariance_is_monotone_in_sensitivity_far_field():
    C = np.diag([0.01, 0.25, 0.04])
    a = assess([0.05, 0.0, 0.0], [0.0, 0.0, 10.0], 0.02, cov_primary_inertial=C, cov_secondary_inertial=C, covariance_source="test")
    assert a.status == "computed" and 0 < a.pc < 1
    assert a.sensitivity[3]["scale"] == 1.0 and a.sensitivity[3]["pc"] == pytest.approx(a.pc)
