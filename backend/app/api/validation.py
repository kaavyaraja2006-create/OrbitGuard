from __future__ import annotations

import random

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth.deps import Principal, require
from ..core.db import SessionLocal, get_session
from ..models import DatasetJob, KelvinsCdm, SocratesConjunction
from ..services import datasets
from ..services.timeutil import as_utc

router = APIRouter(prefix="/validation", tags=["validation"])


def _job(j: DatasetJob) -> dict:
    return {
        "id": j.id,
        "kind": j.kind,
        "status": j.status,
        "progress": j.progress,
        "created_at": as_utc(j.created_at).isoformat(),
        "finished_at": as_utc(j.finished_at).isoformat() if j.finished_at else None,
        "params": j.params,
        "files": j.files,
        "summary": j.summary,
        "message": j.message,
    }


def _queue(s: Session, bg: BackgroundTasks, kind: str, params: dict | None = None) -> dict:
    running = s.scalar(select(DatasetJob).where(DatasetJob.kind == kind, DatasetJob.status.in_(["queued", "running"])))
    if running:
        raise HTTPException(409, f"A {kind} job (#{running.id}) is already running")
    j = DatasetJob(kind=kind, params=params)
    s.add(j)
    s.commit()
    bg.add_task(datasets.run_job, SessionLocal, j.id)
    return {"job_id": j.id, "status": "queued"}


@router.get("/files")
def files(_: Principal = Depends(require("validation:read"))):
    return datasets.discover()


@router.get("/jobs")
def jobs(limit: int = 30, _: Principal = Depends(require("validation:read")), s: Session = Depends(get_session)):
    return [_job(j) for j in s.scalars(select(DatasetJob).order_by(DatasetJob.id.desc()).limit(min(limit, 200)))]


@router.get("/jobs/{job_id}")
def job(job_id: int, _: Principal = Depends(require("validation:read")), s: Session = Depends(get_session)):
    j = s.get(DatasetJob, job_id)
    if j is None:
        raise HTTPException(404, "Job not found")
    return _job(j)


# ---------------------------------------------------------------- Kelvins
@router.post("/kelvins/import", status_code=202)
def kelvins_import(bg: BackgroundTasks, _: Principal = Depends(require("validation:run")), s: Session = Depends(get_session)):
    if not datasets.discover()["kelvins"]:
        raise HTTPException(404, f"No Kelvins files found under {datasets.DATA_DIR}")
    return _queue(s, bg, "kelvins-import")


def _latest_kelvins(s: Session) -> DatasetJob | None:
    return s.scalar(select(DatasetJob).where(DatasetJob.kind == "kelvins-import", DatasetJob.status == "succeeded").order_by(DatasetJob.id.desc()).limit(1))


@router.get("/kelvins/summary")
def kelvins_summary(_: Principal = Depends(require("validation:read")), s: Session = Depends(get_session)):
    j = _latest_kelvins(s)
    return _job(j) if j else None


@router.get("/kelvins/scatter")
def kelvins_scatter(limit: int = 3000, seed: int = 0, _: Principal = Depends(require("validation:read")), s: Session = Depends(get_session)):
    rows = s.execute(
        select(KelvinsCdm.esa_risk, KelvinsCdm.our_log10_pc, KelvinsCdm.mission_id).where(
            KelvinsCdm.our_log10_pc.is_not(None), KelvinsCdm.esa_risk > -30, KelvinsCdm.our_log10_pc > -30
        )
    ).all()
    total = len(rows)
    if total > limit:
        rows = random.Random(seed).sample(rows, limit)  # fixed seed: reproducible sample
    return {"total": total, "shown": len(rows), "points": [{"esa": r[0], "ours": r[1], "mission": r[2]} for r in rows]}


@router.get("/kelvins/events")
def kelvins_events(split: str | None = None, mission_id: int | None = None, min_risk: float | None = None, limit: int = 100, _: Principal = Depends(require("validation:read")), s: Session = Depends(get_session)):
    # Latest CDM (smallest time_to_tca) per event
    sub = (
        select(KelvinsCdm.split, KelvinsCdm.event_id, func.min(KelvinsCdm.time_to_tca_d).label("t"), func.count(KelvinsCdm.id).label("n"))
        .group_by(KelvinsCdm.split, KelvinsCdm.event_id)
        .subquery()
    )
    stmt = select(KelvinsCdm, sub.c.n).join(
        sub, (sub.c.split == KelvinsCdm.split) & (sub.c.event_id == KelvinsCdm.event_id) & (sub.c.t == KelvinsCdm.time_to_tca_d)
    )
    if split:
        stmt = stmt.where(KelvinsCdm.split == split)
    if mission_id is not None:
        stmt = stmt.where(KelvinsCdm.mission_id == mission_id)
    if min_risk is not None:
        stmt = stmt.where(KelvinsCdm.esa_risk >= min_risk)
    rows = s.execute(stmt.order_by(KelvinsCdm.esa_risk.desc()).limit(min(limit, 1000))).all()
    return [
        {
            "split": r.split,
            "event_id": r.event_id,
            "mission_id": r.mission_id,
            "cdm_count": n,
            "last_time_to_tca_d": r.time_to_tca_d,
            "esa_risk": r.esa_risk,
            "our_log10_pc": r.our_log10_pc,
            "miss_m": r.miss_m,
            "chaser_type": r.chaser_type,
            "geometry_status": r.geometry_status,
        }
        for r, n in rows
    ]


@router.get("/kelvins/events/{split}/{event_id}")
def kelvins_event(split: str, event_id: int, _: Principal = Depends(require("validation:read")), s: Session = Depends(get_session)):
    d = datasets.kelvins_event_detail(s, split, event_id)
    if d is None:
        raise HTTPException(404, "Event not found")
    return d


# ---------------------------------------------------------------- SOCRATES
class SocratesImport(BaseModel):
    path: str | None = Field(None, description="Relative path inside the data folder; default: newest SOCRATES CSV")


@router.post("/socrates/import", status_code=202)
def socrates_import(req: SocratesImport, bg: BackgroundTasks, _: Principal = Depends(require("validation:run")), s: Session = Depends(get_session)):
    found = datasets.discover()["socrates"]
    if not found:
        raise HTTPException(404, f"No SOCRATES CSV found under {datasets.DATA_DIR}")
    if req.path is not None and req.path not in {f["path"] for f in found}:
        raise HTTPException(400, "Path must be one of the discovered SOCRATES files")
    return _queue(s, bg, "socrates-import", {"path": req.path})


class SocratesCompare(BaseModel):
    import_id: int
    limit: int = Field(200, ge=1, le=5000)


@router.post("/socrates/compare", status_code=202)
def socrates_compare(req: SocratesCompare, bg: BackgroundTasks, _: Principal = Depends(require("validation:run")), s: Session = Depends(get_session)):
    j = s.get(DatasetJob, req.import_id)
    if j is None or j.kind != "socrates-import" or j.status != "succeeded":
        raise HTTPException(400, "import_id must be a succeeded SOCRATES import")
    return _queue(s, bg, "socrates-compare", req.model_dump())


@router.get("/socrates/conjunctions")
def socrates_rows(import_id: int, compared_only: bool = False, limit: int = 200, _: Principal = Depends(require("validation:read")), s: Session = Depends(get_session)):
    stmt = select(SocratesConjunction).where(SocratesConjunction.job_id == import_id)
    if compared_only:
        stmt = stmt.where(SocratesConjunction.compare_status.is_not(None))
    rows = s.scalars(stmt.order_by(SocratesConjunction.range_km).limit(min(limit, 2000))).all()
    return [
        {
            "id": r.id,
            "norad_1": r.norad_1,
            "name_1": r.name_1,
            "status_1": r.status_1,
            "norad_2": r.norad_2,
            "name_2": r.name_2,
            "status_2": r.status_2,
            "tca": as_utc(r.tca).isoformat(),
            "range_km": r.range_km,
            "relative_speed_kms": r.relative_speed_kms,
            "max_prob": r.max_prob,
            "dse_1": r.dse_1,
            "dse_2": r.dse_2,
            "compare_status": r.compare_status,
            "epoch_offset_1_s": r.epoch_offset_1_s,
            "epoch_offset_2_s": r.epoch_offset_2_s,
            "our_tca": as_utc(r.our_tca).isoformat() if r.our_tca else None,
            "our_range_km": r.our_range_km,
            "our_relative_speed_kms": r.our_relative_speed_kms,
            "dt_s": (as_utc(r.our_tca) - as_utc(r.tca)).total_seconds() if r.our_tca else None,
        }
        for r in rows
    ]


@router.get("/socrates/stats")
def socrates_stats(import_id: int, _: Principal = Depends(require("validation:read")), s: Session = Depends(get_session)):
    return datasets.socrates_stats(s, import_id)
