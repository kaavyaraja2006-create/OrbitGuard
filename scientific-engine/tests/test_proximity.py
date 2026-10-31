"""Proximity detection: current (common-instant 3D separation) and future windows."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from orbitguard_engine.conjunction import Candidate, satrec_from_elements, shell_radii
from orbitguard_engine.frames import datetime_to_jd
from orbitguard_engine.proximity import ProximityConfig, current_proximity, predict_proximity

EPOCH = datetime(2026, 10, 1, tzinfo=timezone.utc)
A = 7000.0
N_DEG_S = math.degrees(math.sqrt(398600.8 / A**3))
DT = 1234.5


def _cand(i, sat):
    rp, ra = shell_radii(sat)
    return Candidate(i, sat, rp, ra)


def _state(sat, when):
    jd, fr = datetime_to_jd(when)
    e, r, v = sat.sgp4(jd, fr)
    assert e == 0
    return np.array(r), np.array(v)


# ------------------------------------------------------------------ current
def test_current_proximity_uses_3d_distance_not_altitude():
    r_p, v_p = np.array([7000.0, 0, 0]), np.array([0, 7.5, 0])
    r_all = np.array(
        [
            [7000.0, 0, 0],  # the satellite itself
            [7003.0, 4.0, 0],  # 5 km away
            [-7000.0, 0, 0],  # same altitude, other side of the Earth: 14000 km
            [7000.0, 0, 60.0],  # 60 km cross-track
            [7001.0, 0, 0],  # 1 km but failed propagation
        ]
    )
    v_all = np.array([[0, 7.5, 0], [0, 7.4, 0.1], [0, -7.5, 0], [0, 7.5, 0], [0, 7.5, 0]])
    ok = np.array([True, True, True, True, False])
    near = current_proximity(r_p, v_p, r_all, v_all, ok, 100.0, exclude=0)
    assert [n.index for n in near] == [1, 3]  # sorted, self and failed row excluded, far side excluded
    assert near[0].distance_km == pytest.approx(5.0)
    assert np.linalg.norm(near[0].r_rel_rtn_km) == pytest.approx(5.0)  # RTN is a rotation
    assert near[1].r_rel_rtn_km[2] == pytest.approx(60.0)  # cross-track is N
    assert current_proximity(r_p, v_p, r_all, v_all, ok, 4.9, exclude=0) == []


def test_range_rate_sign():
    r_p, v_p = np.zeros(3) + [7000, 0, 0], np.array([0, 7.5, 0])
    closing = current_proximity(r_p, v_p, [[7010, 0, 0]], [[-0.1, 7.5, 0]], [True], 20)[0]
    opening = current_proximity(r_p, v_p, [[7010, 0, 0]], [[0.1, 7.5, 0]], [True], 20)[0]
    assert closing.range_rate_kms < 0 < opening.range_rate_kms
    with pytest.raises(ValueError):
        current_proximity(r_p, v_p, [[7010, 0, 0]], [[0, 7.5, 0]], [True], 0)


def test_current_proximity_on_sgp4_states_matches_chord_length():
    # same orbit, 0.05 deg apart in mean anomaly -> chord ~ 2 a sin(0.025 deg) ~ 6.1 km
    p = satrec_from_elements(EPOCH, A, 1e-4, 51.6, 10.0, 0.0, 0.0)
    b = satrec_from_elements(EPOCH, A, 1e-4, 51.6, 10.0, 0.0, 0.05)
    when = EPOCH + timedelta(minutes=10)
    rp, vp = _state(p, when)
    rb, vb = _state(b, when)
    near = current_proximity(rp, vp, [rb], [vb], [True], 10.0)
    assert len(near) == 1
    assert near[0].distance_km == pytest.approx(2 * A * math.sin(math.radians(0.025)), rel=0.02)
    assert abs(near[0].r_rel_rtn_km[1]) > 0.99 * near[0].distance_km  # it is along-track
    assert current_proximity(rp, vp, [rb], [vb], [True], 5.0) == []


# ------------------------------------------------------------------- future
def _crossing():
    m0 = -N_DEG_S * DT
    return satrec_from_elements(EPOCH, A, 1e-4, 51.6, 0.0, 0.0, m0), satrec_from_elements(EPOCH, A, 1e-4, 97.5, 0.0, 0.0, m0)


def test_future_window_tca_and_sphere_crossings():
    p, s = _crossing()
    R = 25.0
    res = predict_proximity(p, [_cand(7, s)], EPOCH, ProximityConfig(horizon_s=3600, step_s=60, radius_km=R))
    assert res.stats.windows >= 1
    w = res.windows[0]
    assert w.secondary_id == 7 and not w.inside_at_start
    assert abs((w.tca - EPOCH).total_seconds() - DT) < 5.0
    assert w.entry < w.tca < w.exit
    # the sphere boundary really is at R at entry and exit (independent SGP4 evaluation)
    for t in (w.entry, w.exit):
        r1, _ = _state(p, t)
        r2, _ = _state(s, t)
        assert np.linalg.norm(r2 - r1) == pytest.approx(R, abs=1e-3)
    # straight-line fly-through: chord time = 2 sqrt(R^2 - d^2) / v_rel
    expect = 2 * math.sqrt(R**2 - w.min_distance_km**2) / w.relative_speed_kms
    assert w.duration_s == pytest.approx(expect, rel=0.02)


def test_future_window_min_distance_matches_brute_force():
    p, s = _crossing()
    res = predict_proximity(p, [_cand(1, s)], EPOCH, ProximityConfig(horizon_s=3600, step_s=120, radius_km=50))
    w = res.windows[0]
    ts = np.arange(DT - 60, DT + 60, 0.01)
    jd0, fr0 = datetime_to_jd(EPOCH)
    _, r1, _ = p.sgp4_array(np.full(ts.size, jd0), fr0 + ts / 86400)
    _, r2, _ = s.sgp4_array(np.full(ts.size, jd0), fr0 + ts / 86400)
    brute = np.linalg.norm(np.array(r2) - np.array(r1), axis=1).min()
    assert w.min_distance_km == pytest.approx(brute, abs=0.01)


def test_object_inside_sphere_whole_horizon():
    p = satrec_from_elements(EPOCH, A, 1e-4, 51.6, 10.0, 0.0, 0.0)
    b = satrec_from_elements(EPOCH, A, 1e-4, 51.6, 10.0, 0.0, 0.03)  # ~3.7 km behind, same orbit
    res = predict_proximity(p, [_cand(2, b)], EPOCH, ProximityConfig(horizon_s=3 * 3600, step_s=60, radius_km=10))
    assert len(res.windows) == 1
    w = res.windows[0]
    assert w.inside_at_start and w.entry is None and w.exit is None
    assert w.duration_s == pytest.approx(3 * 3600, abs=1)


def test_far_object_removed_by_shell_filter():
    p = satrec_from_elements(EPOCH, A, 1e-4, 51.6, 0.0, 0.0, 0.0)
    geo = satrec_from_elements(EPOCH, 42164.0, 1e-4, 0.1, 0.0, 0.0, 0.0)
    res = predict_proximity(p, [_cand(3, geo)], EPOCH, ProximityConfig(horizon_s=3600, radius_km=100))
    assert res.stats.candidates_after_shell_filter == 0 and res.windows == []
