"""Phase 5-8 API: digital twins, maneuver optimisation, simulations, transfer lab, research, reports, alerts."""

from __future__ import annotations

import math
from datetime import datetime, timezone

import numpy as np
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse, PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from orbitguard_engine.constants import R_EARTH
from orbitguard_engine.elements import coe_to_rv, rv_to_coe
from orbitguard_engine.experiments import EXPERIMENTS, to_csv
from orbitguard_engine.forces import ForceModel
from orbitguard_engine.frames import FRAME_TEME, datetime_to_jd
from orbitguard_engine.maneuver import screen_trajectory, time_grid
from orbitguard_engine.numerical import Body, propagate
from orbitguard_engine.spacecraft import DIRECTIONS, PROPULSION_PRESETS, Propulsion, SpacecraftConfig
from orbitguard_engine.transfer import PRESETS as TRANSFER_PRESETS
from orbitguard_engine.transfer import TransferRequest, fly

from ..auth import roles as R
from ..auth.deps import Principal, require
from ..auth.service import assigned_norad_ids, audit
from ..core.db import SessionLocal, get_session
from ..models import (
    AlertRead,
    DigitalTwin,
    ExperimentRun,
    ManeuverCandidate,
    ManeuverPlan,
    OrbitalState,
    PropulsionModel,
    SimulationMetric,
    SimulationRun,
    SimulationTrajectory,
    SystemAlert,
)
from ..services.mission import (
    catalog_state,
    catalogue_satrecs,
    report_html,
    run_experiment_job,
    run_plan,
    run_simulation,
    twin_dict,
    twin_state_at,
)
from ..services.timeutil import as_utc, parse_time

router = APIRouter(tags=["digital twin, maneuvers, simulation, research"])


def _now():
    return datetime.now(timezone.utc)


# ================================================================ scoping
def _twin(s: Session, p: Principal, twin_id: int, manage: bool = False) -> DigitalTwin:
    t = s.get(DigitalTwin, twin_id)
    if t is None or (t.organization_id != p.user.organization_id and not p.can("users:manage_all")):
        raise HTTPException(404, "Digital twin not found")
    if manage and p.role == R.OPERATOR:
        mine = t.created_by_id == p.user.id or (t.source_norad_id and t.source_norad_id in assigned_norad_ids(s, p.user))
        if not mine:
            raise HTTPException(403, "Operators can only work with twins they created or of satellites assigned to them")
    return t


def _plan(s: Session, p: Principal, plan_id: int) -> ManeuverPlan:
    pl = s.get(ManeuverPlan, plan_id)
    if pl is None or (pl.organization_id != p.user.organization_id and not p.can("users:manage_all")):
        raise HTTPException(404, "Maneuver plan not found")
    return pl


# ================================================================ digital twins
@router.get("/digital-twins/presets")
def twin_presets(_: Principal = Depends(require("twin:read")), s: Session = Depends(get_session)):
    rows = s.scalars(select(PropulsionModel).where(PropulsionModel.is_preset.is_(True)).order_by(PropulsionModel.thrust_n)).all()
    return {
        "default_config": SpacecraftConfig().to_dict(),
        "directions": list(DIRECTIONS),
        "propulsion": [
            {"id": r.id, "key": r.key, "name": r.name, "thrust_n": r.thrust_n, "isp_s": r.isp_s, "max_burn_s": r.max_burn_s,
             "max_dv_per_burn_ms": r.max_dv_per_burn_ms, "min_impulse_dv_ms": r.min_impulse_dv_ms, "power_w": r.power_w, "note": r.note}
            for r in rows
        ],
        "label": "Templates with typical values. They are starting points to edit, not descriptions of real spacecraft.",
    }


class TwinCreate(BaseModel):
    name: str = Field(min_length=2, max_length=128)
    source: str = Field("catalog", pattern="^(catalog|elements)$")
    norad_id: int | None = None
    epoch: str | None = None
    # elements source (osculating, EGM-96 mu)
    alt_km: float | None = Field(None, gt=100, lt=100000)
    ecc: float = Field(0.0, ge=0, lt=0.9)
    inc_deg: float = Field(51.6, ge=0, le=180)
    raan_deg: float = 0.0
    argp_deg: float = 0.0
    nu_deg: float = 0.0
    config: dict | None = None
    propulsion_preset: str | None = None
    notes: str | None = Field(None, max_length=2000)


@router.get("/digital-twins")
def list_twins(p: Principal = Depends(require("twin:read")), s: Session = Depends(get_session)):
    q = select(DigitalTwin).order_by(DigitalTwin.id.desc())
    if not p.can("users:manage_all"):
        q = q.where(DigitalTwin.organization_id == p.user.organization_id)
    return [twin_dict(t, s) for t in s.scalars(q).all()]


@router.post("/digital-twins", status_code=201)
def create_twin(req: TwinCreate, p: Principal = Depends(require("twin:manage")), s: Session = Depends(get_session)):
    try:
        when = parse_time(req.epoch)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    es_id = None
    if req.source == "catalog":
        if req.norad_id is None:
            raise HTTPException(400, "Choose the catalogue object the twin starts from")
        if p.role == R.OPERATOR and req.norad_id not in assigned_norad_ids(s, p.user):
            raise HTTPException(403, "Operators can create twins only of satellites assigned to them")
        try:
            r, v, entry, src = catalog_state(s, req.norad_id, when)
        except LookupError as exc:
            raise HTTPException(404, str(exc))
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        es_id = entry.element_set_id
    else:
        if req.alt_km is None:
            raise HTTPException(400, "Give the altitude for an elements-defined twin")
        a = (R_EARTH + req.alt_km) / (1 - req.ecc) if req.ecc else R_EARTH + req.alt_km  # alt_km = perigee altitude
        rr, vv = coe_to_rv(a * (1 - req.ecc**2), req.ecc, req.inc_deg, req.raan_deg, req.argp_deg, req.nu_deg)
        r, v = np.array(rr), np.array(vv)
        src = f"user-defined osculating elements (perigee alt {req.alt_km} km, e {req.ecc}, i {req.inc_deg} deg) at {when.isoformat()}"
    cfg = SpacecraftConfig.from_dict(req.config) if req.config else SpacecraftConfig()
    if req.propulsion_preset:
        pre = PROPULSION_PRESETS.get(req.propulsion_preset)
        if pre is None:
            raise HTTPException(400, f"Unknown propulsion preset; use one of {sorted(PROPULSION_PRESETS)}")
        cfg.propulsion = Propulsion(**pre.__dict__)
    cfg.name = req.name
    errs = cfg.validate()
    if errs:
        raise HTTPException(422, "Spacecraft configuration: " + "; ".join(errs))
    coe = rv_to_coe(r, v)
    if req.source == "catalog":  # sensible mission defaults from the actual orbit
        cfg.mission.alt_min_km = max(150.0, coe.a_km * (1 - coe.e) - R_EARTH - 50)
        cfg.mission.alt_max_km = coe.a_km * (1 + coe.e) - R_EARTH + 50
        from orbitguard_engine.constants import SSO_RAAN_RATE_DEG_DAY
        from orbitguard_engine.elements import j2_secular_rates

        rate = math.degrees(j2_secular_rates(coe.a_km, coe.e, coe.i_deg)[0]) * 86400
        cfg.mission.preserve_sso = abs(rate - SSO_RAAN_RATE_DEG_DAY) < 0.05  # the source orbit is Sun-synchronous
    twin = DigitalTwin(name=req.name, organization_id=p.user.organization_id, created_by_id=p.user.id, source_norad_id=req.norad_id if req.source == "catalog" else None,
                       source_element_set_id=es_id, state_source=src, epoch=when, r_km=[float(x) for x in r], v_kms=[float(x) for x in v],
                       config=cfg.to_dict(), notes=req.notes, fuel_log=[])
    s.add(twin)
    s.flush()
    s.add(OrbitalState(twin_id=twin.id, norad_id=twin.source_norad_id, epoch=when, frame=FRAME_TEME, r_km=twin.r_km, v_kms=twin.v_kms, source=src))
    audit(s, "twin.created", f"Digital twin #{twin.id} '{twin.name}' created", actor=p.user, twin_id=twin.id)
    s.commit()
    return twin_dict(twin, s)


@router.get("/digital-twins/{twin_id}")
def get_twin(twin_id: int, p: Principal = Depends(require("twin:read")), s: Session = Depends(get_session)):
    t = _twin(s, p, twin_id)
    d = twin_dict(t, s)
    d["plans"] = [{"id": x.id, "status": x.status, "method": x.method, "created_at": as_utc(x.created_at).isoformat(),
                   "result_status": (x.result or {}).get("status")}
                  for x in s.scalars(select(ManeuverPlan).where(ManeuverPlan.twin_id == t.id).order_by(ManeuverPlan.id.desc()).limit(20))]
    return d


class TwinUpdate(BaseModel):
    name: str | None = Field(None, min_length=2, max_length=128)
    config: dict | None = None
    notes: str | None = Field(None, max_length=2000)


@router.patch("/digital-twins/{twin_id}")
def update_twin(twin_id: int, req: TwinUpdate, p: Principal = Depends(require("twin:manage")), s: Session = Depends(get_session)):
    t = _twin(s, p, twin_id, manage=True)
    if req.config is not None:
        try:
            cfg = SpacecraftConfig.from_dict(req.config)
        except TypeError as exc:
            raise HTTPException(422, f"Unknown configuration field: {exc}")
        errs = cfg.validate()
        if errs:
            raise HTTPException(422, "Spacecraft configuration: " + "; ".join(errs))
        cfg.name = req.name or t.name
        t.config = cfg.to_dict()
    if req.name:
        t.name = req.name
        t.config = {**t.config, "name": req.name}
    if req.notes is not None:
        t.notes = req.notes
    t.updated_at = _now()
    audit(s, "twin.updated", f"Digital twin #{t.id} updated", actor=p.user, twin_id=t.id)
    s.commit()
    return twin_dict(t, s)


@router.delete("/digital-twins/{twin_id}")
def delete_twin(twin_id: int, p: Principal = Depends(require("twin:manage")), s: Session = Depends(get_session)):
    t = _twin(s, p, twin_id, manage=True)
    if s.scalar(select(ManeuverPlan.id).where(ManeuverPlan.twin_id == t.id).limit(1)):
        raise HTTPException(409, "This twin has maneuver plans; they are kept for reproducibility, so the twin can't be deleted")
    s.query(OrbitalState).filter(OrbitalState.twin_id == t.id).delete()
    audit(s, "twin.deleted", f"Digital twin #{t.id} '{t.name}' deleted", actor=p.user)
    s.delete(t)
    s.commit()
    return {"ok": True}


class PropagateRequest(BaseModel):
    start: str | None = None
    horizon_h: float = Field(24.0, gt=0, le=72)
    step_s: float = Field(300.0, ge=30, le=3600)
    force: dict = Field(default_factory=lambda: {"j2": True, "j3": True, "j4": True, "drag": True, "srp": True, "sun": True, "moon": True})
    anchor_to_catalog: bool = True


@router.post("/digital-twins/{twin_id}/propagate")
def propagate_twin(twin_id: int, req: PropagateRequest, p: Principal = Depends(require("twin:read")), s: Session = Depends(get_session)):
    """Numerical propagation of the twin, compared with SGP4 of its source object when there is one."""
    t = _twin(s, p, twin_id)
    try:
        start = parse_time(req.start) if req.start else as_utc(t.epoch)
        r0, v0, src = twin_state_at(s, t, start, req.anchor_to_catalog)
        force = ForceModel(**{k: bool(v) for k, v in req.force.items() if k in ForceModel.__dataclass_fields__})
    except (ValueError, LookupError, TypeError) as exc:
        raise HTTPException(400, str(exc))
    sc = SpacecraftConfig.from_dict(t.config)
    grid = time_grid(req.horizon_h * 3600, req.step_s)
    tr = propagate(start, r0, v0, grid, force, Body(sc.wet_mass_kg, sc.structure.area_m2, sc.structure.cd, sc.structure.cr))
    r, v = tr.r[0], tr.v[0]
    alt = np.linalg.norm(r, axis=1) - R_EARTH
    els = [rv_to_coe(r[k], v[k]) for k in range(0, len(grid), max(1, len(grid) // 200))]
    out = {
        "start": start.isoformat(), "initial_state_source": src, "force_model": force.describe(), "stats": tr.stats,
        "t_h": (grid / 3600).tolist(), "alt_km": np.round(alt, 4).tolist(),
        "elements": {"t_h": (grid[:: max(1, len(grid) // 200)] / 3600).tolist(), "a_km": [e.a_km for e in els], "e": [e.e for e in els],
                     "i_deg": [e.i_deg for e in els], "raan_deg": [e.raan_deg for e in els]},
        "label": "Osculating elements from the numerical state (they oscillate around the mean values).",
    }
    if t.source_norad_id:
        from ..services.catalog import catalog_cache

        entry = next((e for e in catalog_cache.entries(s) if e.norad_id == t.source_norad_id), None)
        if entry is not None:
            jd0, fr0 = datetime_to_jd(start)
            e, rs, _ = entry.satrec.sgp4_array(np.full(len(grid), jd0), fr0 + grid / 86400.0)
            diff = np.linalg.norm(rs - r, axis=1)
            out["sgp4_comparison"] = {"position_difference_km": np.where(e == 0, np.round(diff, 4), None).tolist(),
                                      "max_km": float(np.nanmax(np.where(e == 0, diff, np.nan))),
                                      "note": "Difference between this numerical model and SGP4 for the source object. Both are models; neither is truth."}
    return out


@router.post("/digital-twins/{twin_id}/threats/screen")
def screen_twin(twin_id: int, horizon_h: float = Query(24, gt=0, le=72), threshold_km: float = Query(10, gt=0, le=100),
                start: str | None = None, p: Principal = Depends(require("maneuver:plan")), s: Session = Depends(get_session)):
    """Find real catalogue objects that pass close to the twin's numerically propagated trajectory."""
    t = _twin(s, p, twin_id)
    try:
        when = parse_time(start)
        r0, v0, src = twin_state_at(s, t, when)
    except (ValueError, LookupError) as exc:
        raise HTTPException(400, str(exc))
    sc = SpacecraftConfig.from_dict(t.config)
    grid = time_grid(horizon_h * 3600, 20.0)
    tr = propagate(when, r0, v0, grid, ForceModel(j2=True, drag=True), Body(sc.wet_mass_kg, sc.structure.area_m2, sc.structure.cd, sc.structure.cr))
    cat = catalogue_satrecs(s, {t.source_norad_id} if t.source_norad_id else set())
    found = screen_trajectory(when, grid, tr.r[0], tr.v[0], cat, threshold_km)
    from ..models import SpaceObject

    names = dict(s.execute(select(SpaceObject.norad_id, SpaceObject.name).where(SpaceObject.norad_id.in_([f["norad_id"] for f in found] or [-1]))).all())
    for f in found:
        f["name"] = names.get(f["norad_id"])
        f["tca"] = (when + __import__("datetime").timedelta(seconds=f["tca_s"])).isoformat()
    return {"start": when.isoformat(), "state_source": src, "objects_screened": len(cat), "threshold_km": threshold_km, "encounters": found,
            "note": "Twin propagated numerically (J2 + drag); catalogue objects with SGP4."}


@router.post("/digital-twins/{twin_id}/apply/{plan_id}")
def apply_plan(twin_id: int, plan_id: int, p: Principal = Depends(require("twin:manage")), s: Session = Depends(get_session)):
    """Book the selected maneuver's propellant against the twin (SIMULATED bookkeeping only)."""
    t = _twin(s, p, twin_id, manage=True)
    pl = _plan(s, p, plan_id)
    if pl.twin_id != t.id or not (pl.result or {}).get("selected"):
        raise HTTPException(400, "This plan has no selected maneuver for this twin")
    if pl.applied_at:
        raise HTTPException(409, "Already applied")
    sel = pl.result["selected"]
    cfg = dict(t.config)
    fuel = dict(cfg["fuel"])
    fuel["propellant_remaining_kg"] = max(0.0, fuel["propellant_remaining_kg"] - sel["propellant_kg"])
    cfg["fuel"] = fuel
    t.config = cfg
    t.fuel_log = (t.fuel_log or []) + [{"plan_id": pl.id, "at": _now().isoformat(), "dv_ms": sel["dv_ms"], "propellant_kg": sel["propellant_kg"],
                                        "remaining_kg": fuel["propellant_remaining_kg"], "label": "SIMULATED"}]
    pl.applied_at = _now()
    audit(s, "twin.fuel", f"Plan #{pl.id} booked against twin #{t.id}: -{sel['propellant_kg'] * 1000:.1f} g (simulated)", actor=p.user)
    s.commit()
    return twin_dict(t, s)


# ================================================================ maneuvers
class SyntheticThreat(BaseModel):
    tca_h: float = Field(gt=0, le=72)
    miss_m: float = Field(gt=0, le=50000)
    crossing_deg: float = Field(60.0, ge=1, le=179)
    phase_deg: float = 0.0


class OptimizeRequest(BaseModel):
    twin_id: int
    start: str | None = None
    horizon_h: float = Field(24.0, gt=1, le=72)
    method: str = Field("proposed", pattern="^(proposed|multi-nominal|single)$")
    catalog_threats: list[int] = Field(default_factory=list, max_length=20)
    synthetic_threats: list[SyntheticThreat] = Field(default_factory=list, max_length=20)
    anchor_to_catalog: bool = True
    rescreen_catalogue: bool = True
    optimizer: dict = Field(default_factory=dict)
    uncertainty: dict = Field(default_factory=dict)


@router.post("/maneuvers/optimize", status_code=202)
def optimize(req: OptimizeRequest, bg: BackgroundTasks, p: Principal = Depends(require("maneuver:plan")), s: Session = Depends(get_session)):
    t = _twin(s, p, req.twin_id, manage=True)
    if not req.catalog_threats and not req.synthetic_threats:
        raise HTTPException(400, "Add at least one threat (catalogue object or synthetic test object)")
    try:
        start = parse_time(req.start)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if any(x.tca_h * 3600 >= req.horizon_h * 3600 for x in req.synthetic_threats):
        raise HTTPException(400, "Every synthetic threat must fall inside the planning horizon")
    params = req.model_dump()
    params["start"] = start.isoformat()
    pl = ManeuverPlan(twin_id=t.id, organization_id=t.organization_id, created_by_id=p.user.id, method=req.method, params=params)
    s.add(pl)
    s.flush()
    audit(s, "maneuver.queued", f"Maneuver plan #{pl.id} for twin #{t.id} queued ({req.method})", actor=p.user, plan_id=pl.id)
    s.commit()
    bg.add_task(run_plan, SessionLocal, pl.id)
    return {"plan_id": pl.id, "status": "queued"}


def _plan_summary(pl: ManeuverPlan, s: Session) -> dict:
    res = pl.result or {}
    twin = s.get(DigitalTwin, pl.twin_id)
    sel = res.get("selected")
    return {"id": pl.id, "twin_id": pl.twin_id, "twin_name": twin.name if twin else None, "method": pl.method, "status": pl.status,
            "progress": pl.progress, "stage": pl.stage, "message": pl.message, "result_status": res.get("status"),
            "dv_ms": sel["dv_ms"] if sel else None, "validation": (res.get("validation") or {}).get("status"),
            "applied_at": as_utc(pl.applied_at).isoformat() if pl.applied_at else None,
            "created_at": as_utc(pl.created_at).isoformat(), "finished_at": as_utc(pl.finished_at).isoformat() if pl.finished_at else None}


@router.get("/maneuvers")
def list_plans(twin_id: int | None = None, limit: int = Query(30, ge=1, le=200), p: Principal = Depends(require("twin:read")), s: Session = Depends(get_session)):
    q = select(ManeuverPlan).order_by(ManeuverPlan.id.desc()).limit(limit)
    if not p.can("users:manage_all"):
        q = q.where(ManeuverPlan.organization_id == p.user.organization_id)
    if twin_id:
        q = q.where(ManeuverPlan.twin_id == twin_id)
    return [_plan_summary(x, s) for x in s.scalars(q).all()]


@router.get("/maneuvers/{plan_id}")
def get_plan(plan_id: int, p: Principal = Depends(require("twin:read")), s: Session = Depends(get_session)):
    pl = _plan(s, p, plan_id)
    return {**_plan_summary(pl, s), "params": pl.params, "result": pl.result}


@router.get("/maneuvers/{plan_id}/candidates")
def plan_candidates(plan_id: int, p: Principal = Depends(require("twin:read")), s: Session = Depends(get_session)):
    pl = _plan(s, p, plan_id)
    rows = s.scalars(select(ManeuverCandidate).where(ManeuverCandidate.plan_id == pl.id).order_by(ManeuverCandidate.rank)).all()
    return [{"rank": r.rank, "role": r.role, **r.data} for r in rows]


# ================================================================ simulations
class SimulationRequest(BaseModel):
    plan_id: int
    fidelity: str = Field("validation", pattern="^(validation|optimisation)$")
    # optional: also fly one other feasible candidate from the plan's table, for comparison
    alternative_index: int | None = Field(None, ge=0, lt=20)


@router.post("/simulations", status_code=202)
def create_simulation(req: SimulationRequest, bg: BackgroundTasks, p: Principal = Depends(require("simulation:run")), s: Session = Depends(get_session)):
    pl = _plan(s, p, req.plan_id)
    if pl.status != "succeeded" or not pl.result or "initial_state" not in pl.result:
        raise HTTPException(400, "The plan hasn't finished successfully")
    cfg = {"fidelity": req.fidelity}
    if req.alternative_index is not None:
        tops = pl.result.get("top_candidates") or []
        if req.alternative_index >= len(tops) or not tops[req.alternative_index].get("feasible") or tops[req.alternative_index].get("t_m_s") is None:
            raise HTTPException(400, "The alternative must be a feasible candidate from this plan's table")
        cfg["alternative_index"] = req.alternative_index
    run = SimulationRun(plan_id=pl.id, twin_id=pl.twin_id, organization_id=pl.organization_id, created_by_id=p.user.id,
                        config=cfg)
    s.add(run)
    s.commit()
    bg.add_task(run_simulation, SessionLocal, run.id)
    return {"simulation_id": run.id, "status": "queued"}


@router.get("/simulations")
def list_simulations(plan_id: int | None = None, p: Principal = Depends(require("twin:read")), s: Session = Depends(get_session)):
    q = select(SimulationRun).order_by(SimulationRun.id.desc()).limit(50)
    if not p.can("users:manage_all"):
        q = q.where(SimulationRun.organization_id == p.user.organization_id)
    if plan_id:
        q = q.where(SimulationRun.plan_id == plan_id)
    return [{"id": r.id, "plan_id": r.plan_id, "twin_id": r.twin_id, "status": r.status, "message": r.message,
             "fidelity": r.config.get("fidelity"), "alternative_index": r.config.get("alternative_index"),
             "created_at": as_utc(r.created_at).isoformat()} for r in s.scalars(q).all()]


@router.get("/simulations/{sim_id}")
def get_simulation(sim_id: int, p: Principal = Depends(require("twin:read")), s: Session = Depends(get_session)):
    r = s.get(SimulationRun, sim_id)
    if r is None or (r.organization_id != p.user.organization_id and not p.can("users:manage_all")):
        raise HTTPException(404, "Simulation not found")
    trajs = s.scalars(select(SimulationTrajectory).where(SimulationTrajectory.run_id == r.id).order_by(SimulationTrajectory.id)).all()
    mets = s.scalars(select(SimulationMetric).where(SimulationMetric.run_id == r.id)).all()
    return {"id": r.id, "plan_id": r.plan_id, "twin_id": r.twin_id, "status": r.status, "message": r.message, "config": r.config,
            "versions": r.versions, "created_at": as_utc(r.created_at).isoformat(),
            "trajectories": [{"label": x.label, "kind": x.kind, "frame": x.frame, "start": as_utc(x.start).isoformat(), "step_s": x.step_s, **x.data} for x in trajs],
            "metrics": [{"name": m.name, "value": m.value, "unit": m.unit, "context": m.context} for m in mets]}


# ================================================================ transfer lab
class TransferBody(BaseModel):
    kind: str = Field(pattern="^(hohmann|bielliptic|plane-change|combined|raise-apogee)$")
    alt1_km: float = Field(gt=150, lt=500000)
    alt2_km: float | None = Field(None, gt=150, lt=500000)
    inc1_deg: float = Field(0.0, ge=0, le=180)
    inc2_deg: float | None = Field(None, ge=0, le=180)
    alt_b_km: float | None = Field(None, gt=150, lt=2000000)
    mass_kg: float | None = Field(None, gt=0, lt=1e6)
    isp_s: float | None = Field(None, gt=0, lt=10000)


@router.get("/transfers/presets")
def transfer_presets(_: Principal = Depends(require("orbits:compute"))):
    return {k: v.__dict__ for k, v in TRANSFER_PRESETS.items()}


@router.post("/transfers")
def transfer(req: TransferBody, _: Principal = Depends(require("orbits:compute"))):
    if req.kind in ("hohmann", "bielliptic", "raise-apogee", "combined") and req.alt2_km is None:
        raise HTTPException(400, "Target altitude is required")
    if req.kind == "bielliptic" and req.alt_b_km is not None and req.alt_b_km < max(req.alt1_km, req.alt2_km or 0):
        raise HTTPException(400, "The bi-elliptic intermediate apoapsis must be above both orbits")
    if req.kind == "raise-apogee" and req.alt2_km is not None and req.alt2_km <= req.alt1_km:
        raise HTTPException(400, "The new apogee must be above the current orbit")
    try:
        out = fly(TransferRequest(**req.model_dump()))
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc))
    for leg in out["legs"]:  # thin the drawn legs for the browser
        pts = leg["r_km"]
        step = max(1, len(pts) // 240)
        leg["r_km"] = [[round(c, 2) for c in x] for x in pts[::step]] + ([[round(c, 2) for c in pts[-1]]] if (len(pts) - 1) % step else [])
    return out


# ================================================================ research
class ExperimentRequest(BaseModel):
    name: str = Field(pattern="^E[1-8]$")
    seeds: int = Field(3, ge=1, le=20)
    profile: str = Field("fast", pattern="^(fast|full)$")


@router.get("/research/experiments/catalog")
def experiment_catalog(_: Principal = Depends(require("research:read"))):
    return [{"name": k, "title": v[0], "question": v[1]} for k, v in EXPERIMENTS.items()]


@router.post("/research/experiments", status_code=202)
def start_experiment(req: ExperimentRequest, bg: BackgroundTasks, p: Principal = Depends(require("research:run")), s: Session = Depends(get_session)):
    ex = ExperimentRun(name=req.name, profile=req.profile, seeds=req.seeds, created_by_id=p.user.id, organization_id=p.user.organization_id)
    s.add(ex)
    s.flush()
    audit(s, "research.queued", f"Experiment {req.name} #{ex.id} queued ({req.seeds} seeds, {req.profile})", actor=p.user)
    s.commit()
    bg.add_task(run_experiment_job, SessionLocal, ex.id)
    return {"experiment_id": ex.id, "status": "queued"}


def _exp_dict(e: ExperimentRun, full: bool = False) -> dict:
    d = {"id": e.id, "name": e.name, "profile": e.profile, "seeds": e.seeds, "status": e.status, "progress": e.progress, "stage": e.stage,
         "message": e.message, "created_at": as_utc(e.created_at).isoformat(), "finished_at": as_utc(e.finished_at).isoformat() if e.finished_at else None,
         "title": EXPERIMENTS.get(e.name, ("",))[0]}
    if full:
        d["result"] = e.result
    elif e.result:
        d["summary"] = e.result.get("summary")
        d["runtime_s"] = e.result.get("runtime_s")
    return d


@router.get("/research/experiments")
def list_experiments(p: Principal = Depends(require("research:read")), s: Session = Depends(get_session)):
    return [_exp_dict(e) for e in s.scalars(select(ExperimentRun).order_by(ExperimentRun.id.desc()).limit(100)).all()]


@router.get("/research/experiments/{exp_id}")
def get_experiment(exp_id: int, p: Principal = Depends(require("research:read")), s: Session = Depends(get_session)):
    e = s.get(ExperimentRun, exp_id)
    if e is None:
        raise HTTPException(404, "Experiment not found")
    return _exp_dict(e, full=True)


@router.get("/research/experiments/{exp_id}/csv", response_class=PlainTextResponse)
def experiment_csv(exp_id: int, p: Principal = Depends(require("research:read")), s: Session = Depends(get_session)):
    e = s.get(ExperimentRun, exp_id)
    if e is None or not e.result:
        raise HTTPException(404, "No results")
    return PlainTextResponse(to_csv(e.result), headers={"Content-Disposition": f'attachment; filename="orbitguard_{e.name}_{e.id}.csv"'})


# ================================================================ reports
@router.get("/reports/{plan_id}", response_class=HTMLResponse)
def report(plan_id: int, p: Principal = Depends(require("reports:read")), s: Session = Depends(get_session)):
    pl = _plan(s, p, plan_id)
    if pl.status != "succeeded":
        raise HTTPException(400, "The plan hasn't finished")
    return HTMLResponse(report_html(pl, s.get(DigitalTwin, pl.twin_id), s))


# ================================================================ alerts
def _alert_query(p: Principal):
    q = select(SystemAlert).where(or_(SystemAlert.organization_id.is_(None), SystemAlert.organization_id == p.user.organization_id))
    return q


@router.get("/alerts")
def alerts(limit: int = Query(30, ge=1, le=100), p: Principal = Depends(require("alerts:read")), s: Session = Depends(get_session)):
    rows = [a for a in s.scalars(_alert_query(p).order_by(SystemAlert.id.desc()).limit(limit * 3)).all() if not a.permission or p.can(a.permission)][:limit]
    read = set(s.scalars(select(AlertRead.alert_id).where(AlertRead.user_id == p.user.id, AlertRead.alert_id.in_([a.id for a in rows] or [-1]))).all())
    return {"unread": sum(1 for a in rows if a.id not in read),
            "items": [{"id": a.id, "severity": a.severity, "kind": a.kind, "title": a.title, "message": a.message, "link": a.link,
                       "created_at": as_utc(a.created_at).isoformat(), "read": a.id in read} for a in rows]}


@router.post("/alerts/read-all")
def alerts_read_all(p: Principal = Depends(require("alerts:read")), s: Session = Depends(get_session)):
    ids = [a.id for a in s.scalars(_alert_query(p).order_by(SystemAlert.id.desc()).limit(300)).all()]
    have = set(s.scalars(select(AlertRead.alert_id).where(AlertRead.user_id == p.user.id)).all())
    for i in ids:
        if i not in have:
            s.add(AlertRead(alert_id=i, user_id=p.user.id))
    s.commit()
    return {"ok": True}


_ = (math, OrbitalState)
