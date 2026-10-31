"""Phase 4 integration: upload engineered crossing TLEs -> screen -> events -> risk."""

from __future__ import annotations

import math
import os
import tempfile
import time
from datetime import datetime, timedelta, timezone

if "ORBITGUARD_DATABASE_URL" not in os.environ:
    os.environ["ORBITGUARD_DATABASE_URL"] = f"sqlite:///{tempfile.NamedTemporaryFile(suffix='.db', delete=False).name}"

from fastapi.testclient import TestClient  # noqa: E402
from sgp4.exporter import export_tle  # noqa: E402

from app.main import app  # noqa: E402
from authutil import as_role  # noqa: E402
from orbitguard_engine.conjunction import satrec_from_elements  # noqa: E402

client = TestClient(app)
as_role(client, "super_admin")
API = "/api/v1"
EPOCH = datetime(2026, 10, 1, tzinfo=timezone.utc)
A = 7000.0
DT = 1234.5


def _tle(satnum: int, name: str, i_deg: float, m_deg: float, a=A) -> str:
    sat = satrec_from_elements(EPOCH, a, 1e-4, i_deg, 0.0, 0.0, m_deg, satnum=satnum)
    sat.intldesg, sat.classification = "26001A", "U"
    l1, l2 = export_tle(sat)
    return f"{name}\n{l1}\n{l2}\n"


def _setup_catalog():
    n_deg_s = math.degrees(math.sqrt(398600.8 / A**3))
    m0 = -n_deg_s * DT
    text = (
        _tle(90001, "TEST PRIMARY", 51.6, m0)
        + _tle(90002, "TEST CROSSER", 97.5, m0)
        + _tle(90003, "TEST FAR SAME PLANE", 51.6, m0 + 180.0)
        + _tle(90004, "TEST GEO", 0.1, 0.0, a=42164.0)
    )
    r = client.post(f"{API}/ingestion/upload", json={"label": "phase4-engineered-scenario", "text": text, "object_kind": "payload"})
    assert r.status_code == 200 and r.json()["records_new"] == 4, r.text


def _wait(run_id: int) -> dict:
    for _ in range(100):
        r = client.get(f"{API}/conjunctions/runs/{run_id}").json()
        if r["status"] in ("succeeded", "failed"):
            return r
        time.sleep(0.05)
    raise AssertionError("screening did not finish")


def test_screening_finds_engineered_crossing_and_risk_endpoint():
    _setup_catalog()
    start = (EPOCH - timedelta(minutes=10)).isoformat()
    r = client.post(f"{API}/conjunctions/screen", json={"primary_norad_id": 90001, "start": start, "horizon_h": 1.0, "threshold_km": 25, "hbr_m": 20})
    assert r.status_code == 202, r.text
    run = _wait(r.json()["run_id"])
    assert run["status"] == "succeeded", run
    assert run["stats"]["candidates_after_shell_filter"] < run["stats"]["candidates_total"]

    events = client.get(f"{API}/conjunctions", params={"run_id": run["id"]}).json()
    crossers = [e for e in events if e["secondary_norad_id"] == 90002]
    assert len(crossers) == 1
    ev = crossers[0]
    tca = datetime.fromisoformat(ev["tca"])
    assert abs((tca - (EPOCH + timedelta(seconds=DT))).total_seconds()) < 10
    assert ev["covariance_status"].startswith("unavailable")
    assert all(e["secondary_norad_id"] != 90004 for e in events)

    d = client.get(f"{API}/conjunctions/{ev['id']}").json()
    assert d["assessment"]["status"] == "covariance-unavailable" and d["assessment"]["pc"] is None
    assert len(d["relative_trajectory_rtn"]["t_s"]) > 50

    risk = client.post(
        f"{API}/conjunctions/{ev['id']}/risk",
        json={"hbr_m": 20, "primary_sigma_rtn_km": [0.1, 0.5, 0.1], "secondary_sigma_rtn_km": [0.2, 1.0, 0.2]},
    ).json()
    assert risk["status"] == "computed" and risk["covariance_source"].startswith("user-assumed")
    assert 0 <= risk["pc"] <= 1 and len(risk["sensitivity"]) == 7
    assert "saved_assessment_id" in risk
    again = client.get(f"{API}/conjunctions/{ev['id']}").json()
    assert again["saved_assessments"][0]["id"] == risk["saved_assessment_id"]


def test_risk_requires_both_or_neither_sigma_and_unknown_primary_404():
    ev = client.get(f"{API}/conjunctions").json()[0]
    bad = client.post(f"{API}/conjunctions/{ev['id']}/risk", json={"hbr_m": 20, "primary_sigma_rtn_km": [0.1, 0.1, 0.1]})
    assert bad.status_code == 400
    assert client.post(f"{API}/conjunctions/screen", json={"primary_norad_id": 123456789}).status_code == 404
