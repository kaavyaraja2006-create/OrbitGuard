"""Kelvins CDM reconstruction (using two real rows from the dataset) and pair TCA."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import pytest

from orbitguard_engine.conjunction import satrec_from_elements
from orbitguard_engine.kelvins import geometry_from_row, infer_hbr_km, parse_socrates_name, pc
from orbitguard_engine.pair import closest_approach_near

# Real rows copied from the ESA Kelvins dataset (event 0, mission 19):
# test_data.csv first CDM and test_data_private.csv first CDM. Only the
# fields this module uses are kept.
ROW_TEST = {
    "risk": -7.296966695266313, "mahalanobis_distance": 52.08132768407097, "t_j2k_sma": 7084.6981869190795,
    "relative_position_r": -365.5, "relative_position_t": 26967.0, "relative_position_n": 16880.6,
    "relative_velocity_r": -26.3, "relative_velocity_t": -4207.7, "relative_velocity_n": 6720.9,
    "t_sigma_r": 7.414543816041551, "t_sigma_t": 359.0721375991181, "t_sigma_n": 4.557018762305024,
    "t_ct_r": -0.2703540299199198, "t_cn_r": -0.6570604518065041, "t_cn_t": 0.19626407178680694,
    "c_sigma_r": 212.77521002222042, "c_sigma_t": 28182.398762348104, "c_sigma_n": 45.38667205248695,
    "c_ct_r": -0.012443147370015931, "c_cn_r": -0.5890987390375574, "c_cn_t": 0.063822603674938,
}
ROW_PRIVATE = {
    "risk": -7.322484295201242, "mahalanobis_distance": 361.26880914885567, "t_j2k_sma": 7084.699624273241,
    "relative_position_r": -371.7, "relative_position_t": 27697.7, "relative_position_n": 17340.4,
    "relative_velocity_r": -27.0, "relative_velocity_t": -4207.7, "relative_velocity_n": 6720.9,
    "t_sigma_r": 4.251239819158641, "t_sigma_t": 34.857079625235386, "t_sigma_n": 4.15658152813102,
    "t_ct_r": -0.7418362378721212, "t_cn_r": -0.27679694558516443, "t_cn_t": 0.30945287494352003,
    "c_sigma_r": 212.79116523013823, "c_sigma_t": 28326.346393419677, "c_sigma_n": 45.33895675906096,
    "c_ct_r": -0.013748746014747279, "c_cn_r": -0.5892887063116562, "c_cn_t": 0.06293826096536048,
}


@pytest.mark.parametrize("row", [ROW_TEST, ROW_PRIVATE])
def test_mahalanobis_matches_esa_on_real_rows(row):
    g, why = geometry_from_row(row)
    assert why is None
    assert g.mahalanobis_3d == pytest.approx(row["mahalanobis_distance"], rel=0.01)


def test_inferred_hbr_is_physical_and_stable_within_event():
    h1 = infer_hbr_km(geometry_from_row(ROW_TEST)[0], ROW_TEST["risk"])
    h2 = infer_hbr_km(geometry_from_row(ROW_PRIVATE)[0], ROW_PRIVATE["risk"])
    assert 0.001 < h1 < 0.01 and 0.001 < h2 < 0.01  # metres-scale object
    assert abs(h1 - h2) / h1 < 0.1  # same event, two CDMs -> same size


def test_hbr_round_trip_small_and_large_body():
    g = geometry_from_row(ROW_TEST)[0]
    for h in (0.002, 0.005, 0.5):  # 0.5 km forces the exact (brentq) branch
        p = pc(g, h)
        assert infer_hbr_km(g, math.log10(p)) == pytest.approx(h, rel=1e-4)


def test_invalid_rows_are_rejected_with_reason():
    bad = dict(ROW_TEST, c_sigma_t="")
    assert geometry_from_row(bad) == (None, "missing value")
    bad2 = dict(ROW_TEST, t_ct_r=1.5)
    assert geometry_from_row(bad2)[1] == "correlation outside [-1, 1]"
    assert infer_hbr_km(geometry_from_row(ROW_TEST)[0], -30.0) is None  # dataset floor


def test_socrates_name_parsing():
    assert parse_socrates_name("STARLINK-6366 [+]") == ("STARLINK-6366", "+")
    assert parse_socrates_name("SL-16 R/B [-]") == ("SL-16 R/B", "-")
    assert parse_socrates_name("NO STATUS") == ("NO STATUS", None)


def test_pair_closest_approach_recovers_engineered_tca():
    epoch = datetime(2026, 10, 1, tzinfo=timezone.utc)
    a_km, dt = 7000.0, 1234.5
    m0 = -math.degrees(math.sqrt(398600.8 / a_km**3)) * dt
    p = satrec_from_elements(epoch, a_km, 1e-4, 51.6, 0.0, 0.0, m0)
    s = satrec_from_elements(epoch, a_km, 1e-4, 97.5, 0.0, 0.0, m0)
    res = closest_approach_near(p, s, epoch + timedelta(seconds=dt + 90))  # reference deliberately off by 90 s
    assert abs((res.tca - (epoch + timedelta(seconds=dt))).total_seconds()) < 5
    assert res.relative_speed_kms > 5
