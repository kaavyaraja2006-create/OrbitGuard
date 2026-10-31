"""External reference datasets: ESA Kelvins CDMs and CelesTrak SOCRATES reports.

Files are read from the local data folder (settings.data_dir, default
<repo>/data/raw). They are never uploaded anywhere and never redistributed.
"""

from __future__ import annotations

import csv
import hashlib
import io
import math
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from sqlalchemy import delete, insert, select, update
from sqlalchemy.orm import Session

from orbitguard_engine.collision import pc_2d
from orbitguard_engine.kelvins import RISK_FLOOR, geometry_from_row, infer_hbr_km, parse_socrates_name, pc
from orbitguard_engine.pair import closest_approach_near

from ..core.config import settings
from ..models import AuditLog, DatasetJob, KelvinsCdm, SocratesConjunction
from .catalog import catalog_cache
from .timeutil import as_utc

DATA_DIR: Path = settings.data_dir  # tests may override

INPUT_FIELDS = (
    ["relative_position_r", "relative_position_t", "relative_position_n", "relative_velocity_r", "relative_velocity_t", "relative_velocity_n", "t_j2k_sma"]
    + [f"{p}_{k}" for p in ("t", "c") for k in ("sigma_r", "sigma_t", "sigma_n", "ct_r", "cn_r", "cn_t")]
)
META_FIELDS = ["event_id", "time_to_tca", "mission_id", "max_risk_estimate", "miss_distance", "relative_speed", "c_object_type", "mahalanobis_distance"]
SOCRATES_HEADER = ["NORAD_CAT_ID_1", "OBJECT_NAME_1", "DSE_1", "NORAD_CAT_ID_2", "OBJECT_NAME_2", "DSE_2", "TCA", "TCA_RANGE", "TCA_RELATIVE_SPEED", "MAX_PROB", "DILUTION"]
SAME_ELEMENTS_TOL_S = 60.0


def row_from_inputs(inputs: list) -> dict:
    return dict(zip(INPUT_FIELDS, inputs))


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ------------------------------------------------------------ discovery
def discover() -> dict:
    root = DATA_DIR
    out = {"data_dir": str(root), "exists": root.exists(), "kelvins": {}, "socrates": []}
    if not root.exists():
        return out
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        n = p.name.lower()
        info = {"path": str(p.relative_to(root)), "bytes": p.stat().st_size}
        if n in ("train_data.zip", "train_data.csv"):
            out["kelvins"]["train"] = info
        elif n == "test_data.csv":
            out["kelvins"]["test"] = info
        elif n == "test_data_private.csv":
            out["kelvins"]["test_private"] = info
        elif n.endswith(".csv"):
            try:
                with open(p, encoding="utf-8", errors="replace") as fh:
                    header = fh.readline().strip().split(",")
            except OSError:
                continue
            if header[:3] == SOCRATES_HEADER[:3]:
                out["socrates"].append(info)
    out["socrates"].sort(key=lambda x: x["path"])
    return out


def _read_kelvins(path: Path) -> tuple[list[str], list[dict]]:
    """Read a Kelvins CSV (or the CSV inside a zip) with the standard library.

    pandas is deliberately not used: its compiled modules are blocked by some
    Windows application-control policies, and plain csv is fast enough here.
    """
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as zf:
            names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
            if not names:
                raise ValueError(f"{path.name} contains no CSV")
            with zf.open(names[0]) as raw:
                reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8", newline=""))
                return list(reader.fieldnames or []), list(reader)
    with open(path, encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        return list(reader.fieldnames or []), list(reader)


def _num(x) -> float | None:
    if x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(v) else v


def _finish(s: Session, job: DatasetJob, status: str, message: str | None = None, summary: dict | None = None) -> None:
    job.status = status
    job.finished_at = datetime.now(timezone.utc)
    if message:
        job.message = message
    if summary is not None:
        job.summary = summary
    s.add(AuditLog(kind=f"dataset.{job.kind}.{status}", message=f"{job.kind} #{job.id}: {status}" + (f" — {message}" if message else "")))
    s.commit()


def run_job(session_factory, job_id: int) -> None:
    with session_factory() as s:
        job = s.get(DatasetJob, job_id)
        job.status = "running"
        s.commit()
        try:
            {"kelvins-import": _kelvins_import, "socrates-import": _socrates_import, "socrates-compare": _socrates_compare}[job.kind](s, job)
        except Exception as exc:  # recorded, never swallowed
            s.rollback()
            job = s.get(DatasetJob, job_id)
            _finish(s, job, "failed", f"{exc.__class__.__name__}: {exc}")


# ------------------------------------------------------------ Kelvins
def _kelvins_import(s: Session, job: DatasetJob) -> None:
    found = discover()["kelvins"]
    if not found:
        raise FileNotFoundError(f"No Kelvins files (train_data.zip, test_data.csv, test_data_private.csv) under {DATA_DIR}")
    s.execute(delete(KelvinsCdm))  # one Kelvins import is kept at a time
    files, rows = [], []
    for split in ("train", "test", "test_private"):
        if split not in found:
            continue
        p = DATA_DIR / found[split]["path"]
        files.append({"split": split, "path": found[split]["path"], "bytes": p.stat().st_size, "sha256": _sha256(p)})
        header, data = _read_kelvins(p)
        risk_col = "true_risk" if "true_risk" in header else "risk"
        missing = [c for c in INPUT_FIELDS + META_FIELDS + [risk_col] if c not in header]
        if missing:
            raise ValueError(f"{p.name}: missing columns {missing[:6]}")
        for r in data:
            r["esa_risk"] = r.get(risk_col)
            r["split"] = split
        rows.extend(data)
    job.files = files
    s.commit()
    n = len(rows)

    # Pass 1: geometry, Mahalanobis, inferred HBR per CDM
    recs = []
    reasons: dict[str, int] = {}
    geoms = {}
    for i, row in enumerate(rows):
        g, why = geometry_from_row(row)
        status = why or "ok"
        reasons[status] = reasons.get(status, 0) + 1
        esa_risk = _num(row["esa_risk"])
        hbr = None
        if g is not None:
            geoms[i] = (g.miss2_km, g.cov2_km2)  # keep only what pass 2 needs (memory)
            h = infer_hbr_km(g, esa_risk) if esa_risk is not None else None
            hbr = h * 1000.0 if h is not None else None
        ctype = (row.get("c_object_type") or "").strip() or None
        recs.append(
            {
                "job_id": job.id,
                "split": row["split"],
                "event_id": int(float(row["event_id"])),
                "mission_id": int(float(row["mission_id"])),
                "time_to_tca_d": float(row["time_to_tca"]),
                "esa_risk": esa_risk,
                "esa_max_risk_estimate": _num(row["max_risk_estimate"]),
                "esa_mahalanobis": _num(row["mahalanobis_distance"]),
                "miss_m": _num(row["miss_distance"]),
                "relative_speed_ms": _num(row["relative_speed"]),
                "chaser_type": ctype,
                "geometry_status": status,
                "our_mahalanobis": g.mahalanobis_3d if g is not None else None,
                "inferred_hbr_m": hbr,
                "inputs": [_num(row[f]) for f in INPUT_FIELDS],
            }
        )
        if i % 2000 == 0:
            job.progress = round(0.6 * i / max(n, 1), 4)
            s.commit()
    del rows

    # Pass 2: per-mission median HBR, then our Pc for every valid CDM
    by_mission: dict[int, list[float]] = {}
    for r in recs:
        if r["inferred_hbr_m"] is not None:
            by_mission.setdefault(r["mission_id"], []).append(r["inferred_hbr_m"])
    mission_hbr = {m: float(np.median(v)) for m, v in by_mission.items()}
    for i, r in enumerate(recs):
        g = geoms.get(i)
        h = mission_hbr.get(r["mission_id"])
        if g is not None and h is not None:
            p = pc_2d(g[0], g[1], h / 1000.0)
            r["our_log10_pc"] = math.log10(p) if p > 0 else None
        else:
            r["our_log10_pc"] = None
        if i % 4000 == 0:
            job.progress = round(0.6 + 0.3 * i / n, 4)
            s.commit()

    for k in range(0, n, 5000):
        s.execute(insert(KelvinsCdm), recs[k : k + 5000])
    job.progress = 0.97
    s.commit()
    _finish(s, job, "succeeded", summary=_kelvins_summary(recs, mission_hbr, by_mission, reasons))


def _kelvins_summary(recs, mission_hbr, by_mission, reasons) -> dict:
    events = {(r["split"], r["event_id"]) for r in recs}
    maha = np.array([abs(r["our_mahalanobis"] - r["esa_mahalanobis"]) / r["esa_mahalanobis"] for r in recs if r["our_mahalanobis"] and r["esa_mahalanobis"]])
    comp = np.array([(r["esa_risk"], r["our_log10_pc"]) for r in recs if r["our_log10_pc"] is not None and r["esa_risk"] is not None and r["esa_risk"] > RISK_FLOOR and r["our_log10_pc"] > RISK_FLOOR])
    err = np.abs(comp[:, 1] - comp[:, 0]) if len(comp) else np.array([])
    hi = comp[comp[:, 0] >= -6] if len(comp) else np.empty((0, 2))
    err_hi = np.abs(hi[:, 1] - hi[:, 0]) if len(hi) else np.array([])
    missions = []
    for m, vals in sorted(by_mission.items()):
        v = np.array(vals)
        q1, q3 = np.percentile(v, [25, 75])
        missions.append(
            {
                "mission_id": m,
                "cdms_with_hbr": int(v.size),
                "median_hbr_m": float(np.median(v)),
                "iqr_hbr_m": [float(q1), float(q3)],
                "relative_spread": float((q3 - q1) / np.median(v)) if np.median(v) > 0 else None,
            }
        )

    def pct(a, x):
        return float(100.0 * np.mean(a <= x)) if a.size else None

    return {
        "cdms": len(recs),
        "events": len(events),
        "by_split": {sp: sum(1 for r in recs if r["split"] == sp) for sp in ("train", "test", "test_private")},
        "geometry_status": reasons,
        "cdms_with_inferred_hbr": sum(1 for r in recs if r["inferred_hbr_m"] is not None),
        "mahalanobis_rel_error": {
            "n": int(maha.size),
            "median": float(np.median(maha)) if maha.size else None,
            "p95": float(np.percentile(maha, 95)) if maha.size else None,
            "within_1pct": pct(maha, 0.01),
        },
        "pc_agreement": {
            "n": int(err.size),
            "median_abs_dex": float(np.median(err)) if err.size else None,
            "p90_abs_dex": float(np.percentile(err, 90)) if err.size else None,
            "within_0_1_dex_pct": pct(err, 0.1),
            "within_0_5_dex_pct": pct(err, 0.5),
            "high_risk_n": int(err_hi.size),
            "high_risk_median_abs_dex": float(np.median(err_hi)) if err_hi.size else None,
            "high_risk_within_0_1_dex_pct": pct(err_hi, 0.1),
        },
        "missions": missions,
        "method": (
            "ESA's hard-body radius is not published. It is inferred per CDM from ESA's risk value; "
            "Pc is then recomputed with each mission's median inferred HBR. Agreement therefore tests "
            "whether one HBR per mission plus this Pc model reproduces ESA's values, not an independent HBR."
        ),
    }


def kelvins_event_detail(s: Session, split: str, event_id: int) -> dict | None:
    from orbitguard_engine.collision import encounter_plane

    rows = s.scalars(
        select(KelvinsCdm).where(KelvinsCdm.split == split, KelvinsCdm.event_id == event_id).order_by(KelvinsCdm.time_to_tca_d.desc())
    ).all()
    if not rows:
        return None
    mission = rows[0].mission_id
    hbrs = [r.inferred_hbr_m for r in s.scalars(select(KelvinsCdm).where(KelvinsCdm.mission_id == mission, KelvinsCdm.inferred_hbr_m.is_not(None)))]
    mission_hbr_m = float(np.median(hbrs)) if hbrs else None
    last = rows[-1]
    plane = None
    if last.inputs and mission_hbr_m:
        g, why = geometry_from_row(row_from_inputs(last.inputs))
        if g is not None:
            _, m2 = encounter_plane(g.r_rel_km, g.v_rel_kms)
            w, V = np.linalg.eigh(g.cov2_km2)
            p = pc(g, mission_hbr_m / 1000.0)
            plane = {
                "status": "computed",
                "covariance_source": "ESA CDM (Kelvins dataset)",
                "pc": p,
                "miss_distance_km": float(np.linalg.norm(g.r_rel_km)),
                "hbr_km": mission_hbr_m / 1000.0,
                "encounter_plane_miss_km": m2.tolist(),
                "encounter_plane_cov_km2": g.cov2_km2.tolist(),
                "mahalanobis": g.mahalanobis_3d,
                "pc_max_isotropic": 0.0,
                "pc_max_sigma_km": 0.0,
                "sensitivity": [],
                "algorithm_version": "pc-2d-gauss-legendre/1.0.0",
                "assumptions": [],
                "ellipse_1sigma": {"semi_axes_km": np.sqrt(w).tolist(), "angle_deg": float(np.degrees(np.arctan2(V[1, 1], V[0, 1])))},
            }
    return {
        "split": split,
        "event_id": event_id,
        "mission_id": mission,
        "mission_median_hbr_m": mission_hbr_m,
        "chaser_type": last.chaser_type,
        "series": [
            {
                "time_to_tca_d": r.time_to_tca_d,
                "esa_risk": r.esa_risk,
                "our_log10_pc": r.our_log10_pc,
                "inferred_hbr_m": r.inferred_hbr_m,
                "miss_m": r.miss_m,
                "esa_mahalanobis": r.esa_mahalanobis,
                "our_mahalanobis": r.our_mahalanobis,
                "geometry_status": r.geometry_status,
            }
            for r in rows
        ],
        "last_cdm_plane": plane,
    }


# ------------------------------------------------------------ SOCRATES
def _parse_tca(s: str) -> datetime:
    return datetime.fromisoformat(s.strip().replace(" ", "T")).replace(tzinfo=timezone.utc)


def _socrates_import(s: Session, job: DatasetJob) -> None:
    rel = (job.params or {}).get("path")
    files = discover()["socrates"]
    if not files:
        raise FileNotFoundError(f"No SOCRATES CSV (header starting NORAD_CAT_ID_1) under {DATA_DIR}")
    if rel is None:
        rel = max(files, key=lambda f: (DATA_DIR / f["path"]).stat().st_mtime)["path"]
    path = DATA_DIR / rel
    job.files = [{"path": rel, "bytes": path.stat().st_size, "sha256": _sha256(path), "modified": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()}]
    s.commit()
    with open(path, encoding="utf-8", errors="replace", newline="") as fh:
        text = fh.read()
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None or [f.strip() for f in reader.fieldnames][: len(SOCRATES_HEADER)] != SOCRATES_HEADER:
        raise ValueError(f"Unexpected SOCRATES header: {reader.fieldnames}")
    recs, bad = [], 0
    for row in reader:
        try:
            n1, st1 = parse_socrates_name(row["OBJECT_NAME_1"])
            n2, st2 = parse_socrates_name(row["OBJECT_NAME_2"])
            recs.append(
                {
                    "job_id": job.id,
                    "norad_1": int(row["NORAD_CAT_ID_1"]),
                    "name_1": n1[:64],
                    "status_1": st1,
                    "dse_1": float(row["DSE_1"]),
                    "norad_2": int(row["NORAD_CAT_ID_2"]),
                    "name_2": n2[:64],
                    "status_2": st2,
                    "dse_2": float(row["DSE_2"]),
                    "tca": _parse_tca(row["TCA"]),
                    "range_km": float(row["TCA_RANGE"]),
                    "relative_speed_kms": float(row["TCA_RELATIVE_SPEED"]),
                    "max_prob": float(row["MAX_PROB"]),
                    "dilution_km": float(row["DILUTION"]),
                }
            )
        except (KeyError, ValueError, TypeError):
            bad += 1
    for k in range(0, len(recs), 5000):
        s.execute(insert(SocratesConjunction), recs[k : k + 5000])
        job.progress = round(min(0.99, (k + 5000) / max(len(recs), 1)), 4)
        s.commit()
    tcas = [r["tca"] for r in recs]
    _finish(
        s,
        job,
        "succeeded",
        summary={
            "rows": len(recs),
            "rows_rejected": bad,
            "tca_first": min(tcas).isoformat() if tcas else None,
            "tca_last": max(tcas).isoformat() if tcas else None,
            "min_range_km": min((r["range_km"] for r in recs), default=None),
            "note": "Units: TCA_RANGE and DILUTION in km, TCA_RELATIVE_SPEED in km/s (as published by CelesTrak).",
        },
    )


def _socrates_compare(s: Session, job: DatasetJob) -> None:
    p = job.params or {}
    import_id, limit = int(p["import_id"]), int(p.get("limit", 200))
    entries = {e.norad_id: e for e in catalog_cache.entries(s)}
    if not entries:
        raise ValueError("The catalog is empty. Ingest CelesTrak data (ideally the same day as the SOCRATES file) first.")
    rows = s.scalars(
        select(SocratesConjunction).where(SocratesConjunction.job_id == import_id).order_by(SocratesConjunction.range_km).limit(limit)
    ).all()
    counts: dict[str, int] = {}
    for i, r in enumerate(rows):
        a, b = entries.get(r.norad_1), entries.get(r.norad_2)
        upd: dict = {}
        if a is None or b is None:
            upd["compare_status"] = "object not in catalog"
        else:
            tca = as_utc(r.tca)
            # SOCRATES reports days from each element-set epoch to TCA, so its epoch = TCA - DSE.
            off1 = (a.epoch - (tca - timedelta(days=r.dse_1))).total_seconds()
            off2 = (b.epoch - (tca - timedelta(days=r.dse_2))).total_seconds()
            upd["epoch_offset_1_s"], upd["epoch_offset_2_s"] = off1, off2
            res = closest_approach_near(a.satrec, b.satrec, tca)
            if res is None:
                upd["compare_status"] = "SGP4 error"
            else:
                upd.update(our_tca=res.tca, our_range_km=res.miss_km, our_relative_speed_kms=res.relative_speed_kms)
                same = abs(off1) <= SAME_ELEMENTS_TOL_S and abs(off2) <= SAME_ELEMENTS_TOL_S
                upd["compare_status"] = "same element sets" if same else "different element sets"
        counts[upd["compare_status"]] = counts.get(upd["compare_status"], 0) + 1
        s.execute(update(SocratesConjunction).where(SocratesConjunction.id == r.id).values(**upd))
        if i % 20 == 0:
            job.progress = round(i / max(len(rows), 1), 4)
            s.commit()
    s.commit()
    _finish(s, job, "succeeded", summary={"compared": len(rows), "status_counts": counts, **socrates_stats(s, import_id)})


def socrates_stats(s: Session, import_id: int) -> dict:
    out = {}
    for label in ("same element sets", "different element sets"):
        rows = s.scalars(select(SocratesConjunction).where(SocratesConjunction.job_id == import_id, SocratesConjunction.compare_status == label)).all()
        dt = np.array([abs((as_utc(r.our_tca) - as_utc(r.tca)).total_seconds()) for r in rows])
        dr = np.array([abs(r.our_range_km - r.range_km) * 1000.0 for r in rows])
        out[label] = {
            "n": len(rows),
            "median_abs_dt_s": float(np.median(dt)) if dt.size else None,
            "p95_abs_dt_s": float(np.percentile(dt, 95)) if dt.size else None,
            "median_abs_drange_m": float(np.median(dr)) if dr.size else None,
            "p95_abs_drange_m": float(np.percentile(dr, 95)) if dr.size else None,
        }
    return out
