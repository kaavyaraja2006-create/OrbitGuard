"""Phases 5-8 through the API: twin -> plan -> simulation -> report, transfers, research, alerts, permission upgrade."""

from __future__ import annotations

import os
import tempfile
from datetime import datetime, timezone

if "ORBITGUARD_DATABASE_URL" not in os.environ:
    os.environ["ORBITGUARD_DATABASE_URL"] = f"sqlite:///{tempfile.NamedTemporaryFile(suffix='.db', delete=False).name}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sgp4.exporter import export_tle  # noqa: E402

from app.main import app  # noqa: E402
from authutil import as_role  # noqa: E402
from orbitguard_engine.conjunction import satrec_from_elements  # noqa: E402

API = "/api/v1"
EPOCH = datetime(2026, 11, 1, tzinfo=timezone.utc)
FAST = {"n_times": 4, "n_magnitudes": 5, "refine_rounds": 2, "shortlist": 3}

sci = as_role(TestClient(app), "scientist", "twin-sci@test.local", "Twin Agency")
admin = as_role(TestClient(app), "super_admin", "twin-admin@test.local", "Platform Org")


@pytest.fixture(scope="module")
def twin():
    sat = satrec_from_elements(EPOCH, 6378.137 + 700, 1e-3, 98.19, 30.0, 0.0, 10.0, satnum=94001)
    sat.intldesg, sat.classification = "26050A", "U"
    l1, l2 = export_tle(sat)
    r = admin.post(f"{API}/ingestion/upload", json={"label": "mission-test", "text": f"MISSION TEST SAT\n{l1}\n{l2}\n", "object_kind": "payload"})
    assert r.status_code == 200 and r.json()["records_new"] == 1
    r = sci.post(f"{API}/digital-twins", json={"name": "Twin of test sat", "source": "catalog", "norad_id": 94001, "epoch": EPOCH.isoformat(),
                                               "propulsion_preset": "monoprop"})
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture(scope="module")
def plan(twin):
    body = {"twin_id": twin["id"], "start": EPOCH.isoformat(), "horizon_h": 12, "method": "proposed",
            "synthetic_threats": [{"tca_h": 5.5, "miss_m": 80, "crossing_deg": 70, "phase_deg": 10},
                                  {"tca_h": 9.2, "miss_m": 120, "crossing_deg": 120, "phase_deg": 80}],
            "optimizer": FAST, "uncertainty": {"mc_samples": 24}}
    r = sci.post(f"{API}/maneuvers/optimize", json=body)
    assert r.status_code == 202, r.text
    p = sci.get(f"{API}/maneuvers/{r.json()['plan_id']}").json()
    assert p["status"] == "succeeded", p["message"]
    return p


def test_twin_is_simulated_and_derived_from_catalogue(twin):
    assert twin["source_norad_id"] == 94001 and "SGP4 state of NORAD 94001" in twin["state_source"]
    assert twin["label"].startswith("SIMULATED")
    assert twin["config"]["mission"]["preserve_sso"] is True  # detected from the actual nodal rate
    assert twin["summary"]["dv_available_ms"] > 0 and twin["summary"]["validation_errors"] == []
    assert abs(twin["osculating_elements"]["i_deg"] - 98.19) < 0.1


def test_twin_permissions():
    pub = as_role(TestClient(app), "public", "twin-pub@test.local")
    assert pub.get(f"{API}/digital-twins").status_code == 403
    op = as_role(TestClient(app), "operator", "twin-op@test.local", "Twin Agency")
    r = op.post(f"{API}/digital-twins", json={"name": "Not mine", "source": "catalog", "norad_id": 94001, "epoch": EPOCH.isoformat()})
    assert r.status_code == 403  # not assigned to this operator
    other = as_role(TestClient(app), "scientist", "other-sci@test.local", "Elsewhere Agency")
    assert other.get(f"{API}/digital-twins").json() == []  # organisation-scoped


def test_invalid_spacecraft_is_rejected(twin):
    cfg = dict(twin["config"])
    cfg["structure"] = {**cfg["structure"], "cd": 9.0}
    r = sci.patch(f"{API}/digital-twins/{twin['id']}", json={"config": cfg})
    assert r.status_code == 422 and "Cd" in r.json()["detail"]


def test_numerical_vs_sgp4_comparison(twin):
    r = sci.post(f"{API}/digital-twins/{twin['id']}/propagate", json={"start": EPOCH.isoformat(), "horizon_h": 6, "step_s": 300})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["sgp4_comparison"]["max_km"] < 10 and len(d["alt_km"]) == len(d["t_h"])
    assert "J4" in d["force_model"]


def test_plan_selects_and_validates(plan):
    res = plan["result"]
    assert res["status"] == "selected" and plan["validation"] == "passed"
    assert res["initial_state"]["source"].startswith("SGP4 state of NORAD 94001")
    assert all(t["label"].startswith("SYNTHETIC") for t in res["threats"])
    cands = sci.get(f"{API}/maneuvers/{plan['id']}/candidates").json()
    assert cands[0]["role"] == "nominal" and cands[1]["role"] == "selected"


def test_report_contains_every_section(plan):
    r = sci.get(f"{API}/reports/{plan['id']}")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
    for h in ("Input data and provenance", "Propagation model", "Candidate comparison", "Independent validation", "Limitations"):
        assert h in r.text


def test_simulation_before_and_after(plan):
    r = sci.post(f"{API}/simulations", json={"plan_id": plan["id"]})
    assert r.status_code == 202
    sim = sci.get(f"{API}/simulations/{r.json()['simulation_id']}").json()
    assert sim["status"] == "succeeded", sim["message"]
    kinds = [t["kind"] for t in sim["trajectories"]]
    assert kinds.count("original") == 1 and kinds.count("modified") == 1 and kinds.count("threat") == 2
    n = len(sim["trajectories"][0]["ecef_km"])
    assert all(len(t["ecef_km"]) == n == len(t["vel_kms"]) for t in sim["trajectories"])
    m = {(x["name"], x["context"]["threat"] if x["context"] else None): x["value"] for x in sim["metrics"]}
    for th in ("SYNTH-T1", "SYNTH-T2"):
        assert m[("min_separation_after", th)] > m[("min_separation_before", th)]
    assert sim["config"]["maneuver"]["dv_ms"] > 0


def test_apply_books_simulated_fuel_once(twin, plan):
    before = sci.get(f"{API}/digital-twins/{twin['id']}").json()["config"]["fuel"]["propellant_remaining_kg"]
    r = sci.post(f"{API}/digital-twins/{twin['id']}/apply/{plan['id']}")
    assert r.status_code == 200
    after = r.json()["config"]["fuel"]["propellant_remaining_kg"]
    assert after == pytest.approx(before - plan["result"]["selected"]["propellant_kg"])
    assert r.json()["fuel_log"][-1]["label"] == "SIMULATED"
    assert sci.post(f"{API}/digital-twins/{twin['id']}/apply/{plan['id']}").status_code == 409


def test_transfer_lab_is_open_to_public():
    pub = as_role(TestClient(app), "public", "transfer-pub@test.local")
    r = pub.post(f"{API}/transfers", json={"kind": "hohmann", "alt1_km": 191.34411, "alt2_km": 35781.34857})
    assert r.status_code == 200
    d = r.json()
    assert d["analytical"]["dv_total_kms"] == pytest.approx(3.935224, abs=1e-5)
    assert abs(d["reached"]["a_km"] - (6378.137 + 35781.34857)) < 0.05
    assert pub.post(f"{API}/transfers", json={"kind": "raise-apogee", "alt1_km": 800, "alt2_km": 400}).status_code == 400


def test_research_run_and_permissions():
    mm = as_role(TestClient(app), "mission_manager", "res-mm@test.local", "Twin Agency")
    assert mm.post(f"{API}/research/experiments", json={"name": "E4", "seeds": 1}).status_code == 403
    r = sci.post(f"{API}/research/experiments", json={"name": "E4", "seeds": 1})
    assert r.status_code == 202
    ex = mm.get(f"{API}/research/experiments/{r.json()['experiment_id']}").json()
    assert ex["status"] == "succeeded", ex["message"]
    assert {s["method"] for s in ex["result"]["summary"]} == {"none", "fixed", "proposed"}
    csv = mm.get(f"{API}/research/experiments/{ex['id']}/csv")
    assert csv.status_code == 200 and csv.text.startswith("group,method,seed")


def test_alerts_feed(plan):
    a = sci.get(f"{API}/alerts").json()
    assert any(x["kind"] == "maneuver.selected" for x in a["items"]) and a["unread"] >= 1
    sci.post(f"{API}/alerts/read-all")
    assert sci.get(f"{API}/alerts").json()["unread"] == 0
    other = as_role(TestClient(app), "scientist", "other-sci@test.local", "Elsewhere Agency")
    assert not any(x["kind"] == "maneuver.selected" for x in other.get(f"{API}/alerts").json()["items"])


def test_permission_upgrade_keeps_admin_edits():
    """A database from before Phase 5: new permissions are granted by default, earlier edits survive."""
    from sqlalchemy import create_engine, select
    from sqlalchemy.orm import Session

    from app.auth import roles as R
    from app.auth.service import PermissionStore
    from app.core.db import Base
    from app.models import RolePermission

    eng = create_engine("sqlite://")
    Base.metadata.create_all(eng)
    with Session(eng) as s:
        # legacy matrix where an admin removed "proximity:predict" from operators
        for role, perms in R.DEFAULT_ROLE_PERMISSIONS.items():
            if role == R.SUPER_ADMIN:
                continue
            for p in perms & R.LEGACY_PERMISSIONS_V1:
                if not (role == R.OPERATOR and p == "proximity:predict"):
                    s.add(RolePermission(role=role, permission=p))
        s.commit()
        store = PermissionStore()
        store.seed(s)
        op = store.for_role(s, R.OPERATOR)
        assert "maneuver:plan" in op and "twin:read" in op  # new permissions granted
        assert "proximity:predict" not in op  # admin's earlier removal respected
        store.seed(s)  # idempotent
        assert len(s.scalars(select(RolePermission).where(RolePermission.role == R.OPERATOR)).all()) == len(op)


def test_simulation_with_alternative_candidate(plan):
    tops = plan["result"]["top_candidates"]
    k = next(i for i, c in enumerate(tops) if c["feasible"] and c["dv_rtn_ms"] != plan["result"]["selected"]["dv_rtn_ms"])
    bad = next((i for i, c in enumerate(tops) if not c["feasible"]), None)
    if bad is not None:
        assert sci.post(f"{API}/simulations", json={"plan_id": plan["id"], "alternative_index": bad}).status_code == 400
    r = sci.post(f"{API}/simulations", json={"plan_id": plan["id"], "fidelity": "optimisation", "alternative_index": k})
    assert r.status_code == 202, r.text
    sim = sci.get(f"{API}/simulations/{r.json()['simulation_id']}").json()
    assert sim["status"] == "succeeded", sim["message"]
    kinds = [t["kind"] for t in sim["trajectories"]]
    assert kinds.count("alternative") == 1 and sim["config"]["alternative"]["index"] == k
    assert all(sr["alternative_km"] is not None for sr in sim["config"]["separations"]["series"])


def test_public_showcase_is_anonymous_bounded_and_real(plan):
    anon = TestClient(app)
    r = anon.get(f"{API}/public/showcase")
    assert r.status_code == 200
    d = r.json()
    assert d["tracked_objects"] >= 1 and d["sample"]["count"] <= 600
    assert len(d["sample"]["ecef_km"]) == 3 * d["sample"]["count"] and len(d["sample"]["types"]) == d["sample"]["count"]
    assert d["tracks"] and all(len(t["ecef_km"]) % 3 == 0 for t in d["tracks"])
    # positions are physical: every sampled radius is above the Earth's surface
    import numpy as np

    radii = np.linalg.norm(np.array(d["sample"]["ecef_km"]).reshape(-1, 3), axis=1)
    assert radii.min() > 6378.0
    # nothing private leaks: only catalogue summary keys
    assert set(d) == {"generated_at", "frame", "units", "tracked_objects", "by_type", "newest_epoch", "last_ingestion", "sample", "tracks", "label"}
    # the rest of the catalogue API still needs a session
    assert anon.get(f"{API}/positions").status_code == 401


def test_density_grid_counts_match_catalogue(plan):
    d = sci.get(f"{API}/stats/density", params={"types": "PAYLOAD,DEBRIS,ROCKET BODY,UNKNOWN", "alt_max_km": 2000}).json()
    total = sum(sum(r) for r in d["counts"])
    assert total == d["plotted"] and d["plotted"] + d["outside_range"] == d["objects"] >= 1
    assert len(d["counts"]) == len(d["alt_edges_km"]) - 1 and len(d["counts"][0]) == len(d["inc_edges_deg"]) - 1
    assert TestClient(app).get(f"{API}/stats/density").status_code == 401
