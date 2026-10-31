"""Tracking and proximity services on top of the in-memory catalogue.

* One vectorised SGP4 call gives every object's TEME state at a timestamp; the
  last few timestamps are cached (keyed by catalogue version), so changing the
  radius or the object-type filter does not re-propagate.
* Future proximity runs as a background job (``ProximityJob``).
"""

from __future__ import annotations

import math
import threading
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from orbitguard_engine.conjunction import Candidate, shell_radii
from orbitguard_engine.constants import RE_WGS72
from orbitguard_engine.frames import FRAME_ITRF, datetime_to_jd, ecef_to_geodetic, teme_to_itrf
from orbitguard_engine.propagation import SGP4_ERRORS
from orbitguard_engine.proximity import ALGORITHM_VERSION, ProximityConfig, current_proximity, predict_proximity

from ..models import AuditLog, ConjunctionEventRow, ProximityJob, ScreeningRun
from .catalog import CatalogEntry, catalog_cache
from .timeutil import as_utc

STALE_DAYS = 14.0

CATEGORIES = {
    "active_satellite": "Active satellite",
    "inactive_satellite": "Inactive satellite",
    "satellite_unknown_status": "Satellite (status unknown)",
    "rocket_body": "Rocket body",
    "debris": "Debris",
    "unknown": "Unknown object type",
}

UNCERTAINTY_NOTE = (
    "NOT AVAILABLE: TLE/SGP4 element sets carry no covariance, so no uncertainty is attached to these "
    "positions. Accuracy degrades as the element set ages (age shown per object)."
)


def category(e: CatalogEntry) -> str:
    t = (e.object_type or "UNKNOWN").upper()
    if t == "DEBRIS":
        return "debris"
    if t == "ROCKET BODY":
        return "rocket_body"
    if t == "PAYLOAD":
        st = (e.operational_status or "UNKNOWN").upper()
        if st == "ACTIVE":
            return "active_satellite"
        if st in ("INACTIVE", "NONOPERATIONAL", "DECAYED"):
            return "inactive_satellite"
        return "satellite_unknown_status"
    return "unknown"


def freshness(age_days: float) -> str:
    if age_days < 0:
        return "future-epoch"
    if age_days <= 3:
        return "fresh"
    if age_days <= STALE_DAYS:
        return "aging"
    return "stale"


def mean_summary(e: CatalogEntry) -> dict:
    sat = e.satrec
    a = sat.a * sat.radiusearthkm
    return {
        "a_km": a,
        "e": sat.ecco,
        "i_deg": math.degrees(sat.inclo),
        "raan_deg": math.degrees(sat.nodeo),
        "argp_deg": math.degrees(sat.argpo),
        "period_min": 2 * math.pi / sat.no_kozai if sat.no_kozai > 0 else None,
        "perigee_alt_km": a * (1 - sat.ecco) - RE_WGS72,
        "apogee_alt_km": a * (1 + sat.ecco) - RE_WGS72,
        "kind": "SGP4 mean elements (TLE)",
    }


def entry_dict(e: CatalogEntry, now: datetime) -> dict:
    age = (now - e.epoch).total_seconds() / 86400.0
    return {
        "norad_id": e.norad_id,
        "name": e.name,
        "intl_designator": e.intl_designator,
        "object_type": e.object_type,
        "operational_status": e.operational_status,
        "category": category(e),
        "category_label": CATEGORIES[category(e)],
        "labels": e.labels,
        "epoch": e.epoch.isoformat(),
        "element_set_id": e.element_set_id,
        "age_days": age,
        "freshness": freshness(age),
    }


# ------------------------------------------------------------- state cache
@dataclass
class Snapshot:
    when: datetime
    entries: list[CatalogEntry]
    err: np.ndarray  # (N,)
    r: np.ndarray  # (N, 3) TEME km
    v: np.ndarray  # (N, 3) TEME km/s
    row: dict[int, int]  # norad -> row
    jd: float
    fr: float


class StateCache:
    def __init__(self, size: int = 6) -> None:
        self._lock = threading.Lock()
        self._lru: OrderedDict = OrderedDict()
        self.size = size

    def at(self, s: Session, when: datetime) -> Snapshot | None:
        entries, arr = catalog_cache.snapshot(s)
        if arr is None:
            return None
        key = (catalog_cache.version, id(entries), when.isoformat())
        with self._lock:
            if key in self._lru:
                self._lru.move_to_end(key)
                return self._lru[key]
        jd, fr = datetime_to_jd(when)
        err, r, v = arr.sgp4(np.array([jd]), np.array([fr]))
        snap = Snapshot(when, entries, err[:, 0], r[:, 0, :], v[:, 0, :], {e.norad_id: i for i, e in enumerate(entries)}, jd, fr)
        with self._lock:
            self._lru[key] = snap
            while len(self._lru) > self.size:
                self._lru.popitem(last=False)
        return snap


state_cache = StateCache()


def _geodetic(r_teme, v_teme, jd, fr) -> dict:
    r_f, _ = teme_to_itrf(r_teme, v_teme, jd, fr)
    lat, lon, alt = ecef_to_geodetic(r_f)
    return {"lat_deg": float(lat), "lon_deg": float(lon), "alt_km": float(alt), "ecef_km": np.round(r_f, 3).tolist()}


def state_dict(snap: Snapshot, i: int) -> dict:
    code = int(snap.err[i])
    out = {"time": snap.when.isoformat(), "sgp4_error_code": code, "propagation": "ok" if code == 0 else SGP4_ERRORS.get(code, f"SGP4 error {code}")}
    if code == 0:
        out.update(
            {
                "teme": {"r_km": snap.r[i].tolist(), "v_kms": snap.v[i].tolist()},
                "geodetic": _geodetic(snap.r[i], snap.v[i], snap.jd, snap.fr),
                "speed_kms": float(np.linalg.norm(snap.v[i])),
                "itrf_frame": FRAME_ITRF,
            }
        )
    return out


def high_priority_pairs(s: Session, primary_ids: set[int]) -> dict[tuple[int, int], dict]:
    """Upcoming conjunction events from the latest screening of each primary (for red highlighting)."""
    if not primary_ids:
        return {}
    latest: dict[int, int] = {}
    for r in s.scalars(select(ScreeningRun).where(ScreeningRun.status == "succeeded", ScreeningRun.primary_norad_id.in_(primary_ids))):
        latest[r.primary_norad_id] = max(latest.get(r.primary_norad_id, 0), r.id)
    rows = s.scalars(
        select(ConjunctionEventRow).where(
            ConjunctionEventRow.run_id.in_(list(latest.values()) or [-1]),
            ConjunctionEventRow.tca >= datetime.now(timezone.utc),
        )
    ).all()
    out: dict[tuple[int, int], dict] = {}
    rank = {"HIGH": 3, "MEDIUM": 2, "LOW": 1}
    for e in rows:
        k = (e.primary_norad_id, e.secondary_norad_id)
        if k not in out or rank[e.priority] > rank[out[k]["priority"]]:
            out[k] = {"event_id": e.id, "priority": e.priority, "tca": as_utc(e.tca).isoformat(), "miss_distance_km": e.miss_distance_km}
    return out


def nearby(s: Session, snap: Snapshot, norad_id: int, radius_km: float, categories: set[str] | None, limit: int, offset: int,
           conj: dict | None = None) -> dict:
    now = datetime.now(timezone.utc)
    i = snap.row.get(norad_id)
    if i is None:
        return {"norad_id": norad_id, "status": "not-in-catalog", "message": f"NORAD {norad_id} is not in the catalogue"}
    e = snap.entries[i]
    base = {"norad_id": norad_id, "satellite": entry_dict(e, now), "state": state_dict(snap, i), "radius_km": radius_km}
    if snap.err[i] != 0:
        return {**base, "status": "propagation-failed", "message": f"SGP4 could not propagate this satellite: {SGP4_ERRORS.get(int(snap.err[i]), snap.err[i])}",
                "total": 0, "items": [], "counts": {}}
    ok = snap.err == 0
    if categories:
        cat_ok = np.array([category(x) in categories for x in snap.entries])
        ok = ok & cat_ok
    near = current_proximity(snap.r[i], snap.v[i], snap.r, snap.v, ok, radius_km, exclude=i)
    counts: dict[str, int] = {}
    for n in near:
        c = category(snap.entries[n.index])
        counts[c] = counts.get(c, 0) + 1
    page = near[offset : offset + limit]
    items = []
    for n in page:
        o = snap.entries[n.index]
        d = entry_dict(o, now)
        d.update(
            {
                "mode": "current",
                "distance_km": n.distance_km,
                "relative_speed_kms": n.v_rel_kms,
                "range_rate_kms": n.range_rate_kms,
                "motion": "closing" if n.range_rate_kms < 0 else "opening",
                "r_rel_rtn_km": n.r_rel_rtn_km,
                "position": _geodetic(snap.r[n.index], snap.v[n.index], snap.jd, snap.fr),
                "propagation": "ok",
                "conjunction": (conj or {}).get((norad_id, o.norad_id)),
            }
        )
        items.append(d)
    return {
        **base,
        "status": "ok",
        "mode": "current",
        "time": snap.when.isoformat(),
        "frame": "TEME (both objects, same instant); relative position also in the satellite's RTN frame",
        "total": len(near),
        "counts": counts,
        "offset": offset,
        "limit": limit,
        "items": items,
        "excluded_failed_propagation": int((snap.err != 0).sum()),
    }


# ---------------------------------------------------------------- predict job
def run_predict_job(session_factory, job_id: int) -> None:
    with session_factory() as s:
        job = s.get(ProximityJob, job_id)
        job.status = "running"
        s.commit()
        try:
            _predict(s, job)
        except Exception as exc:
            s.rollback()
            job = s.get(ProximityJob, job_id)
            job.status = "failed"
            job.message = f"{exc.__class__.__name__}: {exc}"
            job.finished_at = datetime.now(timezone.utc)
            s.add(AuditLog(kind="proximity.failed", message=f"Proximity prediction #{job.id} failed: {job.message}"))
            s.commit()


def _predict(s: Session, job: ProximityJob) -> None:
    p = job.params
    start = datetime.fromisoformat(p["start"])
    cfg = ProximityConfig(horizon_s=p["horizon_h"] * 3600.0, step_s=p["step_s"], radius_km=p["radius_km"])
    cats = set(p.get("categories") or []) or None
    entries = catalog_cache.entries(s)
    by_id = {e.norad_id: e for e in entries}
    now = datetime.now(timezone.utc)
    conj = high_priority_pairs(s, set(p["norad_ids"]))
    results = []
    total_ids = len(p["norad_ids"])
    for k, nid in enumerate(p["norad_ids"]):
        e = by_id.get(nid)
        if e is None:
            results.append({"norad_id": nid, "status": "not-in-catalog", "windows": [], "stats": None})
            continue
        cands = [
            Candidate(o.norad_id, o.satrec, *shell_radii(o.satrec))
            for o in entries
            if o.norad_id != nid and (cats is None or category(o) in cats)
        ]

        def prog(f, k=k):
            job.progress = (k + f) / total_ids
            s.commit()

        res = predict_proximity(e.satrec, cands, start, cfg, progress=prog)
        windows = []
        for w in res.windows:
            o = by_id[w.secondary_id]
            d = entry_dict(o, now)
            d.update({"mode": "future", **w.to_dict(), "conjunction": conj.get((nid, o.norad_id))})
            windows.append(d)
        results.append(
            {
                "norad_id": nid,
                "satellite": entry_dict(e, now),
                "status": "ok" if not res.warnings else "warnings",
                "warnings": res.warnings,
                "stats": res.stats.__dict__,
                "windows": windows,
                "unique_objects": len({w["norad_id"] for w in windows}),
            }
        )
    job.result = {
        "algorithm_version": ALGORITHM_VERSION,
        "start": start.isoformat(),
        "end": (start + timedelta(hours=p["horizon_h"])).isoformat(),
        "uncertainty": UNCERTAINTY_NOTE,
        "satellites": results,
    }
    job.status = "succeeded"
    job.progress = 1.0
    job.finished_at = datetime.now(timezone.utc)
    n = sum(len(r["windows"]) for r in results)
    s.add(AuditLog(kind="proximity.predicted", message=f"Proximity prediction #{job.id}: {n} window(s) within {p['radius_km']} km over {p['horizon_h']} h",
                   details={"job_id": job.id, "actor_user_id": job.user_id}))
    s.commit()
