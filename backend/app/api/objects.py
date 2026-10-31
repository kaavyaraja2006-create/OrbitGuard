from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from orbitguard_engine.constants import MU_WGS72, RE_WGS72
from orbitguard_engine.elements import derived_parameters, rv_to_coe
from orbitguard_engine.frames import FRAME_ITRF, FRAME_TEME, datetime_to_jd, ecef_to_geodetic, teme_to_itrf
from orbitguard_engine.propagation import SGP4_ERRORS, mean_elements, propagate, propagate_many, propagate_track, satrec_from_tle, time_grid
from orbitguard_engine.tle import parse_tle

from ..core.db import get_session
from ..models import OrbitalElementSet, OrbitClassification, SpaceObject
from ..services.catalog import catalog_cache
from ..services.timeutil import as_utc, parse_time

router = APIRouter(tags=["catalog"])

MAX_TRACK_POINTS = 5000


def _latest_es(s: Session, norad_id: int) -> OrbitalElementSet | None:
    return s.scalar(
        select(OrbitalElementSet).where(OrbitalElementSet.norad_id == norad_id).order_by(OrbitalElementSet.epoch.desc()).limit(1)
    )


def _age_days(epoch: datetime, now: datetime) -> float:
    return (now - as_utc(epoch)).total_seconds() / 86400.0


def freshness(age_days: float) -> str:
    if age_days < 0:
        return "future-epoch"
    if age_days <= 3:
        return "fresh"
    if age_days <= 14:
        return "aging"
    return "stale"


@router.get("/objects")
def list_objects(
    q: str | None = None,
    object_type: str | None = None,
    label: str | None = None,
    freshness_filter: str | None = Query(None, alias="freshness"),
    sort: str = "norad_id",
    order: str = "asc",
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    s: Session = Depends(get_session),
):
    now = datetime.now(timezone.utc)
    entries = catalog_cache.entries(s)
    by_id = {e.norad_id: e for e in entries}

    stmt = (
        select(SpaceObject, OrbitalElementSet)
        .join(OrbitalElementSet, OrbitalElementSet.norad_id == SpaceObject.norad_id)
        .where(OrbitalElementSet.id.in_([e.element_set_id for e in entries] or [-1]))
    )
    if q:
        like = f"%{q.strip()}%"
        conds = [SpaceObject.name.ilike(like), SpaceObject.intl_designator.ilike(like)]
        if q.strip().isdigit():
            conds.append(SpaceObject.norad_id == int(q.strip()))
        stmt = stmt.where(or_(*conds))
    if object_type:
        types = [t.strip().upper() for t in object_type.split(",") if t.strip()]
        stmt = stmt.where(SpaceObject.object_type.in_(types))

    rows = s.execute(stmt).all()
    items = []
    for obj, es in rows:
        entry = by_id.get(obj.norad_id)
        labels = entry.labels if entry else []
        if label and label.upper() not in labels:
            continue
        age = _age_days(es.epoch, now)
        fr = freshness(age)
        if freshness_filter and fr != freshness_filter:
            continue
        items.append(
            {
                "norad_id": obj.norad_id,
                "name": obj.name,
                "intl_designator": obj.intl_designator,
                "object_type": obj.object_type,
                "operational_status": obj.operational_status,
                "labels": labels,
                "epoch": as_utc(es.epoch).isoformat(),
                "age_days": round(age, 3),
                "freshness": fr,
                "mean_a_km": es.mean_a_km,
                "mean_e": es.mean_e,
                "mean_i_deg": es.mean_i_deg,
                "perigee_alt_km": es.perigee_alt_km,
                "apogee_alt_km": es.apogee_alt_km,
                "period_min": es.period_min,
                "source": f"{es.source.provider}:{es.source.name}",
            }
        )
    keys = {"norad_id", "name", "mean_i_deg", "mean_e", "perigee_alt_km", "apogee_alt_km", "period_min", "age_days", "mean_a_km"}
    if sort not in keys:
        raise HTTPException(400, f"sort must be one of {sorted(keys)}")
    items.sort(key=lambda r: (r[sort] is None, r[sort] if r[sort] is not None else 0), reverse=(order == "desc"))
    return {"total": len(items), "offset": offset, "limit": limit, "items": items[offset : offset + limit]}


@router.get("/objects/{norad_id}")
def get_object(norad_id: int, at: str | None = None, s: Session = Depends(get_session)):
    obj = s.get(SpaceObject, norad_id)
    if obj is None:
        raise HTTPException(404, f"Object {norad_id} is not in the catalog")
    es = _latest_es(s, norad_id)
    if es is None:
        raise HTTPException(404, f"No element sets stored for {norad_id}")
    try:
        when = parse_time(at)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    epoch = as_utc(es.epoch)
    tle = parse_tle(es.line1, es.line2, obj.name)
    sat = satrec_from_tle(tle)
    me = mean_elements(sat, epoch)
    derived = derived_parameters(me.a_km, me.e, me.i_deg, mu=MU_WGS72, re=RE_WGS72)
    cls = s.scalar(select(OrbitClassification).where(OrbitClassification.element_set_id == es.id))

    sv = propagate(sat, when)
    state = {"time": when.isoformat(), "sgp4_error_code": sv.error_code, "sgp4_error": SGP4_ERRORS.get(sv.error_code, "unknown")}
    if sv.ok:
        jd, fr = datetime_to_jd(when)
        r_f, v_f = teme_to_itrf(sv.r_km, sv.v_kms, jd, fr)
        lat, lon, alt = ecef_to_geodetic(r_f)
        osc = rv_to_coe(sv.r_km, sv.v_kms, mu=MU_WGS72)
        state.update(
            {
                "teme": {"frame": FRAME_TEME, "r_km": sv.r_km.tolist(), "v_kms": sv.v_kms.tolist()},
                "itrf": {"frame": FRAME_ITRF, "r_km": r_f.tolist(), "v_kms": v_f.tolist()},
                "geodetic": {"lat_deg": float(lat), "lon_deg": float(lon), "alt_km": float(alt), "ellipsoid": "WGS-84"},
                "speed_kms": float(np.linalg.norm(sv.v_kms)),
                "osculating_elements": {**osc.to_dict(), "kind": "osculating (TEME, from SGP4 state)"},
            }
        )

    history = s.execute(
        select(OrbitalElementSet.epoch, OrbitalElementSet.perigee_alt_km, OrbitalElementSet.apogee_alt_km, OrbitalElementSet.mean_i_deg)
        .where(OrbitalElementSet.norad_id == norad_id)
        .order_by(OrbitalElementSet.epoch)
    ).all()

    now = datetime.now(timezone.utc)
    age = _age_days(epoch, now)
    return {
        "norad_id": obj.norad_id,
        "name": obj.name,
        "intl_designator": obj.intl_designator,
        "object_type": {"value": obj.object_type, "determined_by": obj.object_type_source},
        "operational_status": {"value": obj.operational_status, "determined_by": obj.operational_status_source},
        "physical_properties": {"mass_kg": None, "size_m": None, "note": "NOT AVAILABLE from TLE sources (ESA DISCOS adapter planned)"},
        "element_set": {
            "id": es.id,
            "epoch": epoch.isoformat(),
            "age_days": age,
            "freshness": freshness(age),
            "line1": es.line1,
            "line2": es.line2,
            "bstar": tle.bstar,
            "rev_number": tle.rev_number,
            "provenance": {
                "provider": es.source.provider,
                "source": es.source.name,
                "url": es.source.url,
                "retrieved_at": as_utc(es.retrieved_at).isoformat(),
                "ingestion_run_id": es.run_id,
            },
        },
        "mean_elements": {**me.__dict__, "epoch": epoch.isoformat()},
        "derived": derived.to_dict(),
        "classification": cls.result if cls else None,
        "state": state,
        "history": [
            {"epoch": as_utc(h[0]).isoformat(), "perigee_alt_km": h[1], "apogee_alt_km": h[2], "mean_i_deg": h[3]} for h in history
        ],
    }


@router.get("/objects/{norad_id}/orbit")
def object_orbit(
    norad_id: int,
    start: str | None = None,
    duration_s: float | None = Query(None, gt=0),
    step_s: float | None = Query(None, gt=0),
    s: Session = Depends(get_session),
):
    es = _latest_es(s, norad_id)
    if es is None:
        raise HTTPException(404, f"No element sets stored for {norad_id}")
    try:
        t0 = parse_time(start)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    period_s = es.period_min * 60.0
    duration = duration_s or period_s
    step = step_s or max(period_s / 240.0, 10.0)
    if duration / step + 1 > MAX_TRACK_POINTS:
        raise HTTPException(400, f"Requested {int(duration / step) + 1} points; maximum is {MAX_TRACK_POINTS}")
    sat = satrec_from_tle(parse_tle(es.line1, es.line2))
    tr = propagate_track(sat, time_grid(t0, duration, step))
    ok = tr.errors == 0
    return {
        "norad_id": norad_id,
        "element_set_id": es.id,
        "frame": FRAME_ITRF,
        "units": "km",
        "start": t0.isoformat(),
        "step_s": step,
        "times": [t.isoformat() for t in tr.times],
        "ecef_km": np.round(tr.r_itrf, 4).tolist(),
        "lat_deg": np.round(tr.lat_deg, 5).tolist(),
        "lon_deg": np.round(tr.lon_deg, 5).tolist(),
        "alt_km": np.round(tr.alt_km, 4).tolist(),
        "valid": ok.tolist(),
        "errors": sorted({SGP4_ERRORS.get(int(c), str(c)) for c in tr.errors if c != 0}),
    }


@router.get("/positions")
def positions(at: str | None = None, s: Session = Depends(get_session)):
    """Earth-fixed positions of every catalog object at one instant (vectorised SGP4)."""
    try:
        when = parse_time(at)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    entries, arr = catalog_cache.snapshot(s)
    if arr is None:
        return {"time": when.isoformat(), "frame": FRAME_ITRF, "units": "km", "count": 0, "failed": 0, "norad_ids": [], "types": [], "ecef_km": []}
    jd, fr = datetime_to_jd(when)
    err, r, v = arr.sgp4(np.array([jd]), np.array([fr]))
    r_itrf, _ = teme_to_itrf(r[:, 0, :], v[:, 0, :], jd, fr)
    r_itrf = np.atleast_2d(r_itrf)
    ok = err[:, 0] == 0
    idx = np.nonzero(ok)[0]
    return {
        "time": when.isoformat(),
        "frame": FRAME_ITRF,
        "units": "km",
        "count": int(ok.sum()),
        "failed": int((~ok).sum()),
        "norad_ids": [entries[i].norad_id for i in idx],
        "types": [entries[i].object_type for i in idx],
        "ecef_km": np.round(r_itrf[idx], 3).ravel().tolist(),
    }


@router.get("/stats")
def stats(s: Session = Depends(get_session)):
    now = datetime.now(timezone.utc)
    entries = catalog_cache.entries(s)
    by_type: dict[str, int] = {}
    by_label = {k: 0 for k in ("LEO", "MEO", "GEO", "POLAR", "SSO", "HEO")}
    combos: dict[str, int] = {}
    fresh = {"fresh": 0, "aging": 0, "stale": 0, "future-epoch": 0}
    for e in entries:
        by_type[e.object_type] = by_type.get(e.object_type, 0) + 1
        for lb in e.labels:
            by_label[lb] = by_label.get(lb, 0) + 1
        key = " + ".join(e.labels) if e.labels else "UNCLASSIFIED"
        combos[key] = combos.get(key, 0) + 1
        fresh[freshness(_age_days(e.epoch, now))] += 1
    n_sets = s.scalar(select(func.count(OrbitalElementSet.id))) or 0
    newest = max((e.epoch for e in entries), default=None)
    alt_hist = s.execute(
        select(OrbitalElementSet.perigee_alt_km).where(OrbitalElementSet.id.in_([e.element_set_id for e in entries] or [-1]))
    ).scalars().all()
    inc_hist = s.execute(
        select(OrbitalElementSet.mean_i_deg).where(OrbitalElementSet.id.in_([e.element_set_id for e in entries] or [-1]))
    ).scalars().all()
    alt_edges = [-10000, 0, 300, 400, 500, 600, 700, 800, 1000, 1200, 1500, 2000, 10000, 20000, 30000, 35000, 37000, 1e6]
    alt_counts = np.histogram(alt_hist, bins=alt_edges)[0].tolist() if alt_hist else [0] * (len(alt_edges) - 1)
    inc_edges = list(range(0, 181, 10))
    inc_counts = np.histogram(inc_hist, bins=inc_edges)[0].tolist() if inc_hist else [0] * 18
    return {
        "generated_at": now.isoformat(),
        "tracked_objects": len(entries),
        "element_sets_stored": n_sets,
        "by_type": by_type,
        "by_label": by_label,
        "label_combinations": dict(sorted(combos.items(), key=lambda kv: -kv[1])[:12]),
        "freshness": fresh,
        "newest_epoch": newest.isoformat() if newest else None,
        "perigee_altitude_histogram": {"edges_km": alt_edges, "counts": alt_counts},
        "inclination_histogram": {"edges_deg": inc_edges, "counts": inc_counts},
    }


@router.get("/stats/density")
def density(
    types: str = "DEBRIS,ROCKET BODY,UNKNOWN",
    alt_max_km: float = Query(2000.0, gt=100, le=50000),
    alt_bin_km: float = Query(50.0, gt=1, le=5000),
    inc_bin_deg: float = Query(5.0, gt=0.5, le=45),
    s: Session = Depends(get_session),
):
    """Perigee-altitude x inclination counts for the selected object types (catalogue mean elements)."""
    wanted = {t.strip().upper() for t in types.split(",") if t.strip()}
    entries = [e for e in catalog_cache.entries(s) if e.object_type in wanted]
    ids = [e.element_set_id for e in entries] or [-1]
    rows = s.execute(select(OrbitalElementSet.perigee_alt_km, OrbitalElementSet.mean_i_deg).where(OrbitalElementSet.id.in_(ids))).all()
    alt = np.array([r[0] for r in rows], dtype=float)
    inc = np.array([r[1] for r in rows], dtype=float)
    alt_edges = np.arange(0.0, alt_max_km + alt_bin_km / 2, alt_bin_km)
    inc_edges = np.arange(0.0, 180.0 + inc_bin_deg / 2, inc_bin_deg)
    inside = (alt >= 0) & (alt <= alt_max_km)
    counts = np.histogram2d(alt[inside], inc[inside], bins=[alt_edges, inc_edges])[0].astype(int) if inside.any() else np.zeros((len(alt_edges) - 1, len(inc_edges) - 1), int)
    return {
        "types": sorted(wanted),
        "objects": len(rows),
        "plotted": int(inside.sum()),
        "outside_range": int((~inside).sum()),
        "alt_edges_km": alt_edges.tolist(),
        "inc_edges_deg": inc_edges.tolist(),
        "counts": counts.tolist(),
        "source": "latest element set per object; perigee altitude and inclination from SGP4 mean elements",
    }
