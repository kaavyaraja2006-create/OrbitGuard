from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.config import CELESTRAK_GROUPS, CELESTRAK_PRESETS
from ..auth.deps import Principal, require
from ..core.db import SessionLocal, get_session
from ..ingestion import celestrak
from ..ingestion.service import _finish, create_run, ingest_text, run_celestrak
from ..models import AuditLog, DataSource, IngestionRun
from ..services.timeutil import as_utc

router = APIRouter(prefix="/ingestion", tags=["ingestion"])


class CelestrakRequest(BaseModel):
    groups: list[str] = Field(min_length=1)
    force: bool = False


class UploadRequest(BaseModel):
    label: str = Field(min_length=1, max_length=100)
    text: str = Field(min_length=10, max_length=20_000_000)
    object_kind: str | None = Field(None, description="payload | debris | null (unknown)")
    strict_checksum: bool = True


def _run_dict(r: IngestionRun) -> dict:
    return {
        "id": r.id,
        "provider": r.source.provider,
        "source": r.source.name,
        "url": r.source.url,
        "status": r.status,
        "started_at": as_utc(r.started_at).isoformat() if r.started_at else None,
        "finished_at": as_utc(r.finished_at).isoformat() if r.finished_at else None,
        "records_received": r.records_received,
        "records_new": r.records_new,
        "records_duplicate": r.records_duplicate,
        "records_rejected": r.records_rejected,
        "message": r.message,
        "raw_sha256": r.raw_sha256,
        "raw_bytes": r.raw_bytes,
    }


@router.get("/providers")
def providers(_: Principal = Depends(require("data:read"))):
    return {
        "celestrak": {
            "groups": [{"id": k, **v} for k, v in CELESTRAK_GROUPS.items()],
            "presets": [{"id": k, **v} for k, v in CELESTRAK_PRESETS.items()],
            "format": "OMM CSV (includes 6-digit catalog numbers), converted to Alpha-5 TLE internally",
            "auth": "none",
            "note": "Public GP data. Client enforces CelesTrak's 2-hour refresh etiquette.",
        },
        "space-track": {
            "status": "not implemented",
            "note": "Needed for the FULL catalog (all debris and rocket bodies, ~30,000+ objects). Requires a free account; credentials stay server-side.",
        },
        "esa-discos": {"status": "not implemented", "note": "Requires API token. Planned for physical properties."},
    }


@router.post("/celestrak", status_code=202)
def ingest_celestrak(req: CelestrakRequest, bg: BackgroundTasks, _: Principal = Depends(require("data:ingest")), s: Session = Depends(get_session)):
    unknown = [g for g in req.groups if g not in CELESTRAK_GROUPS]
    if unknown:
        raise HTTPException(400, f"Unknown groups: {unknown}. Allowed: {sorted(CELESTRAK_GROUPS)}")
    runs = []
    for g in req.groups:
        run = create_run(s, "celestrak", g, celestrak.group_url(g))
        bg.add_task(run_celestrak, SessionLocal, run.id, g, req.force)
        runs.append(run.id)
    return {"run_ids": runs, "status": "queued"}


@router.post("/upload")
def ingest_upload(req: UploadRequest, _: Principal = Depends(require("data:ingest")), s: Session = Depends(get_session)):
    if req.object_kind not in (None, "payload", "debris"):
        raise HTTPException(400, "object_kind must be 'payload', 'debris' or null")
    run = create_run(s, "user-upload", req.label.strip(), None)
    run.status = "running"
    try:
        ingest_text(s, run, req.text, group_kind=req.object_kind, active_list=False, strict=req.strict_checksum)
    except Exception as exc:
        s.rollback()
        run = s.get(IngestionRun, run.id)
        _finish(s, run, "failed", f"Storage error: {exc}")
        raise HTTPException(500, f"Ingestion failed: {exc}")
    status = "succeeded" if run.records_new + run.records_duplicate > 0 else "failed"
    _finish(s, run, status, None if status == "succeeded" else "No valid TLEs found in upload")
    s.refresh(run)
    return _run_dict(run)


@router.get("/runs")
def list_runs(limit: int = 50, _: Principal = Depends(require("data:read")), s: Session = Depends(get_session)):
    runs = s.scalars(select(IngestionRun).order_by(IngestionRun.id.desc()).limit(min(limit, 500))).all()
    return [_run_dict(r) for r in runs]


@router.get("/runs/{run_id}")
def get_run(run_id: int, _: Principal = Depends(require("data:read")), s: Session = Depends(get_session)):
    r = s.get(IngestionRun, run_id)
    if r is None:
        raise HTTPException(404, "Run not found")
    return _run_dict(r)


@router.get("/sources")
def sources(_: Principal = Depends(require("catalog:read")), s: Session = Depends(get_session)):
    out = []
    for src in s.scalars(select(DataSource).order_by(DataSource.id)).all():
        last = s.scalar(select(IngestionRun).where(IngestionRun.source_id == src.id).order_by(IngestionRun.id.desc()).limit(1))
        out.append({"id": src.id, "provider": src.provider, "name": src.name, "url": src.url, "last_run": _run_dict(last) if last else None})
    return out


@router.get("/activity")
def activity(limit: int = 30, _: Principal = Depends(require("audit:read")), s: Session = Depends(get_session)):
    # Data / screening activity. Sign-in and account events are under /admin/security-events (scoped per organisation).
    rows = s.scalars(
        select(AuditLog)
        .where(~AuditLog.kind.like("auth.%"), ~AuditLog.kind.like("admin.%"))
        .order_by(AuditLog.id.desc())
        .limit(min(limit, 200))
    ).all()
    return [{"id": a.id, "at": as_utc(a.at).isoformat(), "kind": a.kind, "message": a.message} for a in rows]
