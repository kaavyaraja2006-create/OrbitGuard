"""Phase 6: multi-threat maneuver optimisation, constraints, Monte Carlo, independent validation."""

from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pytest

from orbitguard_engine.constants import R_EARTH
from orbitguard_engine.elements import coe_to_rv
from orbitguard_engine.forces import ForceModel
from orbitguard_engine.maneuver import (
    OptimizerConfig,
    Uncertainty,
    body_of,
    candidate_grid,
    closest_approaches,
    fixed_baseline,
    optimise,
    synthetic_threats,
    threat_tracks,
    time_grid,
)
from orbitguard_engine.numerical import propagate
from orbitguard_engine.spacecraft import SpacecraftConfig

EP = datetime(2026, 11, 1, tzinfo=timezone.utc)
R0, V0 = (np.array(x) for x in coe_to_rv(R_EARTH + 700, 0.001, 98.19, 30, 0, 10))
FAST = dict(horizon_s=12 * 3600, n_times=4, n_magnitudes=5, refine_rounds=2, shortlist=3)
SPECS = [
    dict(tca_s=20000, miss_km=0.08, crossing_deg=70, phase_deg=10),
    dict(tca_s=33000, miss_km=0.12, crossing_deg=120, phase_deg=80),
]


def _cfg(**kw):
    return OptimizerConfig(**{**FAST, **kw})


def _threats(cfg, specs=SPECS):
    return synthetic_threats(EP, R0, V0, specs, force=cfg.force, body=body_of(SpacecraftConfig()))


def test_synthetic_threats_pass_where_designed():
    cfg = _cfg()
    th = _threats(cfg)
    t = time_grid(cfg.horizon_s, cfg.step_s)
    TR, TV, st = threat_tracks(EP, t, th)
    nom = propagate(EP, R0, V0, t, cfg.force, body_of(SpacecraftConfig()))
    ca = closest_approaches(t, nom.r, nom.v, TR, TV)
    for k, s in enumerate(SPECS):
        assert ca["miss"][0, k] == pytest.approx(s["miss_km"], abs=0.001)  # within 1 m of the design
        assert ca["tca"][0, k] == pytest.approx(s["tca_s"], abs=1.0)
    assert all(x == "ok" for x in st) and all(x.kind == "synthetic" for x in th)


def test_linearised_minimum_matches_fine_brute_force():
    cfg = _cfg()
    th = _threats(cfg)[:1]
    t = time_grid(cfg.horizon_s, 20.0)
    TR, TV, _ = threat_tracks(EP, t, th)
    nom = propagate(EP, R0, V0, t, cfg.force, body_of(SpacecraftConfig()))
    ca = closest_approaches(t, nom.r, nom.v, TR, TV)
    tf = np.linspace(SPECS[0]["tca_s"] - 30, SPECS[0]["tca_s"] + 30, 6001)  # 10 ms
    fine = propagate(EP, R0, V0, tf, cfg.force, body_of(SpacecraftConfig()))
    TRf, _, _ = threat_tracks(EP, tf, th)
    brute = np.linalg.norm(TRf[0] - fine.r[0], axis=1).min()
    assert abs(ca["miss"][0, 0] - brute) < 1e-3  # < 1 m


def test_candidate_grid_respects_window_and_directions():
    sc = SpacecraftConfig()
    sc.attitude.allowed_directions = ["+T", "-T"]
    g = candidate_grid(20000.0, 5927.0, sc, _cfg())
    assert len(g) > 0
    assert np.all(g[:, 0] >= sc.attitude.min_lead_time_s)
    assert np.all(g[:, 0] <= 20000.0 - sc.attitude.min_time_before_tca_s)
    assert np.all(g[:, 1] == 0) and np.all(g[:, 3] == 0)
    assert np.linalg.norm(g[:, 1:], axis=1).max() <= sc.max_single_burn_dv_ms() + 1e-12


@pytest.fixture(scope="module")
def solved():
    cfg = _cfg()
    sc = SpacecraftConfig()
    sc.mission.preserve_sso = True
    return optimise(EP, R0, V0, sc, _threats(cfg), cfg, Uncertainty(mc_samples=32)), sc, cfg


def test_optimiser_selects_a_validated_maneuver(solved):
    res, sc, cfg = solved
    assert res["status"] == "selected", res.get("message")
    s = res["selected"]
    assert s["feasible"] and res["safe_against_all_threats"]
    for before, after in zip(res["nominal"]["per_threat"], s["per_threat"]):
        assert after["miss_km"] >= cfg.d_min_km and after["pc"] <= cfg.pc_limit
        assert after["miss_km"] > before["miss_km"]
    assert s["dv_ms"] <= sc.max_single_burn_dv_ms()
    assert abs(s["raan_rate_change_deg_day"]) <= sc.mission.sso_rate_tol_deg_day  # SSO preserved
    assert res["validation"]["status"] == "passed"
    assert res["monte_carlo"]["selected"]["p_violation"] <= cfg.p_violation_max
    assert res["monte_carlo"]["nominal"]["p_violation"] > res["monte_carlo"]["selected"]["p_violation"]


def test_every_rejection_is_explained(solved):
    res, _, _ = solved
    assert res["candidates_evaluated"] > 50
    assert sum(res["rejection_summary"].values()) > 0
    for c in res["top_candidates"]:
        assert c["feasible"] == (len(c["reasons"]) == 0)
    assert any("Independent validation" in line for line in res["explanation"])


def test_no_maneuver_needed_when_threats_are_far():
    cfg = _cfg()
    th = _threats(cfg, [dict(tca_s=20000, miss_km=25.0, crossing_deg=70)])
    res = optimise(EP, R0, V0, SpacecraftConfig(), th, cfg, Uncertainty(mc_samples=16))
    assert res["status"] == "no-maneuver-needed" and res["selected"] is None


def test_honest_failure_when_fuel_budget_is_too_small():
    cfg = _cfg()
    sc = SpacecraftConfig()
    sc.propulsion.max_dv_per_burn_ms = 0.004  # 4 mm/s: far too little for an 80 m miss
    res = optimise(EP, R0, V0, sc, _threats(cfg), cfg, Uncertainty(mc_samples=16))
    assert res["status"] in ("no-feasible-candidate", "no-robust-candidate")
    assert res["selected"] is None


def test_direction_constraint_is_respected():
    cfg = _cfg(use_monte_carlo=False, validate=False)
    sc = SpacecraftConfig()
    sc.attitude.allowed_directions = ["+N", "-N"]
    res = optimise(EP, R0, V0, sc, _threats(cfg), cfg)
    if res["status"] == "selected":
        r, t_, n = res["selected"]["dv_rtn_ms"]
        assert r == 0 and t_ == 0 and n != 0
    else:
        assert res["selected"] is None


def test_single_threat_baseline_is_scored_against_all_threats():
    cfg = _cfg(threat_mode="single", use_monte_carlo=False, validate=False)
    res = optimise(EP, R0, V0, SpacecraftConfig(), _threats(cfg), cfg)
    assert len(res["threats_considered"]) == 1
    if res["selected"]:
        assert len(res["selected"]["per_threat"]) == 2


def test_fixed_baseline_runs():
    cfg = _cfg()
    out = fixed_baseline(EP, R0, V0, SpacecraftConfig(), _threats(cfg), cfg, Uncertainty(), dv_ms=0.1)
    assert out["selected"]["dv_ms"] == pytest.approx(0.1)
    assert len(out["selected"]["per_threat"]) == 2


def test_force_model_choice_is_recorded(solved):
    res, _, _ = solved
    assert "J2" in res["config"]["force"] and any("drag" in x for x in res["config"]["force"])
    assert ForceModel.full().describe()[-1].startswith("solar radiation pressure")


def test_risk_term_edges():
    from orbitguard_engine.maneuver import _risk_term

    assert _risk_term([1e-9], 1e-4, 1e-7) == 0.0  # below target
    assert _risk_term([1e-4], 1e-4, 1e-7) == pytest.approx(1.0)  # at the limit
    assert _risk_term([1e-5], 1e-4, 1e-7) == pytest.approx(2 / 3)
    assert _risk_term([5e-5], 1e-4, 1e-4) == 0.0 and _risk_term([2e-4], 1e-4, 1e-4) == 1.0  # target == limit
