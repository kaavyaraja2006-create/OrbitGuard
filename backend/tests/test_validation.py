"""External-dataset validation: Kelvins import + SOCRATES import/compare, offline.

Builds a temporary data folder laid out like the real one:
  kelvins_competition_data/{train_data.zip, test_data.csv, test_data_private.csv}
  sort-minRange.csv
"""

from __future__ import annotations

import csv
import math
import os
import sys
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

if "ORBITGUARD_DATABASE_URL" not in os.environ:
    os.environ["ORBITGUARD_DATABASE_URL"] = f"sqlite:///{tempfile.NamedTemporaryFile(suffix='.db', delete=False).name}"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sgp4.exporter import export_tle  # noqa: E402

from app.main import app  # noqa: E402
from authutil import as_role  # noqa: E402
from app.services import datasets  # noqa: E402
from orbitguard_engine.conjunction import satrec_from_elements  # noqa: E402
from orbitguard_engine.kelvins import geometry_from_row, pc  # noqa: E402
from orbitguard_engine.pair import closest_approach_near  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scientific-engine" / "tests"))
from test_kelvins_pair import ROW_PRIVATE, ROW_TEST  # noqa: E402  (real Kelvins rows)

client = TestClient(app)
as_role(client, "super_admin")
API = "/api/v1/validation"
TRUE_HBR_M = {7: 3.0, 8: 5.0, 9: 10.0}

META = {"time_to_tca": 1.0, "max_risk_estimate": -6.0, "miss_distance": 31816.0, "relative_speed": 7929.0, "c_object_type": "DEBRIS"}


def _kelvins_rows():
    rows = []
    ev = 0
    for mission, hbr in TRUE_HBR_M.items():
        for k, scale in enumerate([0.6, 0.8, 1.0, 1.2, 1.5]):
            r = dict(ROW_TEST)
            for a in "rtn":
                r[f"relative_position_{a}"] = ROW_TEST[f"relative_position_{a}"] * scale
            g = geometry_from_row(r)[0]
            r["risk"] = math.log10(pc(g, hbr / 1000.0))  # ESA-consistent by construction
            r["mahalanobis_distance"] = g.mahalanobis_3d
            rows.append({**META, **r, "event_id": ev, "mission_id": mission, "time_to_tca": 5 - k})
        ev += 1
    bad = {**META, **ROW_TEST, "event_id": 99, "mission_id": 7, "c_sigma_t": ""}
    floor = {**META, **ROW_TEST, "event_id": 98, "mission_id": 7, "risk": -30.0}
    return rows + [bad, floor]


def _write_csv(path: Path, rows: list[dict], risk_col: str = "risk"):
    cols = list(dict.fromkeys(k for r in rows for k in r))
    if risk_col != "risk":
        cols = [risk_col if c == "risk" else c for c in cols]
        rows = [{(risk_col if k == "risk" else k): v for k, v in r.items()} for r in rows]
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)


@pytest.fixture(scope="module")
def data_dir(tmp_path_factory):
    root = tmp_path_factory.mktemp("raw")
    kd = root / "kelvins_competition_data"
    kd.mkdir()
    tmp_csv = root / "train_data.csv"
    _write_csv(tmp_csv, _kelvins_rows())
    with zipfile.ZipFile(kd / "train_data.zip", "w") as zf:
        zf.write(tmp_csv, "train_data.csv")
    tmp_csv.unlink()
    _write_csv(kd / "test_data.csv", [{**META, **ROW_TEST, "event_id": 0, "mission_id": 19}])
    _write_csv(kd / "test_data_private.csv", [{**META, **ROW_PRIVATE, "event_id": 0, "mission_id": 19, "time_to_tca": 0.26}], risk_col="true_risk")
    old = datasets.DATA_DIR
    datasets.DATA_DIR = root
    yield root
    datasets.DATA_DIR = old


def test_discovery(data_dir):
    f = client.get(f"{API}/files").json()
    assert set(f["kelvins"]) == {"train", "test", "test_private"}
    assert f["socrates"] == []


def test_kelvins_import_recovers_hbr_and_matches_esa(data_dir):
    r = client.post(f"{API}/kelvins/import")
    assert r.status_code == 202, r.text
    job = client.get(f"{API}/jobs/{r.json()['job_id']}").json()
    assert job["status"] == "succeeded", job["message"]
    sm = job["summary"]
    assert sm["cdms"] == 15 + 2 + 2
    assert sm["geometry_status"]["missing value"] == 1
    med = {m["mission_id"]: m["median_hbr_m"] for m in sm["missions"]}
    for mission, hbr in TRUE_HBR_M.items():
        assert med[mission] == pytest.approx(hbr, rel=1e-3)
    assert 2.5 < med[19] < 4.0  # the two real ESA rows
    assert sm["pc_agreement"]["median_abs_dex"] < 0.01
    assert sm["mahalanobis_rel_error"]["within_1pct"] == 100.0
    assert all(f["sha256"] for f in job["files"])  # provenance recorded

    ev = client.get(f"{API}/kelvins/events", params={"mission_id": 8}).json()
    assert len(ev) == 1 and ev[0]["cdm_count"] == 5  # one event per mission, five CDMs each
    d = client.get(f"{API}/kelvins/events/test/0").json()
    assert d["last_cdm_plane"]["covariance_source"].startswith("ESA CDM")
    assert d["last_cdm_plane"]["ellipse_1sigma"]["semi_axes_km"][1] > 0
    sc = client.get(f"{API}/kelvins/scatter").json()
    assert sc["total"] >= 15


def test_socrates_import_and_compare(data_dir):
    epoch = datetime(2026, 10, 30, 12, tzinfo=timezone.utc)
    a_km, dt = 7000.0, 2000.0
    m0 = (-math.degrees(math.sqrt(398600.8 / a_km**3)) * dt) % 360
    sats = []
    text = ""
    for norad, inc in ((91001, 51.6), (91002, 97.5)):
        s = satrec_from_elements(epoch, a_km, 1e-4, inc, 0.0, 0.0, m0, satnum=norad)
        s.intldesg, s.classification = "26001A", "U"
        l1, l2 = export_tle(s)
        text += f"VAL-{norad}\n{l1}\n{l2}\n"
        sats.append(s)
    up = client.post("/api/v1/ingestion/upload", json={"label": "validation-test", "text": text}).json()
    assert up["records_new"] == 2
    from orbitguard_engine.propagation import satrec_from_tle
    from orbitguard_engine.tle import parse_tle_text

    t = parse_tle_text(text).tles
    approach = closest_approach_near(satrec_from_tle(t[0]), satrec_from_tle(t[1]), epoch + timedelta(seconds=dt))
    tca = approach.tca
    dse = (tca - t[0].epoch).total_seconds() / 86400.0
    socr = data_dir / "sort-minRange.csv"
    with open(socr, "w", newline="") as fh:
        fh.write("NORAD_CAT_ID_1,OBJECT_NAME_1,DSE_1,NORAD_CAT_ID_2,OBJECT_NAME_2,DSE_2,TCA,TCA_RANGE,TCA_RELATIVE_SPEED,MAX_PROB,DILUTION\n")
        fh.write(f"91001,VAL-91001 [+],{dse:.3f},91002,VAL-91002 [-],{dse:.3f},{tca.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]},{approach.miss_km:.3f},{approach.relative_speed_kms:.3f},1.000E-03,0.010\n")
        fh.write("57380,STARLINK-6366 [+],3.903,67294,SITRO-AIS-63 [+],4.102,2026-11-02 01:39:59.913,0.011,9.858,1.000E+00,0.000\n")
    assert len(client.get(f"{API}/files").json()["socrates"]) == 1

    imp = client.post(f"{API}/socrates/import", json={}).json()
    j = client.get(f"{API}/jobs/{imp['job_id']}").json()
    assert j["status"] == "succeeded" and j["summary"]["rows"] == 2

    cmp_ = client.post(f"{API}/socrates/compare", json={"import_id": imp["job_id"], "limit": 10}).json()
    cj = client.get(f"{API}/jobs/{cmp_['job_id']}").json()
    assert cj["status"] == "succeeded", cj["message"]
    rows = {r["norad_1"]: r for r in client.get(f"{API}/socrates/conjunctions", params={"import_id": imp["job_id"]}).json()}
    assert rows[57380]["compare_status"] == "object not in catalog"
    r = rows[91001]
    # DSE is printed with 3 decimals (~86 s), so element-set matching is checked at that resolution
    assert r["compare_status"] in ("same element sets", "different element sets")
    assert abs(r["dt_s"]) < 0.01
    assert abs(r["our_range_km"] - r["range_km"]) < 0.001
