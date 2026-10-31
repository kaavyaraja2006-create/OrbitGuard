"""Phase 7: orbit transfer laboratory against textbook examples and numerical flight."""

from __future__ import annotations

import math

import pytest

from orbitguard_engine.constants import GEO_RADIUS_KM, R_EARTH
from orbitguard_engine.transfer import PRESETS, TransferRequest, bielliptic, fly, hohmann, hohmann_with_plane_change, plane_change

R1 = R_EARTH + 191.34411  # Vallado (2013) Examples 6-1 and 6-2
R2 = R_EARTH + 35781.34857


def test_hohmann_matches_vallado_example_6_1():
    h = hohmann(R1, R2)
    assert h["dv1_kms"] == pytest.approx(2.457038, abs=1e-5)
    assert h["dv2_kms"] == pytest.approx(1.478187, abs=1e-5)
    assert h["dv_total_kms"] == pytest.approx(3.935224, abs=1e-5)
    assert h["tof_s"] / 3600 == pytest.approx(5.256713, abs=1e-4)


def test_bielliptic_matches_vallado_example_6_2():
    b = bielliptic(R1, R_EARTH + 376310.0, R_EARTH + 503873.0)
    assert b["dv_total_kms"] == pytest.approx(3.904057, abs=1e-4)
    assert b["tof_s"] / 3600 == pytest.approx(593.919, abs=0.05)


def test_plane_change_formula():
    assert plane_change(7.5, 0.0) == 0.0
    assert plane_change(7.5, 60.0) == pytest.approx(7.5)  # 2 v sin 30 deg = v
    assert plane_change(5.892311, 15.0) == pytest.approx(2 * 5.892311 * math.sin(math.radians(7.5)))


@pytest.mark.parametrize("di", [28.5, -28.5])
def test_combined_transfer_beats_separate_plane_change(di):
    c = hohmann_with_plane_change(R_EARTH + 300, GEO_RADIUS_KM, di)
    assert c["dv_total_kms"] <= c["alternatives"]["all_at_apoapsis_kms"] + 1e-12
    assert c["dv_total_kms"] < c["alternatives"]["hohmann_then_separate_plane_change_kms"]
    assert 0.0 < c["optimal_split_at_departure"] < 0.2  # most of the plane change belongs at apoapsis
    assert 4.2 < c["dv_total_kms"] < 4.35  # Cape Canaveral to GEO is ~4.3 km/s in the textbooks


@pytest.mark.parametrize("name", ["leo-raise", "leo-lower", "leo-meo", "leo-geo", "plane-change"])
def test_flown_transfer_reaches_the_target_orbit(name):
    req = PRESETS[name]
    out = fly(req)
    tgt_r = R_EARTH + (req.alt2_km if req.alt2_km is not None else req.alt1_km)
    tgt_i = req.inc2_deg if req.inc2_deg is not None else req.inc1_deg
    assert out["reached"]["a_km"] == pytest.approx(tgt_r, abs=0.05)
    assert out["reached"]["e"] < 1e-5
    assert out["reached"]["i_deg"] == pytest.approx(tgt_i, abs=1e-4)
    assert out["numerical_dv_total_kms"] == pytest.approx(out["analytical"]["dv_total_kms"], rel=1e-6)


def test_raise_apogee_reaches_requested_apogee():
    out = fly(PRESETS["gto"])
    assert out["reached"]["a_km"] * (1 + out["reached"]["e"]) == pytest.approx(GEO_RADIUS_KM, abs=0.1)


def test_propellant_by_rocket_equation():
    out = fly(TransferRequest("hohmann", 400, 800, 51.6, mass_kg=1000.0, isp_s=300.0))
    dv = out["numerical_dv_total_kms"] * 1000
    assert out["propellant"]["propellant_kg"] == pytest.approx(1000 * (1 - math.exp(-dv / (300 * 9.80665))))
