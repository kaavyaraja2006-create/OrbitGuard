from __future__ import annotations

import math
from datetime import datetime, timezone

import numpy as np
import pytest

from orbitguard_engine.classification import ClassificationConfig, classify_orbit, required_sso_inclination_deg
from orbitguard_engine.constants import GEO_ALTITUDE_KM, GEO_RADIUS_KM, MU_EARTH, R_EARTH, SSO_RAAN_RATE_DEG_DAY
from orbitguard_engine.elements import coe_to_rv, derived_parameters, rv_to_coe
from orbitguard_engine.frames import ecef_to_geodetic, geodetic_to_ecef, gmst_rad, rtn_basis, teme_to_itrf
from orbitguard_engine.propagation import mean_elements, propagate, propagate_many, propagate_track, satrec_from_tle, time_grid
from orbitguard_engine.tle import TLEError, parse_tle, parse_tle_text, tle_checksum

# Vallado verification case #00005 (TEME example), from SGP4-VER.TLE
L1 = "1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753"
L2 = "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667"


# ----------------------------------------------------------------- TLE
def test_checksum_and_fields():
    assert tle_checksum(L1) == 3 and tle_checksum(L2) == 7
    t = parse_tle(L1, L2, "VANGUARD 1")
    assert t.norad_id == 5
    assert t.intl_designator == "58002B"
    assert t.inclination_deg == pytest.approx(34.2682)
    assert t.eccentricity == pytest.approx(0.1859667)
    assert t.mean_motion_rev_day == pytest.approx(10.82419157)
    assert t.bstar == pytest.approx(0.28098e-4)
    assert t.epoch.year == 2000 and t.epoch.timetuple().tm_yday == 179


def test_corrupted_tle_is_rejected_not_silently_accepted():
    bad = L2[:20] + "9" + L2[21:]
    with pytest.raises(TLEError):
        parse_tle(L1, bad)
    t = parse_tle(L1, bad, strict=False)
    assert t.warnings  # lenient mode still reports it


def test_three_line_text_and_rejections_reported():
    text = f"VANGUARD 1\n{L1}\n{L2}\n2 orphan line\n"
    rep = parse_tle_text(text)
    assert len(rep.tles) == 1 and rep.tles[0].name == "VANGUARD 1"
    assert len(rep.rejected) == 1


def test_alpha5_catalog_number():
    from orbitguard_engine.tle import _parse_alpha5

    assert _parse_alpha5("A0001") == 100001
    assert _parse_alpha5("Z9999") == 339999


# ----------------------------------------------------------- elements
@pytest.mark.parametrize(
    "p,e,i,raan,argp,nu",
    [
        (11067.790, 0.83285, 87.87, 227.89, 53.38, 92.335),
        (7000.0, 0.001, 51.6, 10.0, 20.0, 300.0),
        (26500.0, 0.7, 63.4, 280.0, 270.0, 10.0),
        (7200.0, 0.05, 120.0, 359.0, 1.0, 180.0),
    ],
)
def test_coe_rv_round_trip(p, e, i, raan, argp, nu):
    r, v = coe_to_rv(p, e, i, raan, argp, nu)
    c = rv_to_coe(r, v)
    assert c.p_km == pytest.approx(p, rel=1e-10)
    assert c.e == pytest.approx(e, abs=1e-10)
    assert c.i_deg == pytest.approx(i, abs=1e-9)
    assert c.raan_deg == pytest.approx(raan, abs=1e-8)
    assert c.argp_deg == pytest.approx(argp, abs=1e-7)
    assert c.nu_deg == pytest.approx(nu, abs=1e-7)


def test_circular_orbit_flags_undefined_angles():
    r, v = coe_to_rv(7000.0, 0.0, 45.0, 30.0, 0.0, 60.0)  # nu slot = argument of latitude
    c = rv_to_coe(r, v)
    assert "argp" in c.undefined and "nu" in c.undefined
    assert c.arglat_deg == pytest.approx(60.0, abs=1e-8)


def test_energy_and_angular_momentum_consistency():
    a, e = 8000.0, 0.1
    p = a * (1 - e * e)
    for nu in np.linspace(0, 350, 8):
        r, v = coe_to_rv(p, e, 30, 40, 50, nu)
        energy = np.dot(v, v) / 2 - MU_EARTH / np.linalg.norm(r)
        h = np.linalg.norm(np.cross(r, v))
        assert energy == pytest.approx(-MU_EARTH / (2 * a), rel=1e-12)
        assert h == pytest.approx(math.sqrt(MU_EARTH * p), rel=1e-12)


def test_derived_parameters():
    d = derived_parameters(R_EARTH + 400.0, 0.0, 51.6)
    assert d.period_min == pytest.approx(92.56, abs=0.01)
    assert d.perigee_altitude_km == pytest.approx(400.0)
    # Prograde orbit regresses westward (negative RAAN rate)
    assert d.raan_rate_deg_day < 0
    # GEO radius from the sidereal day
    assert GEO_RADIUS_KM == pytest.approx(42164.17, abs=0.05)
    assert GEO_ALTITUDE_KM == pytest.approx(35786.0, abs=0.1)


# ------------------------------------------------------- classification
def _labels(a, e, i, **kw):
    return set(classify_orbit(a, e, i, **kw).labels)


def test_iss_like_is_leo_only():
    assert _labels(R_EARTH + 420, 0.0005, 51.64) == {"LEO"}


def test_sso_is_multilabel_leo_polar_sso():
    a = R_EARTH + 700
    i = required_sso_inclination_deg(a)
    assert i == pytest.approx(98.19, abs=0.05)
    res = classify_orbit(a, 0.001, i)
    assert set(res.labels) == {"LEO", "POLAR", "SSO"}
    sso = next(c for c in res.criteria if c.label == "SSO")
    assert sso.value == pytest.approx(SSO_RAAN_RATE_DEG_DAY, abs=0.01)


def test_gps_is_meo():
    assert _labels(26560.0, 0.01, 55.0) == {"MEO"}


def test_geostationary_vs_geosynchronous():
    r = classify_orbit(GEO_RADIUS_KM, 0.0002, 0.05)
    assert r.labels == ["GEO"] and r.geo_type == "geostationary"
    r2 = classify_orbit(GEO_RADIUS_KM, 0.0002, 8.0)  # inclined GSO
    assert "GEO" in r2.labels and r2.geo_type == "geosynchronous"


def test_molniya_and_tundra():
    m = classify_orbit(26600.0, 0.74, 63.4)
    assert "HEO" in m.labels and "LEO" not in m.labels
    assert "LEO" in m.regions_crossed and "MEO" in m.regions_crossed
    t = classify_orbit(GEO_RADIUS_KM, 0.27, 63.4)
    assert {"GEO", "HEO"} <= set(t.labels) and t.geo_type == "geosynchronous"


def test_boundaries_are_strict_and_configurable():
    a = R_EARTH + 2000.001
    assert "LEO" not in _labels(a, 0.0, 30.0)  # just above ceiling: not LEO
    cfg = ClassificationConfig(leo_max_altitude_km=2001.0)
    assert "LEO" in _labels(a, 0.0, 30.0, config=cfg)
    assert "POLAR" in _labels(R_EARTH + 500, 0.0, 80.0)
    assert "POLAR" not in _labels(R_EARTH + 500, 0.0, 79.9)


def test_graveyard_orbit_is_unclassified_with_warning():
    r = classify_orbit(GEO_RADIUS_KM + 300.0, 0.001, 1.0)
    assert r.status == "unclassified-regime" and r.warnings


# --------------------------------------------------------------- frames
def test_gmst_at_j2000():
    # IAU-82 GMST at J2000.0 (2000-01-01 12:00 UT1) = 280.46061837 deg
    assert math.degrees(gmst_rad(2451545.0)) == pytest.approx(280.46061837, abs=1e-6)


def test_teme_to_itrf_preserves_radius_and_is_z_invariant():
    r = np.array([7000.0, -1200.0, 3000.0])
    v = np.array([1.0, 7.0, 0.5])
    rf, vf = teme_to_itrf(r, v, 2459000.5, 0.25)
    assert np.linalg.norm(rf) == pytest.approx(np.linalg.norm(r), rel=1e-14)
    assert rf[2] == pytest.approx(r[2])


@pytest.mark.parametrize("lat,lon,h", [(0, 0, 0), (12.97, 77.59, 0.92), (-45, -170, 550), (89.9, 10, 35786), (-89.99, 0, 1)])
def test_geodetic_round_trip(lat, lon, h):
    r = geodetic_to_ecef(lat, lon, h)
    la, lo, hh = ecef_to_geodetic(r)
    assert la == pytest.approx(lat, abs=1e-9)
    assert lo == pytest.approx(lon, abs=1e-9)
    assert hh == pytest.approx(h, abs=1e-6)


def test_rtn_basis_orthonormal():
    b = rtn_basis([7000, 0, 0], [0, 7.5, 1.0])
    assert np.allclose(b @ b.T, np.eye(3), atol=1e-14)


# ---------------------------------------------------------- propagation
def test_mean_elements_and_track_consistency():
    tle = parse_tle(L1, L2)
    sat = satrec_from_tle(tle)
    me = mean_elements(sat, tle.epoch)
    # a is SGP4's Brouwer mean semi-major axis; Kepler's law applied to the
    # Kozai mean motion in the TLE gives a nearby but slightly different value.
    assert me.a_km == pytest.approx(sat.a * sat.radiusearthkm, rel=1e-12)
    n_kozai = sat.no_kozai / 60.0
    assert me.a_km == pytest.approx((sat.mu / n_kozai**2) ** (1 / 3), rel=1e-3)
    times = time_grid(tle.epoch, 6000, 600)
    tr = propagate_track(sat, times)
    assert (tr.errors == 0).all()
    alt_range = (tr.alt_km.min(), tr.alt_km.max())
    d = derived_parameters(me.a_km, me.e, me.i_deg)
    assert d.perigee_altitude_km - 60 < alt_range[0]  # within mean-vs-osculating & ellipsoid slack
    assert alt_range[1] < d.apogee_altitude_km + 60


def test_vectorised_snapshot_equals_single():
    tle = parse_tle(L1, L2)
    sat = satrec_from_tle(tle)
    when = datetime(2000, 6, 29, tzinfo=timezone.utc)
    single = propagate(sat, when)
    snap = propagate_many([sat, sat], when)
    assert np.allclose(snap.r_teme[0], single.r_km, atol=1e-9)
    assert snap.r_itrf.shape == (2, 3)
