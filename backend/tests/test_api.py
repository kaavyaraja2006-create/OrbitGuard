"""Backend integration tests: ingestion -> database -> propagation -> API.

Uses Vallado's SGP4 verification TLEs (bundled with python-sgp4) as an
upload, and a mocked HTTP transport for the CelesTrak adapter, so the
suite runs offline and deterministically.
"""

from __future__ import annotations

import os
import tempfile

_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["ORBITGUARD_DATABASE_URL"] = f"sqlite:///{_DB.name}"

import httpx  # noqa: E402
import pytest  # noqa: E402
import sgp4  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.core.db import SessionLocal  # noqa: E402
from app.ingestion import celestrak  # noqa: E402
from app.ingestion.service import create_run, run_celestrak  # noqa: E402
from app.main import app  # noqa: E402
from authutil import as_role  # noqa: E402
from app.models import IngestionRun  # noqa: E402

client = TestClient(app)
as_role(client, "super_admin")
API = "/api/v1"

with open(os.path.join(os.path.dirname(sgp4.__file__), "SGP4-VER.TLE")) as fh:
    VER_TEXT = "".join(
        (ln[:69] + "\n") if ln[:2] in ("1 ", "2 ") else ln for ln in fh
    )

ISS_LIKE = (
    "ISS (ZARYA)\n"
    "1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927\n"
    "2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537\n"
)


def test_health():
    r = client.get(f"{API}/health")
    assert r.status_code == 200 and r.json()["database"] == "ok"


def test_empty_catalog_returns_real_zero_counts():
    st = client.get(f"{API}/stats").json()
    assert st["tracked_objects"] == 0 and st["newest_epoch"] is None


def test_upload_verification_set_reports_rejections_and_dedupes():
    r = client.post(f"{API}/ingestion/upload", json={"label": "vallado-verification", "text": VER_TEXT})
    assert r.status_code == 200, r.text
    run = r.json()
    assert run["status"] == "succeeded"
    assert run["records_rejected"] == 3  # the hand-edited cases 33333-33335
    # Object 20413 appears twice, byte-identical, in Vallado's file
    assert run["records_new"] == 29 and run["records_duplicate"] == 1
    again = client.post(f"{API}/ingestion/upload", json={"label": "vallado-verification", "text": VER_TEXT}).json()
    assert again["records_new"] == 0 and again["records_duplicate"] == 30


def test_upload_payload_kind_and_object_detail():
    r = client.post(f"{API}/ingestion/upload", json={"label": "iss-2008", "text": ISS_LIKE, "object_kind": "payload"}).json()
    assert r["records_new"] == 1
    d = client.get(f"{API}/objects/25544", params={"at": "2008-09-21T00:00:00Z"}).json()
    assert d["object_type"]["value"] == "PAYLOAD"
    assert d["classification"]["labels"] == ["LEO"]
    assert d["state"]["sgp4_error_code"] == 0
    assert 300 < d["state"]["geodetic"]["alt_km"] < 450
    assert d["physical_properties"]["mass_kg"] is None  # never fabricated
    assert d["element_set"]["provenance"]["provider"] == "user-upload"


def test_object_listing_filters():
    r = client.get(f"{API}/objects", params={"label": "LEO", "limit": 500}).json()
    assert r["total"] > 0 and all("LEO" in it["labels"] for it in r["items"])
    r2 = client.get(f"{API}/objects", params={"q": "25544"}).json()
    assert r2["items"][0]["norad_id"] == 25544
    assert client.get(f"{API}/objects", params={"sort": "bogus"}).status_code == 400


def test_orbit_track_and_positions():
    o = client.get(f"{API}/objects/25544/orbit", params={"start": "2008-09-21T00:00:00Z"}).json()
    assert len(o["ecef_km"]) == len(o["times"]) > 100
    assert all(o["valid"])
    p = client.get(f"{API}/positions", params={"at": "2008-09-21T00:00:00Z"}).json()
    assert p["count"] + p["failed"] == client.get(f"{API}/stats").json()["tracked_objects"]
    assert len(p["ecef_km"]) == 3 * p["count"]


def test_stats_are_computed_from_catalog():
    st = client.get(f"{API}/stats").json()
    assert st["tracked_objects"] == 30
    assert sum(st["perigee_altitude_histogram"]["counts"]) == 30
    assert st["by_label"]["LEO"] >= 1 and st["by_label"]["GEO"] >= 1


def test_classify_endpoint_modes():
    a = client.post(f"{API}/orbits/classify", json={"a_km": 7078.137, "e": 0.001, "i_deg": 98.19}).json()
    assert set(a["classification"]["labels"]) == {"LEO", "POLAR", "SSO"}
    lines = ISS_LIKE.splitlines()
    b = client.post(f"{API}/orbits/classify", json={"line1": lines[1], "line2": lines[2]}).json()
    assert b["input_kind"].startswith("SGP4 mean")
    c = client.post(f"{API}/orbits/classify", json={"r_km": [42164.17, 0, 0], "v_kms": [0, 3.0747, 0]}).json()
    assert c["classification"]["geo_type"] == "geostationary"
    bad = client.post(f"{API}/orbits/classify", json={"a_km": 7000, "e": 0.1, "i_deg": 10, "line1": "x"})
    assert bad.status_code == 422


def test_propagate_endpoint_rejects_too_many_points():
    lines = ISS_LIKE.splitlines()
    r = client.post(f"{API}/orbits/propagate", json={"line1": lines[1], "line2": lines[2], "duration_s": 86400, "step_s": 1})
    assert r.status_code == 400


# ------------------------------------------------- CelesTrak adapter
def _mock_client(status: int, body: str) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(status, text=body)))


def test_celestrak_adapter_errors_are_explicit():
    with pytest.raises(celestrak.ProviderError, match="403"):
        celestrak.fetch_group("stations", client=_mock_client(403, "Forbidden"))
    with pytest.raises(celestrak.ProviderError, match="not GP data"):
        celestrak.fetch_group("stations", client=_mock_client(200, "No GP data found"))
    with pytest.raises(celestrak.ProviderError, match="Unknown"):
        celestrak.group_url("not-a-group")


def test_celestrak_run_success_then_refresh_skip_then_failure():
    with SessionLocal() as s:
        run = create_run(s, "celestrak", "stations", celestrak.group_url("stations"))
        rid = run.id
    run_celestrak(SessionLocal, rid, "stations", client=_mock_client(200, ISS_LIKE.replace("08264.51782528", "08265.51782528").replace("2927", "2928")))
    with SessionLocal() as s:
        r = s.get(IngestionRun, rid)
        assert r.status == "succeeded", r.message
    # Immediately again -> skipped by refresh etiquette
    with SessionLocal() as s:
        rid2 = create_run(s, "celestrak", "stations", celestrak.group_url("stations")).id
    run_celestrak(SessionLocal, rid2, "stations", client=_mock_client(200, ISS_LIKE))
    with SessionLocal() as s:
        assert s.get(IngestionRun, rid2).status == "skipped"
    # Forced, but provider fails -> failed with reason
    with SessionLocal() as s:
        rid3 = create_run(s, "celestrak", "stations", celestrak.group_url("stations")).id
    run_celestrak(SessionLocal, rid3, "stations", force=True, client=_mock_client(500, "err"))
    with SessionLocal() as s:
        r3 = s.get(IngestionRun, rid3)
        assert r3.status == "failed" and "HTTP 500" in r3.message
    acts = client.get(f"{API}/ingestion/activity").json()
    assert any(a["kind"] == "ingestion.failed" for a in acts)


def test_conflicting_epoch_is_reported_not_overwritten():
    lines = ISS_LIKE.splitlines()
    altered = lines[2][:8] + "51.6500" + lines[2][15:68]
    from orbitguard_engine.tle import tle_checksum

    altered += str(tle_checksum(altered))
    text = f"{lines[0]}\n{lines[1]}\n{altered}\n"
    r = client.post(f"{API}/ingestion/upload", json={"label": "conflict", "text": text}).json()
    assert r["records_new"] == 0 and "conflicting" in (r["message"] or "")
    d = client.get(f"{API}/objects/25544").json()
    assert d["element_set"]["line2"] == lines[2]


OMM_CSV = (
    "OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,"
    "MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT\n"
    "STARLINK-37752,2026-140A,2026-10-28T08:12:33.123456,15.05,0.0001234,53.16,120.5,90.1,270.2,0,U,100048,999,1234,0.00012,0.0000123,0\n"
    "HST,1990-037B,2026-10-28T10:00:00.000000,15.28,0.0002,28.47,10.0,20.0,30.0,0,U,20580,999,5000,0.00002,0.000001,0\n"
)


def test_celestrak_omm_csv_includes_six_digit_catalog_numbers():
    with SessionLocal() as s:
        rid = create_run(s, "celestrak", "science", celestrak.group_url("science")).id
    assert "FORMAT=csv" in celestrak.group_url("science")
    run_celestrak(SessionLocal, rid, "science", client=_mock_client(200, OMM_CSV))
    with SessionLocal() as s:
        r = s.get(IngestionRun, rid)
        assert r.status == "succeeded", r.message
        assert r.records_new == 2 and r.records_rejected == 0
        import hashlib

        assert r.raw_sha256 == hashlib.sha256(OMM_CSV.encode()).hexdigest()  # raw payload provenance
    d = client.get(f"{API}/objects/100048").json()
    assert d["name"] == "STARLINK-37752" and d["element_set"]["line1"].startswith("1 A0048")
    assert d["mean_elements"]["i_deg"] == pytest.approx(53.16)
    hst = client.get(f"{API}/objects/20580").json()
    assert hst["object_type"]["value"] == "PAYLOAD" and "LEO" in hst["classification"]["labels"]


def test_providers_expose_presets():
    pr = client.get(f"{API}/ingestion/providers").json()
    ids = {g["id"] for g in pr["celestrak"]["groups"]}
    for preset in pr["celestrak"]["presets"]:
        assert set(preset["groups"]) <= ids
