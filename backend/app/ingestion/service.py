"""Ingestion pipeline: parse -> validate -> dedupe -> store -> classify.

Element sets are append-only. A record already stored for the same
(norad_id, epoch) is counted as a duplicate, never overwritten.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from orbitguard_engine.classification import ALGORITHM_VERSION, classify_orbit
from orbitguard_engine.constants import MU_WGS72, RE_WGS72
from orbitguard_engine.elements import derived_parameters
from orbitguard_engine.propagation import mean_elements, satrec_from_tle
from orbitguard_engine.tle import parse_tle_text

from ..core.config import CELESTRAK_GROUPS, settings
from ..models import AuditLog, DataSource, IngestionRun, OrbitalElementSet, OrbitClassification, SpaceObject
from ..services.catalog import catalog_cache
from ..services.timeutil import as_utc
from . import celestrak

_RB = re.compile(r"(\bR/B\b|ROCKET BODY|\bAKM\b|\bPKM\b)")
_DEB = re.compile(r"(\bDEB\b|DEBRIS|\bCOOLANT\b|\bFRAG\b)")


def infer_object_type(name: str | None, group_kind: str | None) -> tuple[str, str]:
    """Return (type, how-it-was-determined). Never guesses beyond the evidence."""
    n = (name or "").upper()
    if _RB.search(n):
        return "ROCKET BODY", "name pattern (R/B)"
    if _DEB.search(n):
        return "DEBRIS", "name pattern (DEB)"
    if group_kind == "debris":
        return "DEBRIS", "CelesTrak debris group membership"
    if group_kind == "payload":
        return "PAYLOAD", "CelesTrak payload group membership"
    return "UNKNOWN", "insufficient information"


def get_or_create_source(s: Session, provider: str, name: str, url: str | None) -> DataSource:
    src = s.scalar(select(DataSource).where(DataSource.provider == provider, DataSource.name == name))
    if src is None:
        src = DataSource(provider=provider, name=name, url=url)
        s.add(src)
        s.flush()
    return src


def ingest_text(s: Session, run: IngestionRun, text: str, *, group_kind: str | None, active_list: bool, strict: bool = True) -> IngestionRun:
    report = parse_tle_text(text, strict=strict)
    run.records_received = len(report.tles) + len(report.rejected)
    run.records_rejected = len(report.rejected)
    run.raw_sha256 = hashlib.sha256(text.encode()).hexdigest()
    run.raw_bytes = len(text.encode())

    existing = {
        (nid, as_utc(ep)): (l1, l2)
        for nid, ep, l1, l2 in s.execute(
            select(OrbitalElementSet.norad_id, OrbitalElementSet.epoch, OrbitalElementSet.line1, OrbitalElementSet.line2).where(
                OrbitalElementSet.norad_id.in_([t.norad_id for t in report.tles] or [-1])
            )
        )
    }
    objects = {o.norad_id: o for o in s.scalars(select(SpaceObject).where(SpaceObject.norad_id.in_([t.norad_id for t in report.tles] or [-1])))}

    new = dup = 0
    extra_rejects: list[str] = []
    for tle in report.tles:
        key = (tle.norad_id, tle.epoch)
        if key in existing:
            dup += 1
            if existing[key] != (tle.line1, tle.line2):
                # Same object and epoch but different content: keep the stored
                # record (append-only) and report the conflict explicitly.
                extra_rejects.append(f"{tle.norad_id}: conflicting element set for epoch {tle.epoch.isoformat()} (stored copy kept)")
            continue
        try:
            sat = satrec_from_tle(tle)
            me = mean_elements(sat, tle.epoch)
            d = derived_parameters(me.a_km, me.e, me.i_deg, mu=MU_WGS72, re=RE_WGS72)
        except Exception as exc:  # report, never hide
            extra_rejects.append(f"{tle.norad_id}: {exc}")
            continue

        obj = objects.get(tle.norad_id)
        otype, osrc = infer_object_type(tle.name, group_kind)
        if obj is None:
            obj = SpaceObject(norad_id=tle.norad_id, name=tle.name, intl_designator=tle.intl_designator, object_type=otype, object_type_source=osrc)
            s.add(obj)
            objects[tle.norad_id] = obj
        else:
            if tle.name:
                obj.name = tle.name
            # Upgrade type only when the new evidence is more specific.
            if obj.object_type == "UNKNOWN" and otype != "UNKNOWN":
                obj.object_type, obj.object_type_source = otype, osrc
        if active_list:
            obj.operational_status = "ACTIVE"
            obj.operational_status_source = "CelesTrak 'active' list"

        es = OrbitalElementSet(
            norad_id=tle.norad_id,
            source_id=run.source_id,
            run_id=run.id,
            epoch=tle.epoch,
            line1=tle.line1,
            line2=tle.line2,
            mean_a_km=me.a_km,
            mean_e=me.e,
            mean_i_deg=me.i_deg,
            perigee_alt_km=d.perigee_altitude_km,
            apogee_alt_km=d.apogee_altitude_km,
            period_min=d.period_min,
        )
        s.add(es)
        s.flush()
        cls = classify_orbit(me.a_km, me.e, me.i_deg, mu=MU_WGS72, re=RE_WGS72)
        s.add(
            OrbitClassification(
                element_set_id=es.id,
                labels=cls.labels,
                geo_type=cls.geo_type,
                status=cls.status,
                result=cls.to_dict(),
                algorithm_version=ALGORITHM_VERSION,
            )
        )
        existing[key] = (tle.line1, tle.line2)
        new += 1

    run.records_new = new
    run.records_duplicate = dup
    run.records_rejected += sum(1 for m in extra_rejects if 'conflicting' not in m)
    msgs = [f"line {ln}: {why}" for ln, why in report.rejected[:20]] + extra_rejects[:20]
    run.message = "; ".join(msgs) if msgs else None
    return run


def _finish(s: Session, run: IngestionRun, status: str, message: str | None = None) -> None:
    run.status = status
    run.finished_at = datetime.now(timezone.utc)
    if message:
        run.message = message if not run.message else f"{message} | {run.message}"
    src = run.source
    s.add(
        AuditLog(
            kind=f"ingestion.{status}",
            message=f"{src.provider}:{src.name} — {status}: {run.records_new} new, {run.records_duplicate} duplicate, {run.records_rejected} rejected",
            details={"run_id": run.id, "message": run.message},
        )
    )
    s.commit()
    if status == "succeeded":
        catalog_cache.invalidate()


def create_run(s: Session, provider: str, name: str, url: str | None) -> IngestionRun:
    src = get_or_create_source(s, provider, name, url)
    run = IngestionRun(source_id=src.id, status="queued")
    s.add(run)
    s.commit()
    s.refresh(run)
    return run


def last_success(s: Session, source_id: int) -> IngestionRun | None:
    return s.scalar(
        select(IngestionRun)
        .where(IngestionRun.source_id == source_id, IngestionRun.status == "succeeded")
        .order_by(IngestionRun.finished_at.desc())
        .limit(1)
    )


def run_celestrak(session_factory, run_id: int, group: str, force: bool = False, client: httpx.Client | None = None) -> None:
    """Executed as a background job. All outcomes are recorded on the run."""
    with session_factory() as s:
        run = s.get(IngestionRun, run_id)
        run.status = "running"
        s.commit()
        meta = CELESTRAK_GROUPS.get(group, {})
        prev = last_success(s, run.source_id)
        if prev and not force and prev.finished_at:
            age = datetime.now(timezone.utc) - as_utc(prev.finished_at)
            if age < timedelta(hours=settings.celestrak_min_refresh_hours):
                _finish(
                    s,
                    run,
                    "skipped",
                    f"Group downloaded {age.total_seconds() / 60:.0f} min ago; CelesTrak data refreshes every "
                    f"{settings.celestrak_min_refresh_hours:g} h. Use force to override.",
                )
                return
        try:
            fetched = celestrak.fetch_group(group, client=client)
        except celestrak.ProviderError as exc:
            _finish(s, run, "failed", str(exc))
            return
        try:
            ingest_text(s, run, fetched.text, group_kind=meta.get("kind"), active_list=bool(meta.get("active_list")))
            # provenance refers to the raw provider payload, not the converted text
            run.raw_sha256, run.raw_bytes = fetched.sha256, fetched.n_bytes
            if fetched.conversion_problems:
                run.records_rejected += len(fetched.conversion_problems)
                note = f"{len(fetched.conversion_problems)} OMM rows not convertible: " + "; ".join(fetched.conversion_problems[:5])
                run.message = note if not run.message else f"{note} | {run.message}"
        except Exception as exc:
            s.rollback()
            run = s.get(IngestionRun, run_id)
            _finish(s, run, "failed", f"Storage error: {exc}")
            return
        _finish(s, run, "succeeded")
