"""Services for digital twins, maneuver planning, simulations, experiments, alerts and reports."""

from __future__ import annotations

import html
import json
import platform
from datetime import datetime, timedelta, timezone

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

import orbitguard_engine
from orbitguard_engine.elements import rv_to_coe
from orbitguard_engine.experiments import run_experiment
from orbitguard_engine.forces import ForceModel
from orbitguard_engine.frames import FRAME_ITRF, datetime_to_jd, teme_to_itrf
from orbitguard_engine.maneuver import (
    ALGORITHM_VERSION as MANEUVER_VERSION,
    OptimizerConfig,
    Threat,
    Uncertainty,
    optimise,
    screen_trajectory,
    synthetic_threats,
    threat_tracks,
    time_grid,
)
from orbitguard_engine.numerical import Body, FiniteBurn, Impulse, propagate
from orbitguard_engine.spacecraft import PROPULSION_PRESETS, SpacecraftConfig

from ..models import (
    AuditLog,
    DigitalTwin,
    ExperimentRun,
    ManeuverCandidate,
    ManeuverPlan,
    OrbitalElementSet,
    PropulsionModel,
    SimulationMetric,
    SimulationRun,
    SimulationTrajectory,
    SpaceObject,
    SystemAlert,
)
from .catalog import catalog_cache
from .timeutil import as_utc

DISPLAY_STEP_S = 30.0


def now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------- presets
def seed_propulsion_presets(s: Session) -> None:
    for key, p in PROPULSION_PRESETS.items():
        if s.scalar(select(PropulsionModel).where(PropulsionModel.key == key)) is None:
            s.add(PropulsionModel(key=key, name=p.kind, kind=p.kind, thrust_n=p.thrust_n, isp_s=p.isp_s, max_burn_s=p.max_burn_s,
                                  max_dv_per_burn_ms=p.max_dv_per_burn_ms, min_impulse_dv_ms=p.min_impulse_dv_ms, power_w=p.power_w,
                                  is_preset=True, note="Typical-value template, not a specific real thruster"))
    s.commit()


# ---------------------------------------------------------------- alerts
def alert(s: Session, severity: str, kind: str, title: str, message: str, link: str | None = None,
          organization_id: int | None = None, permission: str | None = None) -> None:
    s.add(SystemAlert(severity=severity, kind=kind, title=title[:200], message=message, link=link,
                      organization_id=organization_id, permission=permission))


# ---------------------------------------------------------------- twins
def catalog_state(s: Session, norad_id: int, when: datetime):
    """TEME state of a catalogue object from its latest element set (SGP4)."""
    entry = next((e for e in catalog_cache.entries(s) if e.norad_id == norad_id), None)
    if entry is None:
        raise LookupError(f"NORAD {norad_id} is not in the catalogue")
    jd, fr = datetime_to_jd(when)
    err, r, v = entry.satrec.sgp4(jd, fr)
    if err:
        raise ValueError(f"SGP4 error {err} propagating NORAD {norad_id} to {when.isoformat()}")
    src = (f"SGP4 state of NORAD {norad_id} ({entry.name}) from element set #{entry.element_set_id} "
           f"(epoch {entry.epoch.isoformat()}), handed over at {when.isoformat()}")
    return np.array(r), np.array(v), entry, src


def twin_state_at(s: Session, twin: DigitalTwin, start: datetime, anchor_to_catalog: bool = True):
    """Initial state for a plan/simulation starting at `start`."""
    epoch = as_utc(twin.epoch)
    if twin.source_norad_id and anchor_to_catalog:
        r, v, _, src = catalog_state(s, twin.source_norad_id, start)
        return r, v, src
    if start < epoch - timedelta(seconds=1):
        raise ValueError("Plan start is before the twin's epoch; numerical propagation only runs forwards")
    sc = SpacecraftConfig.from_dict(twin.config)
    dt = (start - epoch).total_seconds()
    if dt < 1:
        return np.array(twin.r_km), np.array(twin.v_kms), f"twin initial state at {epoch.isoformat()}"
    body = Body(sc.wet_mass_kg, sc.structure.area_m2, sc.structure.cd, sc.structure.cr)
    tr = propagate(epoch, twin.r_km, twin.v_kms, np.array([dt]), ForceModel(j2=True, drag=True), body)
    return tr.r[0, 0], tr.v[0, 0], f"twin state propagated numerically from {epoch.isoformat()} (J2 + drag)"


def twin_dict(twin: DigitalTwin, s: Session) -> dict:
    sc = SpacecraftConfig.from_dict(twin.config)
    coe = rv_to_coe(twin.r_km, twin.v_kms)
    src_name = s.scalar(select(SpaceObject.name).where(SpaceObject.norad_id == twin.source_norad_id)) if twin.source_norad_id else None
    return {
        "id": twin.id,
        "name": twin.name,
        "organization_id": twin.organization_id,
        "created_by_id": twin.created_by_id,
        "source_norad_id": twin.source_norad_id,
        "source_name": src_name,
        "source_element_set_id": twin.source_element_set_id,
        "state_source": twin.state_source,
        "epoch": as_utc(twin.epoch).isoformat(),
        "state_teme": {"r_km": twin.r_km, "v_kms": twin.v_kms, "frame": "TEME"},
        "osculating_elements": {"a_km": coe.a_km, "e": coe.e, "i_deg": coe.i_deg, "raan_deg": coe.raan_deg,
                                "argp_deg": coe.argp_deg, "nu_deg": coe.nu_deg,
                                "perigee_alt_km": coe.a_km * (1 - coe.e) - 6378.137, "apogee_alt_km": coe.a_km * (1 + coe.e) - 6378.137},
        "config": twin.config,
        "summary": sc.summary(),
        "propulsion_model_id": twin.propulsion_model_id,
        "fuel_log": twin.fuel_log or [],
        "notes": twin.notes,
        "label": "SIMULATED digital twin. Spacecraft properties are user-configured; public orbital data has none.",
        "created_at": as_utc(twin.created_at).isoformat(),
        "updated_at": as_utc(twin.updated_at).isoformat() if twin.updated_at else None,
    }


def catalogue_satrecs(s: Session, exclude: set[int]) -> list:
    return [(e.norad_id, e.satrec) for e in catalog_cache.entries(s) if e.norad_id not in exclude]


# ---------------------------------------------------------------- plan job
def build_threats(s: Session, params: dict, start: datetime, r0, v0, force: ForceModel, body: Body) -> list[Threat]:
    unc = params.get("uncertainty", {})
    sig = tuple(unc.get("secondary_sigma_rtn_km", (0.2, 0.6, 0.2)))
    threats: list[Threat] = []
    entries = {e.norad_id: e for e in catalog_cache.entries(s)}
    for t in params.get("catalog_threats", []):
        e = entries.get(int(t))
        if e is None:
            raise LookupError(f"Threat NORAD {t} is not in the catalogue")
        threats.append(Threat(id=str(e.norad_id), name=f"{e.name or 'NORAD'} ({e.norad_id})", kind="catalog", satrec=e.satrec,
                              norad_id=e.norad_id, sigma_rtn_km=sig))
    specs = [dict(tca_s=float(x["tca_h"]) * 3600.0, miss_km=float(x["miss_m"]) / 1000.0, crossing_deg=float(x.get("crossing_deg", 60)),
                  phase_deg=float(x.get("phase_deg", 0))) for x in params.get("synthetic_threats", [])]
    if specs:
        threats += synthetic_threats(start, r0, v0, specs, force=force, body=body, sigma_rtn_km=sig)
    return threats


def configs_from_params(params: dict) -> tuple[OptimizerConfig, Uncertainty]:
    p = params.get("optimizer", {})
    method = params.get("method", "proposed")
    fm = p.get("force", {"j2": True, "drag": True})
    cfg = OptimizerConfig(
        horizon_s=float(params.get("horizon_h", 24)) * 3600.0,
        step_s=float(p.get("step_s", 20.0)),
        weights=tuple(p.get("weights", (0.5, 0.25, 0.15, 0.10))),
        pc_limit=float(p.get("pc_limit", 1e-4)),
        pc_target=float(p.get("pc_target", 1e-7)),
        d_min_km=float(p.get("d_min_m", 200.0)) / 1000.0,
        p_violation_max=float(p.get("p_violation_max", 0.05)),
        n_times=int(p.get("n_times", 6)),
        n_magnitudes=int(p.get("n_magnitudes", 8)),
        refine_rounds=int(p.get("refine_rounds", 4)),
        shortlist=int(p.get("shortlist", 5)),
        use_monte_carlo=method == "proposed",
        threat_mode="single" if method == "single" else "all",
        force=ForceModel(**{k: bool(v) for k, v in fm.items()}),
        validate=bool(p.get("validate", True)),
        screen_threshold_km=float(p.get("screen_threshold_km", 5.0)),
    )
    u = params.get("uncertainty", {})
    unc = Uncertainty(
        primary_sigma_rtn_km=tuple(u.get("primary_sigma_rtn_km", (0.1, 0.3, 0.1))),
        hbr_km=float(u.get("hbr_m", 20.0)) / 1000.0,
        mc_samples=int(u.get("mc_samples", 64)),
        initial_pos_sigma_rtn_km=tuple(u.get("initial_pos_sigma_rtn_km", (0.02, 0.05, 0.02))),
        initial_vel_sigma_rtn_mms=tuple(u.get("initial_vel_sigma_rtn_mms", (0.2, 0.5, 0.2))),
        scale=float(u.get("scale", 1.0)),
        seed=int(u.get("seed", 0)),
    )
    return cfg, unc


def run_plan(session_factory, plan_id: int) -> None:
    with session_factory() as s:
        plan = s.get(ManeuverPlan, plan_id)
        plan.status, plan.stage = "running", "preparing"
        s.commit()
        try:
            _run_plan(s, plan)
        except Exception as exc:  # recorded, never hidden
            s.rollback()
            plan = s.get(ManeuverPlan, plan_id)
            plan.status = "failed"
            plan.message = f"{exc.__class__.__name__}: {exc}"
            plan.finished_at = now()
            alert(s, "warning", "maneuver.failed", f"Maneuver plan #{plan.id} failed", plan.message, f"/maneuvers?plan={plan.id}", plan.organization_id, "maneuver:plan")
            s.add(AuditLog(kind="maneuver.failed", message=f"Maneuver plan #{plan.id} failed: {plan.message}"))
            s.commit()


def _run_plan(s: Session, plan: ManeuverPlan) -> None:
    twin = s.get(DigitalTwin, plan.twin_id)
    params = plan.params
    start = datetime.fromisoformat(params["start"])
    r0, v0, state_src = twin_state_at(s, twin, start, params.get("anchor_to_catalog", True))
    sc = SpacecraftConfig.from_dict(twin.config)
    cfg, unc = configs_from_params(params)
    body = Body(sc.wet_mass_kg, sc.structure.area_m2, sc.structure.cd, sc.structure.cr)
    threats = build_threats(s, params, start, r0, v0, cfg.force, body)
    exclude = {twin.source_norad_id} if twin.source_norad_id else set()
    catalogue = catalogue_satrecs(s, exclude) if params.get("rescreen_catalogue", True) else []

    def prog(f, msg):
        plan.progress = float(f)
        plan.stage = msg[:128]
        s.commit()

    res = optimise(start, r0, v0, sc, threats, cfg, unc, catalogue=catalogue, progress=prog)
    res["initial_state"] = {"epoch": start.isoformat(), "r_km": list(map(float, r0)), "v_kms": list(map(float, v0)),
                            "frame": "TEME", "source": state_src}
    res["twin"] = {"id": twin.id, "name": twin.name, "source_norad_id": twin.source_norad_id}
    res["method"] = plan.method
    res["versions"] = {"engine": orbitguard_engine.__version__, "maneuver": MANEUVER_VERSION, "python": platform.python_version()}
    plan.result = json.loads(json.dumps(res, default=float))
    plan.algorithm_version = MANEUVER_VERSION
    plan.status = "succeeded"
    plan.progress = 1.0
    plan.stage = res["status"]
    plan.finished_at = now()
    # candidates (nominal, selected, best 20) for inspection
    rows = []
    if res.get("nominal"):
        rows.append(("nominal", res["nominal"]))
    if res.get("selected"):
        rows.append(("selected", res["selected"]))
    for c in res.get("top_candidates", []) or res.get("shortlist", []):
        rows.append(("candidate", c))
    for rank, (role, c) in enumerate(rows):
        dv = c.get("dv_rtn_ms", [0, 0, 0])
        s.add(ManeuverCandidate(plan_id=plan.id, rank=rank, role=role, t_m=datetime.fromisoformat(c["t_m"]) if c.get("t_m") else None,
                                dv_r_ms=dv[0], dv_t_ms=dv[1], dv_n_ms=dv[2], dv_ms=c.get("dv_ms", 0.0), feasible=bool(c.get("feasible")),
                                reasons=c.get("reasons", []), objective=c.get("J"), data=json.loads(json.dumps(c, default=float))))
    st = res["status"]
    if st == "selected":
        v = res.get("validation", {}).get("status", "not run")
        alert(s, "info" if v == "passed" else "warning", "maneuver.selected",
              f"Maneuver selected for {twin.name}: {res['selected']['dv_ms'] * 1000:.1f} mm/s",
              f"Plan #{plan.id}. Independent validation: {v}.", f"/maneuvers?plan={plan.id}", plan.organization_id, "maneuver:plan")
    elif st in ("no-feasible-candidate", "no-robust-candidate"):
        alert(s, "critical", "maneuver.none", f"No acceptable maneuver for {twin.name}", res.get("message", ""),
              f"/maneuvers?plan={plan.id}", plan.organization_id, "maneuver:plan")
    s.add(AuditLog(kind="maneuver.optimised", message=f"Maneuver plan #{plan.id} for twin #{twin.id}: {st}",
                   details={"plan_id": plan.id, "actor_user_id": plan.created_by_id}))
    s.commit()


# ---------------------------------------------------------------- simulation
def _to_display(epoch: datetime, t: np.ndarray, r: np.ndarray, v: np.ndarray) -> dict:
    jd0, fr0 = datetime_to_jd(epoch)
    ecef, vel = [], []
    for k in range(len(t)):
        rf, vf = teme_to_itrf(r[k], v[k], jd0, fr0 + t[k] / 86400.0)
        ecef.append(np.round(rf, 4).tolist())
        vel.append(np.round(vf, 7).tolist())
    return {"ecef_km": ecef, "vel_kms": vel, "teme_km": np.round(r, 4).tolist()}


def run_simulation(session_factory, run_id: int) -> None:
    with session_factory() as s:
        run = s.get(SimulationRun, run_id)
        run.status = "running"
        s.commit()
        try:
            _run_simulation(s, run)
        except Exception as exc:
            s.rollback()
            run = s.get(SimulationRun, run_id)
            run.status, run.message, run.finished_at = "failed", f"{exc.__class__.__name__}: {exc}", now()
            s.commit()


def _run_simulation(s: Session, run: SimulationRun) -> None:
    plan = s.get(ManeuverPlan, run.plan_id)
    res = plan.result
    twin = s.get(DigitalTwin, run.twin_id)
    sc = SpacecraftConfig.from_dict(twin.config)
    start = datetime.fromisoformat(res["initial_state"]["epoch"])
    r0, v0 = np.array(res["initial_state"]["r_km"]), np.array(res["initial_state"]["v_kms"])
    cfg, unc = configs_from_params(plan.params)
    body = Body(sc.wet_mass_kg, sc.structure.area_m2, sc.structure.cd, sc.structure.cr)
    t = time_grid(cfg.horizon_s, DISPLAY_STEP_S)
    fidelity = run.config.get("fidelity", "validation")
    force = ForceModel.full() if fidelity == "validation" else cfg.force
    nom = propagate(start, r0, v0, t, force, body, rtol=1e-11)
    sel = res.get("selected")
    trajs = [("Original (no maneuver)", "original", nom.r[0], nom.v[0])]
    burns, maneuver = [], None
    if sel:
        dv = np.array(sel["dv_rtn_ms"])
        mag = float(np.linalg.norm(dv))
        tm = float(sel["t_m_s"])
        if fidelity == "validation":
            tb = sc.burn_duration_s(mag)
            burns = [FiniteBurn(tm - tb / 2, tb, sc.propulsion.thrust_n, sc.propulsion.isp_s, dv / mag)]
            mod = propagate(start, r0, v0, t, force, body, burns=burns, rtol=1e-11)
        else:
            mod = propagate(start, r0, v0, t, force, body, impulses=[Impulse(tm, dv / 1000.0, sc.propulsion.isp_s)], rtol=1e-11)
        trajs.append(("Modified (after maneuver)", "modified", mod.r[0], mod.v[0]))
        j = int(np.argmin(abs(t - tm)))
        pre = propagate(start, r0, v0, np.array([tm]), force, body, rtol=1e-11)
        rm, vm = pre.r[0, 0], pre.v[0, 0]
        from orbitguard_engine.numerical import rtn_to_inertial

        dvi = rtn_to_inertial(rm[None], vm[None], dv[None] / 1000.0)[0]
        jd0, fr0 = datetime_to_jd(start)
        rf, _ = teme_to_itrf(rm, vm, jd0, fr0 + tm / 86400.0)
        df, _ = teme_to_itrf(dvi, np.zeros(3), jd0, fr0 + tm / 86400.0)
        maneuver = {"t_s": tm, "time": sel["t_m"], "ecef_km": rf.tolist(), "dv_ecef_unit": (df / np.linalg.norm(df)).tolist(),
                    "dv_rtn_ms": sel["dv_rtn_ms"], "dv_ms": mag, "burn_s": sc.burn_duration_s(mag), "grid_index": j}
    else:
        mod = None
    alt, alt_info = None, None
    ai = run.config.get("alternative_index")
    if ai is not None:
        c = res["top_candidates"][ai]
        dva = np.array(c["dv_rtn_ms"])
        maga = float(np.linalg.norm(dva))
        tma = float(c["t_m_s"])
        if fidelity == "validation":
            tba = sc.burn_duration_s(maga)
            alt = propagate(start, r0, v0, t, force, body, burns=[FiniteBurn(tma - tba / 2, tba, sc.propulsion.thrust_n, sc.propulsion.isp_s, dva / maga)], rtol=1e-11)
        else:
            alt = propagate(start, r0, v0, t, force, body, impulses=[Impulse(tma, dva / 1000.0, sc.propulsion.isp_s)], rtol=1e-11)
        trajs.append((f"Alternative candidate #{ai + 1}", "alternative", alt.r[0], alt.v[0]))
        alt_info = {"index": ai, "t_s": tma, "dv_rtn_ms": c["dv_rtn_ms"], "dv_ms": maga, "J": c.get("J"),
                    "per_threat": c.get("per_threat"), "grid_index": int(np.argmin(abs(t - tma)))}
    # threats
    sig = tuple(plan.params.get("uncertainty", {}).get("secondary_sigma_rtn_km", (0.2, 0.6, 0.2)))
    threats = []
    entries = {e.norad_id: e for e in catalog_cache.entries(s)}
    for th in res["threats"]:
        if th["kind"] == "catalog":
            e = entries.get(th["norad_id"])
            if e:
                threats.append(Threat(th["id"], th["name"], "catalog", e.satrec, th["norad_id"], sigma_rtn_km=sig))
        else:
            threats.append(Threat(th["id"], th["name"], "synthetic", t_ref_s=th["t_ref_s"], r_ref=th["r_ref"], v_ref=th["v_ref"], sigma_rtn_km=sig))
    TR, TV, _ = threat_tracks(start, t, threats)
    for k, th in enumerate(threats):
        trajs.append((th.name + (" (SYNTHETIC)" if th.kind == "synthetic" else ""), "threat", TR[k], TV[k]))
    for label, kind, r, v in trajs:
        s.add(SimulationTrajectory(run_id=run.id, label=label, kind=kind, frame=FRAME_ITRF, start=start, step_s=DISPLAY_STEP_S,
                                   data=_to_display(start, t, r, v)))
    # separations vs time (for charts) and metrics
    sep = {"t_s": t.tolist(), "series": []}
    for k, th in enumerate(threats):
        d0 = np.linalg.norm(TR[k] - nom.r[0], axis=1)
        d1 = np.linalg.norm(TR[k] - mod.r[0], axis=1) if mod is not None else None
        d2 = np.linalg.norm(TR[k] - alt.r[0], axis=1) if alt is not None else None
        sep["series"].append({"threat": th.name, "before_km": np.round(d0, 4).tolist(), "after_km": None if d1 is None else np.round(d1, 4).tolist(),
                              "alternative_km": None if d2 is None else np.round(d2, 4).tolist()})
        s.add(SimulationMetric(run_id=run.id, name="min_separation_before", value=float(np.nanmin(d0)), unit="km", context={"threat": th.name}))
        if d1 is not None:
            s.add(SimulationMetric(run_id=run.id, name="min_separation_after", value=float(np.nanmin(d1)), unit="km", context={"threat": th.name}))
    alt0 = np.linalg.norm(nom.r[0], axis=1) - 6378.137
    alt1 = np.linalg.norm(mod.r[0], axis=1) - 6378.137 if mod is not None else None
    if mod is not None:
        s.add(SimulationMetric(run_id=run.id, name="final_position_offset", value=float(np.linalg.norm(mod.r[0, -1] - nom.r[0, -1])), unit="km"))
        s.add(SimulationMetric(run_id=run.id, name="propellant_used", value=float(nom.m[0, -1] - mod.m[0, -1]), unit="kg"))
    run.config = {**run.config, "maneuver": maneuver, "alternative": alt_info, "separations": sep, "d_min_km": cfg.d_min_km, "pc_limit": cfg.pc_limit,
                  "altitude": {"t_s": t[::4].tolist(), "before_km": np.round(alt0[::4], 3).tolist(),
                               "after_km": None if alt1 is None else np.round(alt1[::4], 3).tolist()},
                  "force_model": force.describe(), "start": start.isoformat(), "horizon_s": float(t[-1]),
                  "tcas": [{"threat": p["threat"], "tca": p["tca"], "miss_km": p["miss_km"]} for p in (sel or res["nominal"])["per_threat"]],
                  # refined closest approaches from the plan: without the burn, and with it
                  "encounters": [{"threat": a["threat"], "tca_before": a["tca"], "miss_before_km": a["miss_km"], "pc_before": a.get("pc"),
                                  "tca_after": b["tca"] if b else None, "miss_after_km": b["miss_km"] if b else None, "pc_after": b.get("pc") if b else None}
                                 for a, b in zip(res["nominal"]["per_threat"], (sel["per_threat"] if sel else [None] * len(res["nominal"]["per_threat"])))]}
    run.versions = {"engine": orbitguard_engine.__version__, "python": platform.python_version()}
    run.status, run.finished_at = "succeeded", now()
    s.commit()


# ---------------------------------------------------------------- experiments
def run_experiment_job(session_factory, exp_id: int) -> None:
    with session_factory() as s:
        ex = s.get(ExperimentRun, exp_id)
        ex.status = "running"
        s.commit()
        try:
            def prog(f, msg):
                ex.progress, ex.stage = float(f), msg[:160]
                s.commit()

            res = run_experiment(ex.name, seeds=ex.seeds, profile=ex.profile, progress=prog)
            ex.result = json.loads(json.dumps(res, default=lambda o: o.tolist() if hasattr(o, "tolist") else float(o)))
            ex.status, ex.progress, ex.finished_at = "succeeded", 1.0, now()
            alert(s, "info", "research.done", f"Experiment {ex.name} finished", f"{res['title']}: {len(res['runs'])} runs in {res['runtime_s']:.0f} s.",
                  f"/research?run={ex.id}", ex.organization_id, "research:read")
            s.add(AuditLog(kind="research.experiment", message=f"Experiment {ex.name} #{ex.id} finished ({len(res['runs'])} runs)"))
            s.commit()
        except Exception as exc:
            s.rollback()
            ex = s.get(ExperimentRun, exp_id)
            ex.status, ex.message, ex.finished_at = "failed", f"{exc.__class__.__name__}: {exc}", now()
            s.commit()


# ---------------------------------------------------------------- reports
def _e(x) -> str:
    return html.escape(str(x))


def _fmt(x, d=3):
    if x is None:
        return "—"
    if isinstance(x, float):
        if x != 0 and (abs(x) < 1e-3 or abs(x) >= 1e6):
            return f"{x:.{d}e}"
        return f"{x:.{d}f}"
    return _e(x)


def report_html(plan: ManeuverPlan, twin: DigitalTwin, s: Session) -> str:
    res = plan.result or {}
    sel, nom = res.get("selected"), res.get("nominal") or {}
    init = res.get("initial_state", {})
    rows_thr = "".join(
        f"<tr><td>{_e(t['name'])}</td><td>{_e(t['label'])}</td><td>{_e(t.get('norad_id') or '—')}</td>"
        f"<td>{_e(', '.join(f'{x:.3f}' for x in t['sigma_rtn_km']))}</td><td>{_e(t.get('track_status'))}</td></tr>"
        for t in res.get("threats", [])
    )
    rows_before_after = ""
    for i, b in enumerate(nom.get("per_threat", [])):
        a = sel["per_threat"][i] if sel else None
        rows_before_after += (f"<tr><td>{_e(b['threat'])}</td><td>{_e(b['tca'])}</td><td>{_fmt(b['miss_km'] * 1000, 1)}</td><td>{_fmt(b['pc'])}</td>"
                              f"<td>{_fmt(a['miss_km'] * 1000, 1) if a else '—'}</td><td>{_fmt(a['pc']) if a else '—'}</td></tr>")
    rows_cand = "".join(
        f"<tr><td>{i + 1}</td><td>{_e(c.get('t_m') or '—')}</td><td>{', '.join(f'{x * 1000:+.1f}' for x in c['dv_rtn_ms'])}</td>"
        f"<td>{_fmt(c['dv_ms'] * 1000, 1)}</td><td>{'yes' if c['feasible'] else 'no'}</td><td>{_fmt(c.get('J'), 4)}</td>"
        f"<td>{_e('; '.join(c['reasons']) or '—')}</td></tr>"
        for i, c in enumerate((res.get("top_candidates") or [])[:12])
    )
    val = res.get("validation") or {}
    rows_val = "".join(
        f"<tr><td>{_e(v['threat'])}</td><td>{_fmt(v['miss_before_km'] * 1000, 1)}</td><td>{_fmt(v['miss_after_km'] * 1000, 1)}</td>"
        f"<td>{_fmt(v['pc_before'])}</td><td>{_fmt(v['pc_after'])}</td><td>{'PASS' if v['pass'] else 'FAIL'}</td></tr>"
        for v in val.get("threats", [])
    )
    stages = "".join(f"<li>{_e(json.dumps(st))}</li>" for st in res.get("stages", []))
    expl = "".join(f"<li>{_e(x)}</li>" for x in res.get("explanation", []) or [res.get("message", "")])
    cfg = res.get("config", {})
    unc = res.get("uncertainty", {})
    sc = res.get("spacecraft", {})
    mc = res.get("monte_carlo") or {}
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>ORBITGUARD maneuver report #{plan.id}</title>
<style>
body{{font:13px/1.5 Inter,system-ui,sans-serif;color:#0e1626;max-width:980px;margin:32px auto;padding:0 20px}}
h1{{font-size:22px;margin:0}} h2{{font-size:15px;margin:28px 0 8px;border-bottom:2px solid #0e1626;padding-bottom:3px;text-transform:uppercase;letter-spacing:.06em}}
table{{border-collapse:collapse;width:100%;font-size:12px}} td,th{{border:1px solid #c8d3e3;padding:4px 6px;text-align:left;vertical-align:top}}
th{{background:#eef2f8}} .tag{{display:inline-block;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:600}}
.sim{{background:#fff4e0;color:#8a5a00}} .ok{{background:#e3f7ee;color:#0b7a4b}} .bad{{background:#fde8ec;color:#b3203a}}
code,.mono{{font-family:'JetBrains Mono',monospace;font-size:11.5px}} .muted{{color:#5b6b82}}
@media print{{body{{margin:0}}}}
</style></head><body>
<p class="muted">ORBITGUARD · technical maneuver report · generated {now().isoformat()}</p>
<h1>Maneuver plan #{plan.id}: {_e(twin.name)}</h1>
<p><span class="tag sim">SIMULATED digital twin</span> <span class="tag sim">ASSUMED covariance</span>
<span class="tag {'ok' if res.get('status') == 'selected' else 'bad'}">{_e(res.get('status', plan.status))}</span>
{f'<span class="tag {"ok" if val.get("status") == "passed" else "bad"}">validation {_e(val.get("status"))}</span>' if val else ''}</p>
<h2>1. Summary</h2><ul>{expl}</ul>
<h2>2. Input data and provenance</h2>
<table><tr><th>Twin</th><td>#{twin.id} {_e(twin.name)} (organisation #{twin.organization_id})</td></tr>
<tr><th>Initial state source</th><td>{_e(init.get('source'))}</td></tr>
<tr><th>Plan start (epoch)</th><td>{_e(init.get('epoch'))}</td></tr>
<tr><th>Method</th><td>{_e(plan.method)}</td></tr>
<tr><th>Software</th><td class="mono">{_e(json.dumps(res.get('versions', {})))} · {_e(res.get('algorithm_version'))}</td></tr></table>
<h3>Threats</h3><table><tr><th>Object</th><th>Kind</th><th>NORAD</th><th>Assumed σ RTN at TCA (km)</th><th>Track</th></tr>{rows_thr}</table>
<h2>3. Initial orbital state</h2><p class="mono">TEME r = {_e(init.get('r_km'))} km<br>TEME v = {_e(init.get('v_kms'))} km/s</p>
<h2>4. Spacecraft (user-configured)</h2><table>
<tr><th>Wet mass</th><td>{_fmt(sc.get('wet_mass_kg'), 1)} kg</td><th>Usable propellant</th><td>{_fmt(sc.get('usable_propellant_kg'), 2)} kg</td></tr>
<tr><th>Δv available</th><td>{_fmt(sc.get('dv_available_ms'), 2)} m/s</td><th>Max single burn</th><td>{_fmt(sc.get('max_single_burn_dv_ms'), 3)} m/s</td></tr></table>
<h2>5. Propagation model</h2><p>Optimisation: {_e(', '.join(cfg.get('force', [])))}. Validation: {_e(', '.join(cfg.get('validation_force', [])))}.
Horizon {_fmt((cfg.get('horizon_s') or 0) / 3600, 1)} h, grid {_fmt(cfg.get('step_s'), 0)} s. Frame: TEME of the plan epoch held fixed.</p>
<h2>6. Collision assessment (before / after)</h2>
<table><tr><th>Threat</th><th>TCA (before)</th><th>Miss before (m)</th><th>Pc before</th><th>Miss after (m)</th><th>Pc after</th></tr>{rows_before_after}</table>
<p class="muted">Pc: 2-D short-encounter model with ASSUMED covariance (primary σ {_e(unc.get('primary_sigma_rtn_km'))} km, HBR {_fmt((unc.get('hbr_km') or 0) * 1000, 0)} m, scale {_e(unc.get('scale'))}).</p>
<h2>7. Optimisation configuration</h2>
<table><tr><th>Weights (R, F, M, U)</th><td>{_e(cfg.get('weights'))}</td><th>Pc limit / target</th><td>{_e(cfg.get('pc_limit'))} / {_e(cfg.get('pc_target'))}</td></tr>
<tr><th>Min miss distance</th><td>{_fmt((cfg.get('d_min_km') or 0) * 1000, 0)} m</td><th>Max violation probability</th><td>{_e(cfg.get('p_violation_max'))}</td></tr>
<tr><th>Candidates evaluated</th><td>{_e(res.get('candidates_evaluated'))}</td><th>Rejection reasons</th><td>{_e(res.get('rejection_summary'))}</td></tr></table>
<ul class="mono">{stages}</ul>
<h2>8. Candidate comparison (best 12)</h2>
<table><tr><th>#</th><th>t_m</th><th>Δv R,T,N (mm/s)</th><th>|Δv| (mm/s)</th><th>Feasible</th><th>J</th><th>Rejection reasons</th></tr>{rows_cand}</table>
<h2>9. Selected maneuver</h2>{f'''<table><tr><th>Time</th><td>{_e(sel['t_m'])}</td><th>|Δv|</th><td>{_fmt(sel['dv_ms'] * 1000, 2)} mm/s</td></tr>
<tr><th>Δv RTN</th><td class="mono">{_e([round(x * 1000, 3) for x in sel['dv_rtn_ms']])} mm/s</td><th>Propellant</th><td>{_fmt(sel['propellant_kg'] * 1000, 2)} g ({_fmt(sel['burn_s'], 1)} s burn)</td></tr>
<tr><th>Δa / Δe / Δi</th><td>{_fmt(sel['da_km'] * 1000, 1)} m / {_fmt(sel['de'], 6)} / {_fmt(sel['di_deg'], 5)}°</td><th>Δ nodal rate</th><td>{_fmt(sel['raan_rate_change_deg_day'], 5)} °/day</td></tr>
<tr><th>Objective terms</th><td colspan="3" class="mono">{_e(sel['terms'])} · J = {_fmt(sel['J'], 4)}</td></tr></table>''' if sel else '<p><b>No maneuver selected.</b> ' + _e(res.get('message', '')) + '</p>'}
<h2>10. Robustness (Monte Carlo)</h2>{f'''<p>Probability of any threat closer than {_fmt(mc['selected']['d_min_km'] * 1000, 0)} m: <b>{mc['selected']['p_violation']:.1%}</b> after the maneuver
vs {mc['nominal']['p_violation']:.1%} without it ({mc['selected']['samples']} samples each). Assumptions: <span class="mono">{_e(mc['selected']['assumptions'])}</span></p>''' if mc else '<p>Not run for this method.</p>'}
<h2>11. Independent validation</h2>{f'''<p>{_e(val.get('method'))} → <b>{_e(val.get('status'))}</b>. Catalogue objects re-screened: {_e(val.get('catalogue_objects_screened'))};
new or closer conjunctions: {len(val.get('new_or_closer_conjunctions', []))}.</p>
<table><tr><th>Threat</th><th>Miss before (m)</th><th>Miss after (m)</th><th>Pc before</th><th>Pc after</th><th>Result</th></tr>{rows_val}</table>
<p class="muted">Constraints: {_e(val.get('constraints'))}</p>''' if val else '<p>Not run.</p>'}
<h2>12. Limitations</h2><ul>
<li>The satellite is a SIMULATED digital twin; mass, propulsion and fuel are user-configured, not telemetry.</li>
<li>Covariances are ASSUMED; TLE/GP data carries none. Pc values are therefore conditional on those assumptions.</li>
<li>Catalogue threats are propagated with SGP4 (~1 km/day accuracy class); synthetic threats are engineered test objects.</li>
<li>Static exponential atmosphere (no solar activity); low-precision Sun/Moon ephemerides; TEME of epoch treated as inertial.</li>
<li>Nothing in ORBITGUARD commands a real spacecraft.</li></ul>
</body></html>"""
