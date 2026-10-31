"""Multi-satellite tracking and proximity API on engineered SGP4 objects with known geometry."""

from __future__ import annotations

import math
import os
import tempfile
from datetime import datetime, timedelta, timezone

if "ORBITGUARD_DATABASE_URL" not in os.environ:
    os.environ["ORBITGUARD_DATABASE_URL"] = f"sqlite:///{tempfile.NamedTemporaryFile(suffix='.db', delete=False).name}"

import numpy as np  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sgp4.api import WGS72, Satrec  # noqa: E402
from sgp4.exporter import export_tle  # noqa: E402

from app.main import app  # noqa: E402
from authutil import as_role  # noqa: E402
from orbitguard_engine.conjunction import satrec_from_elements  # noqa: E402
from orbitguard_engine.frames import datetime_to_jd  # noqa: E402

API = "/api/v1"
EPOCH = datetime(2026, 11, 1, tzinfo=timezone.utc)
A = 7000.0
DT = 1234.5
N_DEG_S = math.degrees(math.sqrt(398600.8 / A**3))
M0 = -N_DEG_S * DT
AT = EPOCH + timedelta(seconds=DT)
R = 30.0  # J2 rates differ with inclination, so the engineered crosser passes ~22 km away (computed, not assumed)

client = as_role(TestClient(app), "super_admin", "prox-admin@test.local", "Platform Org")

SATS = {
    93001: ("PROX PRIMARY", 51.6, 0.0, M0),
    93002: ("PROX CROSSER", 97.5, 0.0, M0),  # passes the primary near the node at AT
    93004: ("PROX FAR", 51.6, 0.0, M0 + 120.0),  # same orbit, far away
}
DEBRIS = {93003: ("PROX DEB TRAILING", 51.6, 0.0, M0 - 0.03)}  # ~3.7 km behind in the same orbit


def _tle(satnum, name, i, raan, m):
    sat = satrec_from_elements(EPOCH, A, 1e-4, i, raan, 0.0, m, satnum=satnum)
    sat.intldesg, sat.classification = "26099A", "U"
    l1, l2 = export_tle(sat)
    return f"{name}\n{l1}\n{l2}\n", Satrec.twoline2rv(l1, l2, WGS72)  # exactly what the server stores


SATRECS = {}


@pytest.fixture(scope="module", autouse=True)
def catalog():
    text = ""
    for k, v in SATS.items():
        t, SATRECS[k] = _tle(k, *v)
        text += t
    r = client.post(f"{API}/ingestion/upload", json={"label": "proximity-test-payloads", "text": text, "object_kind": "payload"})
    assert r.status_code == 200 and r.json()["records_new"] == 3, r.text
    text = ""
    for k, v in DEBRIS.items():
        t, SATRECS[k] = _tle(k, *v)
        text += t
    r = client.post(f"{API}/ingestion/upload", json={"label": "proximity-test-debris", "text": text, "object_kind": "debris"})
    assert r.json()["records_new"] == 1


def _dist(a, b, when):
    jd, fr = datetime_to_jd(when)
    _, r1, _ = SATRECS[a].sgp4(jd, fr)
    _, r2, _ = SATRECS[b].sgp4(jd, fr)
    return float(np.linalg.norm(np.subtract(r2, r1)))


def test_search_by_name_id_and_category():
    r = client.get(f"{API}/objects/search", params={"q": "PROX"}).json()
    assert {i["norad_id"] for i in r["items"]} >= {93001, 93002, 93003, 93004}
    assert client.get(f"{API}/objects/search", params={"q": "93002"}).json()["items"][0]["norad_id"] == 93002
    deb = client.get(f"{API}/objects/search", params={"q": "PROX", "category": "debris"}).json()["items"]
    assert [i["norad_id"] for i in deb] == [93003] and deb[0]["category_label"] == "Debris"
    sat = next(i for i in r["items"] if i["norad_id"] == 93001)
    assert sat["category"] == "satellite_unknown_status"  # payload, but no operational status source
    assert client.get(f"{API}/objects/search", params={"category": "nonsense"}).status_code == 400


def test_multi_select_returns_each_satellite_with_its_own_orbit():
    r = client.post(f"{API}/tracking/multi-select", json={"norad_ids": [93001, 93002, 93001, 99999999], "at": AT.isoformat()}).json()
    items = r["items"]
    assert [i["norad_id"] for i in items] == [93001, 93002, 99999999]  # duplicates removed, order kept
    assert items[2]["status"] == "not-in-catalog"
    for it in items[:2]:
        assert it["status"] == "ok" and len(it["orbit"]["ecef_km"]) > 100 and all(it["orbit"]["valid"])
        assert it["mean_elements"]["period_min"] == pytest.approx(2 * math.pi * math.sqrt(A**3 / 398600.8) / 60, rel=0.01)
        assert it["epoch"].startswith("2026-11-01")
    assert items[0]["orbit"]["ecef_km"] != items[1]["orbit"]["ecef_km"]
    one = client.post(f"{API}/tracking/select", json={"norad_id": 93003, "at": AT.isoformat()}).json()
    assert one["category"] == "debris" and one["state"]["propagation"] == "ok"
    assert client.post(f"{API}/tracking/select", json={"norad_id": 99999999}).status_code == 404


def test_current_proximity_is_true_3d_separation():
    r = client.post(f"{API}/proximity/screen", json={"norad_ids": [93001], "at": AT.isoformat(), "radius_km": R}).json()
    res = r["results"][0]
    assert res["status"] == "ok" and r["mode"] == "current"
    ids = [x["norad_id"] for x in res["items"]]
    assert 93002 in ids and 93003 in ids and 93004 not in ids and 93001 not in ids
    for x in res["items"]:
        if x["norad_id"] in SATRECS:
            assert x["distance_km"] == pytest.approx(_dist(93001, x["norad_id"], AT), abs=1e-6)
            assert np.linalg.norm(x["r_rel_rtn_km"]) == pytest.approx(x["distance_km"], rel=1e-9)
    crosser = next(x for x in res["items"] if x["norad_id"] == 93002)
    assert crosser["relative_speed_kms"] > 5  # 46 deg plane difference
    assert "NOT AVAILABLE" in r["uncertainty"]
    # FAR is at the same altitude but ~14,000 km away: altitude comparison would wrongly call it near
    far = client.post(f"{API}/tracking/select", json={"norad_id": 93004, "at": AT.isoformat()}).json()
    prim = client.post(f"{API}/tracking/select", json={"norad_id": 93001, "at": AT.isoformat()}).json()
    assert abs(far["state"]["geodetic"]["alt_km"] - prim["state"]["geodetic"]["alt_km"]) < 30


def test_radius_and_type_filters():
    small = client.get(f"{API}/tracking/93001/nearby", params={"at": AT.isoformat(), "radius_km": 1}).json()
    assert 93003 not in [x["norad_id"] for x in small["items"]]  # 3.7 km away
    deb = client.get(f"{API}/tracking/93001/nearby", params={"at": AT.isoformat(), "radius_km": 10, "categories": "debris"}).json()
    assert [x["norad_id"] for x in deb["items"]] == [93003] and deb["counts"] == {"debris": 1}
    paged = client.get(f"{API}/tracking/93001/nearby", params={"at": AT.isoformat(), "radius_km": 10, "limit": 1}).json()
    paged = client.get(f"{API}/tracking/93001/nearby", params={"at": AT.isoformat(), "radius_km": R, "limit": 1}).json()
    assert paged["total"] >= 2 and len(paged["items"]) == 1
    assert client.get(f"{API}/tracking/93001/nearby", params={"radius_km": 0}).status_code == 422


def test_compare_panel():
    r = client.post(f"{API}/tracking/compare", json={"norad_ids": [93001, 93004], "at": AT.isoformat(), "radius_km": R}).json()
    rows = {x["norad_id"]: x for x in r["rows"]}
    assert rows[93001]["nearby_count"] >= 2 and rows[93004]["nearby_count"] == 0
    assert rows[93001]["inclination_deg"] == pytest.approx(51.6, abs=0.01)
    assert rows[93001]["eccentricity"] == pytest.approx(1e-4, rel=0.01)
    assert rows[93001]["position"]["lat_deg"] is not None


def test_future_proximity_finds_closest_approach_and_entry():
    r = client.post(f"{API}/proximity/predict", json={"norad_ids": [93001], "start": EPOCH.isoformat(), "horizon_h": 1, "radius_km": R, "step_s": 60})
    assert r.status_code == 202
    job = client.get(f"{API}/proximity/jobs/{r.json()['job_id']}").json()
    assert job["status"] == "succeeded", job
    sat = job["result"]["satellites"][0]
    w = next(x for x in sat["windows"] if x["norad_id"] == 93002)
    tca = datetime.fromisoformat(w["tca"])
    assert abs((tca - AT).total_seconds()) < 5
    assert w["min_distance_km"] == pytest.approx(_dist(93001, 93002, tca), abs=1e-6)
    assert w["min_distance_km"] < R and w["entry"] < w["tca"] < w["exit"]
    assert _dist(93001, 93002, datetime.fromisoformat(w["entry"])) == pytest.approx(R, abs=1e-3)
    trailing = next(x for x in sat["windows"] if x["norad_id"] == 93003)
    assert trailing["inside_at_start"] and trailing["entry"] is None
    assert job["result"]["uncertainty"].startswith("NOT AVAILABLE")
    assert client.get(f"{API}/proximity/jobs").json()[0]["id"] == job["id"]


def test_proximity_is_not_conflated_with_conjunction_risk():
    # no screening yet -> no conjunction annotation, just distance
    r = client.post(f"{API}/proximity/screen", json={"norad_ids": [93001], "at": AT.isoformat(), "radius_km": 10}).json()
    assert all(x["conjunction"] is None for x in r["results"][0]["items"])
    assert "not a collision probability" in r["note"]


def test_public_user_gets_current_but_not_predicted_proximity():
    pub = as_role(TestClient(app), "public", "prox-public@test.local")
    assert pub.post(f"{API}/proximity/screen", json={"norad_ids": [93001], "at": AT.isoformat(), "radius_km": 10}).status_code == 200
    assert pub.post(f"{API}/proximity/predict", json={"norad_ids": [93001]}).status_code == 403
    assert pub.post(f"{API}/proximity/screen", json={"norad_ids": list(range(1, 40))}).status_code == 400  # selection cap
