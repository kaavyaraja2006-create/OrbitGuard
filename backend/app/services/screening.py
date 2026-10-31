"""Background conjunction screening job and event persistence."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from orbitguard_engine.collision import pc_max_isotropic
from orbitguard_engine.conjunction import ALGORITHM_VERSION, Candidate, ScreeningConfig, screen, shell_radii

from ..models import AuditLog, ConjunctionEventRow, ScreeningRun
from .catalog import catalog_cache
from .timeutil import as_utc


def priority_for(miss_km: float) -> str:
    """Geometric triage only (no covariance): explainable thresholds on miss distance."""
    if miss_km < 1.0:
        return "HIGH"
    if miss_km < 5.0:
        return "MEDIUM"
    return "LOW"


def run_screening(session_factory, run_id: int) -> None:
    with session_factory() as s:
        run = s.get(ScreeningRun, run_id)
        run.status = "running"
        s.commit()
        try:
            _execute(s, run)
        except Exception as exc:  # recorded, never swallowed
            s.rollback()
            run = s.get(ScreeningRun, run_id)
            run.status = "failed"
            run.message = f"{exc.__class__.__name__}: {exc}"
            run.finished_at = datetime.now(timezone.utc)
            s.add(AuditLog(kind="screening.failed", message=f"Screening #{run.id} failed: {run.message}"))
            s.commit()


def _execute(s: Session, run: ScreeningRun) -> None:
    entries = catalog_cache.entries(s)
    by_id = {e.norad_id: e for e in entries}
    prim = by_id.get(run.primary_norad_id)
    if prim is None:
        raise ValueError(f"Primary {run.primary_norad_id} has no element set in the catalog")

    cands = []
    for e in entries:
        if e.norad_id == prim.norad_id:
            continue
        rp, ra = shell_radii(e.satrec)
        cands.append(Candidate(e.norad_id, e.satrec, rp, ra))

    cfg = ScreeningConfig(horizon_s=run.horizon_s, step_s=run.step_s, threshold_km=run.threshold_km)

    def progress(frac: float) -> None:
        run.progress = round(frac, 4)
        s.commit()

    res = screen(prim.satrec, cands, as_utc(run.start), cfg, progress=progress)

    for ev in res.events:
        pmax, _ = pc_max_isotropic(ev.miss_distance_km, run.hbr_km)
        s.add(
            ConjunctionEventRow(
                run_id=run.id,
                primary_norad_id=prim.norad_id,
                secondary_norad_id=ev.secondary_id,
                primary_element_set_id=prim.element_set_id,
                secondary_element_set_id=by_id[ev.secondary_id].element_set_id,
                tca=ev.tca,
                miss_distance_km=ev.miss_distance_km,
                relative_speed_kms=ev.relative_speed_kms,
                approach_angle_deg=ev.approach_angle_deg,
                miss_rtn_km=ev.miss_rtn_km,
                geometry={
                    "frame": "TEME",
                    "r_rel_km": ev.r_rel_teme_km,
                    "v_rel_kms": ev.v_rel_teme_kms,
                    "primary_r_km": ev.primary_r_km,
                    "primary_v_kms": ev.primary_v_kms,
                    "secondary_r_km": ev.secondary_r_km,
                    "secondary_v_kms": ev.secondary_v_kms,
                },
                pc_max_isotropic=pmax,
                priority=priority_for(ev.miss_distance_km),
            )
        )
    st = res.stats
    run.stats = {k: getattr(st, k) for k in st.__dataclass_fields__}
    run.warnings = res.warnings
    run.algorithm_version = ALGORITHM_VERSION
    run.progress = 1.0
    run.status = "succeeded"
    run.finished_at = datetime.now(timezone.utc)
    s.add(
        AuditLog(
            kind="screening.succeeded",
            message=f"Screening #{run.id} of {run.primary_norad_id}: {st.events} event(s) within {run.threshold_km:g} km "
            f"over {run.horizon_s / 3600:g} h ({st.candidates_after_shell_filter}/{st.candidates_total} candidates after shell filter, {st.runtime_s:.1f} s)",
        )
    )
    high = [e for e in res.events if priority_for(e.miss_distance_km) == "HIGH"]
    if high:
        from ..models import SystemAlert

        closest = min(high, key=lambda e: e.miss_distance_km)
        s.add(SystemAlert(severity="critical", kind="conjunction.high", permission="conjunction:read",
                          title=f"{len(high)} HIGH-priority conjunction(s) for NORAD {run.primary_norad_id}",
                          message=f"Closest: NORAD {closest.secondary_id}, {closest.miss_distance_km * 1000:.0f} m at {closest.tca.isoformat()} "
                                  f"(screening #{run.id}). Priority is geometric (miss distance), not probability.",
                          link="/threats"))
    s.commit()
