from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from orbitguard_engine.collision import ALGORITHM_VERSION as PC_VERSION
from orbitguard_engine.collision import assess, diag_cov, rtn_to_inertial_cov
from orbitguard_engine.conjunction import relative_trajectory
from orbitguard_engine.propagation import satrec_from_tle
from orbitguard_engine.tle import parse_tle

from ..auth.deps import Principal, require, satellite_scope
from ..core.db import SessionLocal, get_session
from ..models import AuditLog, CollisionAssessmentRow, ConjunctionEventRow, OrbitalElementSet, ScreeningRun, SpaceObject
from ..services.catalog import catalog_cache
from ..services.screening import run_screening
from ..services.timeutil import as_utc, parse_time

router = APIRouter(prefix="/conjunctions", tags=["conjunctions"])

MAX_HORIZON_H = 7 * 24


class ScreenRequest(BaseModel):
    primary_norad_id: int
    start: str | None = None
    horizon_h: float = Field(24.0, gt=0, le=MAX_HORIZON_H)
    step_s: float = Field(60.0, ge=5, le=600)
    threshold_km: float = Field(10.0, gt=0, le=200)
    hbr_m: float = Field(20.0, gt=0, le=500, description="Combined hard-body radius")


def _run_dict(r: ScreeningRun, names: dict[int, str | None] | None = None) -> dict:
    return {
        "id": r.id,
        "primary_norad_id": r.primary_norad_id,
        "primary_name": (names or {}).get(r.primary_norad_id),
        "start": as_utc(r.start).isoformat(),
        "horizon_h": r.horizon_s / 3600.0,
        "step_s": r.step_s,
        "threshold_km": r.threshold_km,
        "hbr_m": r.hbr_km * 1000.0,
        "status": r.status,
        "progress": r.progress,
        "created_at": as_utc(r.created_at).isoformat(),
        "finished_at": as_utc(r.finished_at).isoformat() if r.finished_at else None,
        "stats": r.stats,
        "warnings": r.warnings or [],
        "message": r.message,
        "algorithm_version": r.algorithm_version,
    }


def _names(s: Session, ids: set[int]) -> dict[int, str | None]:
    if not ids:
        return {}
    return {o.norad_id: o.name for o in s.scalars(select(SpaceObject).where(SpaceObject.norad_id.in_(ids)))}


def _event_dict(e: ConjunctionEventRow, names: dict[int, str | None], epochs: dict[int, datetime]) -> dict:
    tca = as_utc(e.tca)
    span = [abs((tca - epochs[i]).total_seconds()) / 86400.0 for i in (e.primary_element_set_id, e.secondary_element_set_id) if i in epochs]
    max_span = max(span) if span else None
    return {
        "id": e.id,
        "run_id": e.run_id,
        "primary_norad_id": e.primary_norad_id,
        "primary_name": names.get(e.primary_norad_id),
        "secondary_norad_id": e.secondary_norad_id,
        "secondary_name": names.get(e.secondary_norad_id),
        "tca": tca.isoformat(),
        "miss_distance_km": e.miss_distance_km,
        "relative_speed_kms": e.relative_speed_kms,
        "approach_angle_deg": e.approach_angle_deg,
        "miss_rtn_km": e.miss_rtn_km,
        "priority": e.priority,
        "pc_max_isotropic": e.pc_max_isotropic,
        "covariance_status": "unavailable (TLE data carries no covariance)",
        "prediction_span_days": max_span,
        "data_confidence": None if max_span is None else ("adequate" if max_span <= 3 else "reduced" if max_span <= 7 else "low"),
    }


@router.post("/screen", status_code=202)
def start_screening(req: ScreenRequest, bg: BackgroundTasks, p: Principal = Depends(require("conjunction:screen")), s: Session = Depends(get_session)):
    scope = satellite_scope(p, s)
    if scope is not None and req.primary_norad_id not in scope:
        raise HTTPException(403, f"NORAD {req.primary_norad_id} is not one of your assigned satellites")
    entry = next((e for e in catalog_cache.entries(s) if e.norad_id == req.primary_norad_id), None)
    if entry is None:
        raise HTTPException(404, f"Object {req.primary_norad_id} is not in the catalog")
    try:
        start = parse_time(req.start)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    run = ScreeningRun(
        primary_norad_id=req.primary_norad_id,
        primary_element_set_id=entry.element_set_id,
        start=start,
        horizon_s=req.horizon_h * 3600.0,
        step_s=req.step_s,
        threshold_km=req.threshold_km,
        hbr_km=req.hbr_m / 1000.0,
    )
    s.add(run)
    s.flush()
    s.add(AuditLog(kind="screening.queued", message=f"Screening #{run.id} of NORAD {req.primary_norad_id} queued by {p.user.email}",
                   details={"actor_user_id": p.user.id, "actor_email": p.user.email, "run_id": run.id}))
    s.commit()
    bg.add_task(run_screening, SessionLocal, run.id)
    return {"run_id": run.id, "status": "queued"}


@router.get("/runs")
def list_runs(limit: int = 30, p: Principal = Depends(require("conjunction:read")), s: Session = Depends(get_session)):
    stmt = select(ScreeningRun)
    scope = satellite_scope(p, s)
    if scope is not None:
        stmt = stmt.where(ScreeningRun.primary_norad_id.in_(scope or {-1}))
    runs = s.scalars(stmt.order_by(ScreeningRun.id.desc()).limit(min(limit, 200))).all()
    names = _names(s, {r.primary_norad_id for r in runs})
    return [_run_dict(r, names) for r in runs]


@router.get("/runs/{run_id}")
def get_run(run_id: int, p: Principal = Depends(require("conjunction:read")), s: Session = Depends(get_session)):
    r = s.get(ScreeningRun, run_id)
    scope = satellite_scope(p, s)
    if r is None or (scope is not None and r.primary_norad_id not in scope):
        raise HTTPException(404, "Screening run not found")
    return _run_dict(r, _names(s, {r.primary_norad_id}))


@router.get("")
def list_events(
    run_id: int | None = None,
    primary_norad_id: int | None = None,
    upcoming_only: bool = False,
    latest_run_per_primary: bool = False,
    limit: int = 200,
    p: Principal = Depends(require("conjunction:read")),
    s: Session = Depends(get_session),
):
    stmt = select(ConjunctionEventRow)
    scope = satellite_scope(p, s)
    if scope is not None:  # operators: events of their assigned satellites only
        stmt = stmt.where(ConjunctionEventRow.primary_norad_id.in_(scope or {-1}))
    if run_id is not None:
        stmt = stmt.where(ConjunctionEventRow.run_id == run_id)
    if primary_norad_id is not None:
        stmt = stmt.where(ConjunctionEventRow.primary_norad_id == primary_norad_id)
    if upcoming_only:
        stmt = stmt.where(ConjunctionEventRow.tca >= datetime.now(timezone.utc))
    if latest_run_per_primary:
        latest: dict[int, int] = {}
        for r in s.scalars(select(ScreeningRun).where(ScreeningRun.status == "succeeded")):
            latest[r.primary_norad_id] = max(latest.get(r.primary_norad_id, 0), r.id)
        stmt = stmt.where(ConjunctionEventRow.run_id.in_(list(latest.values()) or [-1]))
    rows = s.scalars(stmt.order_by(ConjunctionEventRow.tca).limit(min(limit, 1000))).all()
    names = _names(s, {r.primary_norad_id for r in rows} | {r.secondary_norad_id for r in rows})
    es_ids = {r.primary_element_set_id for r in rows} | {r.secondary_element_set_id for r in rows}
    epochs = {i: as_utc(ep) for i, ep in s.execute(select(OrbitalElementSet.id, OrbitalElementSet.epoch).where(OrbitalElementSet.id.in_(es_ids or [-1])))}
    return [_event_dict(r, names, epochs) for r in rows]


def _load_event(s: Session, event_id: int, p: Principal):
    e = s.get(ConjunctionEventRow, event_id)
    scope = satellite_scope(p, s)
    if e is None or (scope is not None and e.primary_norad_id not in scope):
        raise HTTPException(404, "Conjunction event not found")
    p_es = s.get(OrbitalElementSet, e.primary_element_set_id)
    s_es = s.get(OrbitalElementSet, e.secondary_element_set_id)
    return e, p_es, s_es


@router.get("/{event_id}")
def get_event(event_id: int, p: Principal = Depends(require("conjunction:read")), s: Session = Depends(get_session)):
    e, p_es, s_es = _load_event(s, event_id, p)
    run = s.get(ScreeningRun, e.run_id)
    names = _names(s, {e.primary_norad_id, e.secondary_norad_id})
    epochs = {p_es.id: as_utc(p_es.epoch), s_es.id: as_utc(s_es.epoch)}
    p_sat = satrec_from_tle(parse_tle(p_es.line1, p_es.line2))
    s_sat = satrec_from_tle(parse_tle(s_es.line1, s_es.line2))
    window = max(60.0, min(600.0, 300.0 / max(e.relative_speed_kms, 0.05)))
    traj = relative_trajectory(p_sat, s_sat, as_utc(e.tca), half_window_s=window, step_s=window / 60.0)
    g = e.geometry
    base = assess(g["r_rel_km"], g["v_rel_kms"], run.hbr_km)
    history = s.scalars(select(CollisionAssessmentRow).where(CollisionAssessmentRow.event_id == e.id).order_by(CollisionAssessmentRow.id.desc()).limit(10)).all()
    return {
        **_event_dict(e, names, epochs),
        "hbr_m": run.hbr_km * 1000.0,
        "geometry": g,
        "relative_trajectory_rtn": {**traj, "frame": "primary RTN", "units": "km, s from TCA"},
        "assessment": base.to_dict(),
        "element_sets": {
            "primary": {"id": p_es.id, "epoch": epochs[p_es.id].isoformat(), "source": f"{p_es.source.provider}:{p_es.source.name}"},
            "secondary": {"id": s_es.id, "epoch": epochs[s_es.id].isoformat(), "source": f"{s_es.source.provider}:{s_es.source.name}"},
        },
        "screening": _run_dict(run),
        "saved_assessments": [
            {"id": h.id, "created_at": as_utc(h.created_at).isoformat(), "covariance_source": h.covariance_source, "inputs": h.inputs, "pc": h.result.get("pc")}
            for h in history
        ],
    }


class RiskRequest(BaseModel):
    hbr_m: float = Field(gt=0, le=500)
    primary_sigma_rtn_km: list[float] | None = Field(None, min_length=3, max_length=3)
    secondary_sigma_rtn_km: list[float] | None = Field(None, min_length=3, max_length=3)


@router.post("/{event_id}/risk")
def compute_risk(event_id: int, req: RiskRequest, p: Principal = Depends(require("risk:assess")), s: Session = Depends(get_session)):
    """Pc with USER-ASSUMED 1-sigma RTN uncertainties. Labelled as assumed; stored for audit."""
    e, _, _ = _load_event(s, event_id, p)
    g = e.geometry
    hbr = req.hbr_m / 1000.0
    have = req.primary_sigma_rtn_km is not None and req.secondary_sigma_rtn_km is not None
    if (req.primary_sigma_rtn_km is None) != (req.secondary_sigma_rtn_km is None):
        raise HTTPException(400, "Provide sigmas for both objects, or for neither")
    if have and min(req.primary_sigma_rtn_km + req.secondary_sigma_rtn_km) <= 0:
        raise HTTPException(400, "All sigmas must be positive")
    kw = {}
    if have:
        kw = dict(
            cov_primary_inertial=rtn_to_inertial_cov(g["primary_r_km"], g["primary_v_kms"], diag_cov(*req.primary_sigma_rtn_km)),
            cov_secondary_inertial=rtn_to_inertial_cov(g["secondary_r_km"], g["secondary_v_kms"], diag_cov(*req.secondary_sigma_rtn_km)),
            covariance_source="user-assumed RTN 1-sigma (not from data)",
        )
    try:
        res = assess(g["r_rel_km"], g["v_rel_kms"], hbr, **kw)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    out = res.to_dict()
    if have:
        row = CollisionAssessmentRow(
            event_id=e.id,
            hbr_km=hbr,
            covariance_source=res.covariance_source,
            inputs=req.model_dump(),
            result=out,
            algorithm_version=PC_VERSION,
        )
        s.add(row)
        s.add(AuditLog(kind="assessment.computed", message=f"Pc for event #{e.id} with assumed covariance: {res.pc:.3e}",
                           details={"actor_user_id": p.user.id, "actor_email": p.user.email, "event_id": e.id}))
        s.commit()
        out["saved_assessment_id"] = row.id
    if res.encounter_plane_cov_km2 is not None:
        C = np.array(res.encounter_plane_cov_km2)
        w, V = np.linalg.eigh(C)
        out["ellipse_1sigma"] = {"semi_axes_km": np.sqrt(w).tolist(), "angle_deg": float(np.degrees(np.arctan2(V[1, 1], V[0, 1])))}
    return out
