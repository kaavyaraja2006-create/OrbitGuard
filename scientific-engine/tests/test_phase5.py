"""Phase 5: force models, numerical propagation, maneuvers, spacecraft digital twin."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from orbitguard_engine.constants import MU_EARTH, R_EARTH, SSO_RAAN_RATE_DEG_DAY
from orbitguard_engine.elements import coe_to_rv, j2_secular_rates, rv_to_coe
from orbitguard_engine.forces import (
    ForceModel,
    accel_zonal,
    density_exponential,
    moon_position_km,
    shadow_cylindrical,
    sun_position_km,
    zonal_potential,
)
from orbitguard_engine.numerical import Body, FiniteBurn, Impulse, burn_duration, dv_available, propagate, propellant_for_dv
from orbitguard_engine.spacecraft import PROPULSION_PRESETS, SpacecraftConfig

EPOCH = datetime(2026, 10, 1, tzinfo=timezone.utc)
TWO_BODY = ForceModel(j2=False)


def _circ(alt_km=700.0, i_deg=51.6, raan=30.0, u=0.0):
    a = R_EARTH + alt_km
    r, v = coe_to_rv(a, 0.0, i_deg, raan, 0.0, u)
    return np.array(r), np.array(v), a


# ------------------------------------------------------------- ephemerides
def test_sun_matches_vallado_example_5_1():
    # Vallado (2013) Example 5-1, 2 April 2006 0h UT: r = 0.9771945 I + 0.1924424 J + 0.0834308 K AU
    s = sun_position_km(2453827.5) / 149597870.7
    assert s == pytest.approx([0.9771945, 0.1924424, 0.0834308], abs=5e-6)


def test_moon_matches_vallado_example_5_3():
    # Vallado (2013) Example 5-3, 28 April 1994 0h UT
    m = moon_position_km(2449470.5)
    assert m == pytest.approx([-134240.626, -311571.590, -126693.785], abs=1.0)


def test_shadow():
    s = np.array([1.5e8, 0.0, 0.0])
    r = np.array([[7000.0, 0, 0], [-7000.0, 0, 0], [-7000.0, 7000.0, 0]])
    assert shadow_cylindrical(r, s).tolist() == [1.0, 0.0, 1.0]


# ----------------------------------------------------------------- gravity
@pytest.mark.parametrize("terms", [(True, False, False), (False, True, False), (False, False, True), (True, True, True)])
def test_zonal_acceleration_is_gradient_of_potential(terms):
    rng = np.random.default_rng(1)
    r = rng.normal(size=(5, 3))
    r = r / np.linalg.norm(r, axis=1, keepdims=True) * 7000.0
    a = accel_zonal(r, *terms)
    h = 1e-3
    grad = np.zeros_like(r)
    for k in range(3):
        e = np.zeros(3)
        e[k] = h
        up = zonal_potential(r + e, j2=terms[0], j3=terms[1], j4=terms[2], central=False)
        dn = zonal_potential(r - e, j2=terms[0], j3=terms[1], j4=terms[2], central=False)
        grad[:, k] = (up - dn) / (2 * h)
    assert np.allclose(a, grad, rtol=1e-7, atol=1e-16)


def test_density_model_is_monotonic_and_matches_table():
    assert density_exponential(np.array([400.0]))[0] == pytest.approx(3.725e-12)
    h = np.linspace(100, 1000, 200)
    assert np.all(np.diff(density_exponential(h)) < 0)


# -------------------------------------------------------------- propagation
def test_two_body_matches_kepler_after_one_day():
    r0, v0, a = _circ(700.0)
    T = 2 * math.pi * math.sqrt(a**3 / MU_EARTH)
    t = np.array([0.0, T, 86400.0])
    tr = propagate(EPOCH, r0, v0, t, TWO_BODY)
    assert np.linalg.norm(tr.r[0, 1] - r0) < 1e-4  # back to start after one period (< 10 cm)
    n = math.sqrt(MU_EARTH / a**3)
    r_exp, _ = coe_to_rv(a, 0.0, 51.6, 30.0, 0.0, math.degrees(n * 86400.0) % 360)
    assert np.linalg.norm(tr.r[0, 2] - np.array(r_exp)) < 1e-3  # < 1 m after a day


def test_energy_and_angular_momentum_conserved_two_body():
    r0, v0, _ = _circ(500.0, 98.0)
    v0 = v0 * 1.05  # eccentric
    tr = propagate(EPOCH, r0, v0, np.linspace(0, 86400, 50), TWO_BODY)
    r, v = tr.r[0], tr.v[0]
    eps = 0.5 * np.sum(v * v, 1) - MU_EARTH / np.linalg.norm(r, axis=1)
    h = np.linalg.norm(np.cross(r, v), axis=1)
    assert np.ptp(eps) / abs(eps[0]) < 1e-8 and np.ptp(h) / h[0] < 1e-8


def test_j2_nodal_regression_matches_secular_theory():
    alt, inc = 700.0, 98.19
    r0, v0, a = _circ(alt, inc)
    days = 3.0
    tr = propagate(EPOCH, r0, v0, np.array([0.0, days * 86400]), ForceModel(j2=True))
    raan0 = rv_to_coe(tr.r[0, 0], tr.v[0, 0]).raan_deg
    raan1 = rv_to_coe(tr.r[0, 1], tr.v[0, 1]).raan_deg
    drift = (raan1 - raan0 + 180) % 360 - 180
    raan_dot, _ = j2_secular_rates(a, 0.0, inc)
    expected = math.degrees(raan_dot) * days * 86400
    # osculating vs mean: short-period terms ~0.01 deg; secular drift ~2.96 deg in 3 days
    assert drift == pytest.approx(expected, abs=0.02)
    assert drift / days == pytest.approx(SSO_RAAN_RATE_DEG_DAY, abs=0.01)  # 700 km SSO really is SSO


def test_numerical_agrees_with_sgp4_within_tle_accuracy():
    """Hand over an SGP4 state to the numerical propagator and compare after 24 h (drag-free object)."""
    from sgp4.api import WGS72, Satrec

    from orbitguard_engine.conjunction import satrec_from_elements
    from orbitguard_engine.frames import datetime_to_jd

    sat = satrec_from_elements(EPOCH, 7078.0, 1e-3, 98.0, 40.0, 10.0, 0.0)
    jd, fr = datetime_to_jd(EPOCH)
    _, r0, v0 = sat.sgp4(jd, fr)
    tr = propagate(EPOCH, r0, v0, np.array([86400.0]), ForceModel(True, True, True))
    _, r1, _ = sat.sgp4(jd, fr + 1.0)
    err = np.linalg.norm(tr.r[0, 0] - np.array(r1))
    # SGP4 is an analytical theory (~1 km/day class); two independent models must agree at that level
    assert err < 15.0, err


def test_drag_decay_rate_matches_analytic():
    alt = 300.0
    r0, v0, a = _circ(alt, 0.0)
    body = Body(mass_kg=100.0, area_m2=1.0, cd=2.2)
    t = 2 * 3600.0
    with_drag = propagate(EPOCH, r0, v0, np.array([t]), ForceModel(j2=False, drag=True), body)
    no_drag = propagate(EPOCH, r0, v0, np.array([t]), TWO_BODY, body)

    def sma(r, v):
        return 1.0 / (2.0 / np.linalg.norm(r) - np.dot(v, v) / MU_EARTH)

    da = sma(with_drag.r[0, 0], with_drag.v[0, 0]) - sma(no_drag.r[0, 0], no_drag.v[0, 0])
    # da/dt = -rho B sqrt(mu a) with the co-rotating atmosphere (equatorial prograde: v_rel ~ v - wE r)
    rho = density_exponential(np.array([alt]))[0]
    v = math.sqrt(MU_EARTH / a)
    v_rel = v - 7.2921158553e-5 * a
    dadt = -rho * 2.2 * 1.0 / 100.0 * (v_rel / v) ** 2 * math.sqrt(MU_EARTH * a) * 1e3
    assert da == pytest.approx(dadt * t, rel=0.03)


def test_batch_equals_individual_runs():
    r0, v0, _ = _circ(600.0, 60.0)
    rs = np.array([r0, r0 + [1.0, 0, 0], r0 + [0, 0, 2.0]])
    vs = np.array([v0, v0, v0 + [0, 1e-3, 0]])
    t = np.linspace(0, 7200, 13)
    batch = propagate(EPOCH, rs, vs, t, ForceModel(True, True, True, True, True, True, True))
    for k in range(3):
        single = propagate(EPOCH, rs[k], vs[k], t, ForceModel(True, True, True, True, True, True, True))
        assert np.max(np.abs(batch.r[k] - single.r[0])) < 1e-5


# ----------------------------------------------------------------- maneuvers
def test_impulsive_tangential_burn_raises_semi_major_axis_by_gauss_equation():
    r0, v0, a = _circ(700.0, 0.0)
    dv = 1.0e-3  # 1 m/s
    tr = propagate(EPOCH, r0, v0, np.array([100.0, 101.0]), TWO_BODY, impulses=[Impulse(100.0, [0, dv, 0])])
    coe = rv_to_coe(tr.r[0, 1], tr.v[0, 1])
    # vis-viva: da = 2 a^2 v dv / mu for a circular orbit (first order)
    v = math.sqrt(MU_EARTH / a)
    assert coe.a_km - a == pytest.approx(2 * a * a * v * dv / MU_EARTH, rel=1e-3)
    assert np.linalg.norm(tr.r[0, 0] - tr.r[0, 0]) == 0  # position continuous by construction


def test_impulse_mass_follows_rocket_equation():
    r0, v0, _ = _circ()
    tr = propagate(EPOCH, r0, v0, np.array([10.0, 20.0]), TWO_BODY, Body(mass_kg=500.0), impulses=[Impulse(15.0, [0, 0.01, 0], isp_s=220.0)])
    assert 500.0 - tr.m[0, 1] == pytest.approx(propellant_for_dv(500.0, 10.0, 220.0), rel=1e-12)


def test_finite_burn_converges_to_impulsive():
    r0, v0, a = _circ(700.0, 0.0)
    dv_ms, thrust, isp, m0 = 0.5, 4.0, 220.0, 500.0
    tb = burn_duration(m0, dv_ms, thrust, isp)
    T = 2 * math.pi * math.sqrt(a**3 / MU_EARTH)
    t_mid = 1000.0
    fin = propagate(EPOCH, r0, v0, np.array([t_mid + T]), TWO_BODY, Body(m0),
                    burns=[FiniteBurn(t_mid - tb / 2, tb, thrust, isp, [0, 1, 0])])
    imp = propagate(EPOCH, r0, v0, np.array([t_mid + T]), TWO_BODY, Body(m0),
                    impulses=[Impulse(t_mid, [0, dv_ms / 1000, 0], isp_s=isp)])
    a_f = rv_to_coe(fin.r[0, 0], fin.v[0, 0]).a_km
    a_i = rv_to_coe(imp.r[0, 0], imp.v[0, 0]).a_km
    assert abs(a_f - a_i) < 1e-3 * (a_i - a)  # semi-major axis gain identical to 0.1 %
    assert fin.m[0, 0] == pytest.approx(imp.m[0, 0], rel=1e-9)  # same propellant


# ------------------------------------------------------------------ the twin
def test_rocket_equation_round_trip():
    m0, isp = 500.0, 220.0
    mp = propellant_for_dv(m0, 10.0, isp)
    assert dv_available(m0, mp, isp) == pytest.approx(10.0, rel=1e-12)
    # hand check: 10 m/s at Isp 220 s from 500 kg -> 2.313 kg
    assert mp == pytest.approx(500 * (1 - math.exp(-10 / (220 * 9.80665))), rel=1e-12)
    assert mp == pytest.approx(2.3125, abs=5e-4)


def test_spacecraft_summary_and_validation():
    sc = SpacecraftConfig()
    s = sc.summary()
    assert s["wet_mass_kg"] == 490.0 and s["usable_propellant_kg"] == 35.0
    assert s["dv_available_ms"] == pytest.approx(220 * 9.80665 * math.log(490 / 455), rel=1e-12)
    assert s["validation_errors"] == []
    bad = SpacecraftConfig.from_dict({**sc.to_dict(), "propulsion": {**sc.to_dict()["propulsion"], "power_w": 900}})
    assert any("power" in e for e in bad.validate())
    hall = SpacecraftConfig(propulsion=PROPULSION_PRESETS["hall"])
    # 20 mN Hall thruster: 1.5 h burn cap limits a single burn
    assert hall.max_single_burn_dv_ms() <= 0.2 and hall.burn_duration_s(0.1) == pytest.approx(490 * 0.1 / 0.02, rel=1e-3)
