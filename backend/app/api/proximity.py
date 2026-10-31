"""Satellite selection, multi-satellite tracking, comparison and proximity detection.

Proximity is geometric (distance at a common instant, or closest approach over
a horizon). It is not a collision assessment: collision probability needs
covariance and is handled by /conjunctions.
"""

from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from orbitguard_engine.frames import FRAME_ITRF
from orbitguard_engine.propagation import SGP4_ERRORS, propagate_track, time_grid

from ..auth.deps import Principal, require
from ..core.db import SessionLocal, get_session
from ..models import ProximityJob
from ..services.catalog import catalog_cache
from ..services.proximity import (
    CATEGORIES,
    UNCERTAINTY_NOTE,
    category,
    entry_dict,
    high_priority_pairs,
    mean_summary,
    nearby,
    run_predict_job,
    state_cache,
    state_dict,
)
from ..services.timeutil import as_utc, parse_time

router = APIRouter(tags=["tracking & proximity"])

MAX_SELECTED = 25
MAX_CURRENT_RADIUS_KM = 2000.0
MAX_PREDICT_RADIUS_KM = 200.0
MAX_PREDICT_HORIZON_H = 72.0
MAX_ORBIT_POINTS = 720


def _when(at: str | None) -> datetime:
    try:
        return parse_time(at)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


def _cats(values: list[str] | str | None) -> set[str] | None:
    if not values:
        return None
    vals = values.split(",") if isinstance(values, str) else values
    out = {v.strip() for v in vals if v.strip()}
    bad = out - set(CATEGORIES)
    if bad:
        raise HTTPException(400, f"Unknown object type filter(s) {sorted(bad)}; use {sorted(CATEGORIES)}")
    return out or None


def _ids(ids: list[int]) -> list[int]:
    seen: list[int] = []
    for i in ids:
        if i not in seen:
            seen.append(i)
    if not seen:
        raise HTTPException(400, "Select at least one satellite")
    if len(seen) > MAX_SELECTED:
        raise HTTPException(400, f"At most {MAX_SELECTED} satellites at a time")
    return seen


# ------------------------------------------------------------------- search
@router.get("/objects/search")
def search(
    q: str | None = None,
    category_filter: str | None = Query(None, alias="category"),
    label: str | None = None,
    limit: int = Query(25, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _: Principal = Depends(require("catalog:read")),
    s: Session = Depends(get_session),
):
    """Fast catalogue search (name, NORAD id, COSPAR id) with object-type and orbit-class filters."""
    now = datetime.now(timezone.utc)
    cats = _cats(category_filter)
    labels = {x.strip().upper() for x in label.split(",")} if label else None
    needle = (q or "").strip().lower()
    out = []
    for e in catalog_cache.entries(s):
        if needle:
            hit = needle == str(e.norad_id) or needle in (e.name or "").lower() or needle in (e.intl_designator or "").lower() or str(e.norad_id).startswith(needle)
            if not hit:
                continue
        if cats and category(e) not in cats:
            continue
        if labels and not labels & set(e.labels):
            continue
        out.append(e)
    if needle:  # exact id / name-prefix matches first
        out.sort(key=lambda e: (str(e.norad_id) != needle, not (e.name or "").lower().startswith(needle), e.name or "", e.norad_id))
    items = []
    for e in out[offset : offset + limit]:
        d = entry_dict(e, now)
        ms = mean_summary(e)
        d.update({"perigee_alt_km": ms["perigee_alt_km"], "apogee_alt_km": ms["apogee_alt_km"], "i_deg": ms["i_deg"], "period_min": ms["period_min"]})
        items.append(d)
    return {"total": len(out), "offset": offset, "limit": limit, "items": items, "categories": CATEGORIES}


# ------------------------------------------------------------------ tracking
def _orbit(e, start: datetime, points: int = 360) -> dict:
    ms = mean_summary(e)
    period_s = (ms["period_min"] or 90.0) * 60.0
    step = max(period_s / min(points, MAX_ORBIT_POINTS), 5.0)
    tr = propagate_track(e.satrec, time_grid(start, period_s, step))
    ok = tr.errors == 0
    return {
        "frame": FRAME_ITRF,
        "start": start.isoformat(),
        "duration_s": period_s,
        "step_s": step,
        "ecef_km": np.round(tr.r_itrf, 3).tolist(),
        "valid": ok.tolist(),
        "errors": sorted({SGP4_ERRORS.get(int(c), str(c)) for c in tr.errors if c != 0}),
        "note": "One orbital period propagated with SGP4 from the selected time (Earth-fixed, so the ground track drifts).",
    }


def _tracking_item(s: Session, snap, nid: int, now: datetime, include_orbit: bool) -> dict:
    i = snap.row.get(nid) if snap else None
    if i is None:
        return {"norad_id": nid, "status": "not-in-catalog", "message": f"NORAD {nid} is not in the catalogue"}
    e = snap.entries[i]
    st = state_dict(snap, i)
    item = {
        **entry_dict(e, now),
        "status": "ok" if st["sgp4_error_code"] == 0 else "propagation-failed",
        "state": st,
        "mean_elements": mean_summary(e),
        "provenance": {"element_set_id": e.element_set_id, "epoch": e.epoch.isoformat(), "detail_endpoint": f"/api/v1/objects/{nid}"},
    }
    if include_orbit:
        item["orbit"] = _orbit(e, snap.when)
    return item


class SelectRequest(BaseModel):
    norad_id: int
    at: str | None = None
    include_orbit: bool = True


@router.post("/tracking/select")
def select_one(req: SelectRequest, _: Principal = Depends(require("catalog:read")), s: Session = Depends(get_session)):
    when = _when(req.at)
    snap = state_cache.at(s, when)
    item = _tracking_item(s, snap, req.norad_id, datetime.now(timezone.utc), req.include_orbit)
    if item["status"] == "not-in-catalog":
        raise HTTPException(404, item["message"])
    return {"time": when.isoformat(), **item}


class MultiSelectRequest(BaseModel):
    norad_ids: list[int] = Field(min_length=1)
    at: str | None = None
    include_orbit: bool = True


@router.post("/tracking/multi-select")
def select_many(req: MultiSelectRequest, _: Principal = Depends(require("catalog:read")), s: Session = Depends(get_session)):
    ids = _ids(req.norad_ids)
    when = _when(req.at)
    snap = state_cache.at(s, when)
    now = datetime.now(timezone.utc)
    return {"time": when.isoformat(), "items": [_tracking_item(s, snap, i, now, req.include_orbit) for i in ids]}


class CompareRequest(BaseModel):
    norad_ids: list[int] = Field(min_length=1)
    at: str | None = None
    radius_km: float = Field(10.0, gt=0, le=MAX_CURRENT_RADIUS_KM)
    categories: list[str] | None = None


@router.post("/tracking/compare")
def compare(req: CompareRequest, _: Principal = Depends(require("proximity:current")), s: Session = Depends(get_session)):
    ids = _ids(req.norad_ids)
    when = _when(req.at)
    cats = _cats(req.categories)
    snap = state_cache.at(s, when)
    now = datetime.now(timezone.utc)
    rows = []
    for nid in ids:
        item = _tracking_item(s, snap, nid, now, include_orbit=False)
        if item["status"] == "not-in-catalog":
            rows.append(item)
            continue
        nb = nearby(s, snap, nid, req.radius_km, cats, limit=0, offset=0)
        ms = item["mean_elements"]
        geo = item["state"].get("geodetic")
        rows.append(
            {
                "norad_id": nid,
                "name": item["name"],
                "category": item["category"],
                "labels": item["labels"],
                "status": item["status"],
                "altitude_km": geo["alt_km"] if geo else None,
                "perigee_alt_km": ms["perigee_alt_km"],
                "apogee_alt_km": ms["apogee_alt_km"],
                "inclination_deg": ms["i_deg"],
                "eccentricity": ms["e"],
                "period_min": ms["period_min"],
                "position": {"lat_deg": geo["lat_deg"], "lon_deg": geo["lon_deg"]} if geo else None,
                "speed_kms": item["state"].get("speed_kms"),
                "nearby_count": nb.get("total") if nb.get("status") == "ok" else None,
                "epoch": item["epoch"],
                "freshness": item["freshness"],
            }
        )
    return {"time": when.isoformat(), "radius_km": req.radius_km, "rows": rows}


# ---------------------------------------------------------------- proximity
@router.get("/tracking/{norad_id}/nearby")
def nearby_one(
    norad_id: int,
    at: str | None = None,
    radius_km: float = Query(10.0, gt=0, le=MAX_CURRENT_RADIUS_KM),
    categories: str | None = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _: Principal = Depends(require("proximity:current")),
    s: Session = Depends(get_session),
):
    when = _when(at)
    snap = state_cache.at(s, when)
    if snap is None:
        raise HTTPException(404, "The catalogue is empty")
    res = nearby(s, snap, norad_id, radius_km, _cats(categories), limit, offset, high_priority_pairs(s, {norad_id}))
    if res["status"] == "not-in-catalog":
        raise HTTPException(404, res["message"])
    return {**res, "uncertainty": UNCERTAINTY_NOTE}


class ScreenRequest(BaseModel):
    norad_ids: list[int] = Field(min_length=1)
    at: str | None = None
    radius_km: float = Field(10.0, gt=0, le=MAX_CURRENT_RADIUS_KM)
    categories: list[str] | None = None
    limit: int = Field(100, ge=1, le=500)
    offset: int = Field(0, ge=0)


@router.post("/proximity/screen")
def proximity_screen(req: ScreenRequest, _: Principal = Depends(require("proximity:current")), s: Session = Depends(get_session)):
    """Current proximity for one or more selected satellites at one common timestamp."""
    ids = _ids(req.norad_ids)
    when = _when(req.at)
    cats = _cats(req.categories)
    snap = state_cache.at(s, when)
    if snap is None:
        raise HTTPException(404, "The catalogue is empty")
    conj = high_priority_pairs(s, set(ids))
    results = [nearby(s, snap, i, req.radius_km, cats, req.limit, req.offset, conj) for i in ids]
    # objects near more than one selected satellite are listed under each, but counted once here
    unique: set[int] = set()
    for r in results:
        if r.get("status") == "ok":
            full = nearby(s, snap, r["norad_id"], req.radius_km, cats, limit=10**9, offset=0)
            unique |= {x["norad_id"] for x in full["items"]} - set(ids)
    return {
        "mode": "current",
        "time": when.isoformat(),
        "radius_km": req.radius_km,
        "categories": sorted(cats) if cats else None,
        "unique_nearby_objects": len(unique),
        "uncertainty": UNCERTAINTY_NOTE,
        "note": "Proximity is distance only. It is not a collision probability; see Collision Assessment for screened conjunctions.",
        "results": results,
    }


class PredictRequest(BaseModel):
    norad_ids: list[int] = Field(min_length=1)
    start: str | None = None
    horizon_h: float = Field(24.0, gt=0, le=MAX_PREDICT_HORIZON_H)
    radius_km: float = Field(10.0, gt=0, le=MAX_PREDICT_RADIUS_KM)
    step_s: float = Field(60.0, ge=10, le=300)
    categories: list[str] | None = None


def _job_dict(j: ProximityJob, limit: int | None = None, offset: int = 0) -> dict:
    out = {
        "id": j.id,
        "status": j.status,
        "progress": j.progress,
        "created_at": as_utc(j.created_at).isoformat(),
        "finished_at": as_utc(j.finished_at).isoformat() if j.finished_at else None,
        "params": j.params,
        "message": j.message,
    }
    if j.result is not None and limit is not None:
        res = dict(j.result)
        sats = []
        for r in res["satellites"]:
            r = dict(r)
            r["total"] = len(r.get("windows", []))
            r["windows"] = r.get("windows", [])[offset : offset + limit]
            sats.append(r)
        res["satellites"] = sats
        out["result"] = res
    return out


@router.post("/proximity/predict", status_code=202)
def proximity_predict(req: PredictRequest, bg: BackgroundTasks, p: Principal = Depends(require("proximity:predict")), s: Session = Depends(get_session)):
    """Future proximity over a horizon (background job; poll /proximity/jobs/{id})."""
    ids = _ids(req.norad_ids)
    start = _when(req.start)
    cats = _cats(req.categories)
    known = {e.norad_id for e in catalog_cache.entries(s)}
    missing = [i for i in ids if i not in known]
    if len(missing) == len(ids):
        raise HTTPException(404, f"None of {missing} are in the catalogue")
    job = ProximityJob(
        user_id=p.user.id,
        params={"norad_ids": ids, "start": start.isoformat(), "horizon_h": req.horizon_h, "radius_km": req.radius_km, "step_s": req.step_s,
                "categories": sorted(cats) if cats else None},
    )
    s.add(job)
    s.commit()
    bg.add_task(run_predict_job, SessionLocal, job.id)
    return {"job_id": job.id, "status": "queued"}


@router.get("/proximity/jobs")
def proximity_jobs(limit: int = Query(20, ge=1, le=100), p: Principal = Depends(require("proximity:predict")), s: Session = Depends(get_session)):
    rows = s.scalars(select(ProximityJob).where(ProximityJob.user_id == p.user.id).order_by(ProximityJob.id.desc()).limit(limit)).all()
    return [_job_dict(j) for j in rows]


@router.get("/proximity/jobs/{job_id}")
def proximity_job(job_id: int, limit: int = Query(100, ge=1, le=1000), offset: int = Query(0, ge=0),
                  p: Principal = Depends(require("proximity:predict")), s: Session = Depends(get_session)):
    j = s.get(ProximityJob, job_id)
    if j is None or (j.user_id != p.user.id and not p.can("users:manage_all")):
        raise HTTPException(404, "Job not found")
    return _job_dict(j, limit, offset)
