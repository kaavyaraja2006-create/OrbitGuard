"""Reproducible research experiments E1-E8 (spec section 18).

Methods compared
  none           no maneuver
  fixed          fixed +T burn (default 0.1 m/s) half a revolution before the first threat
  single         optimise against the single worst threat only (no Monte Carlo)
  multi-nominal  optimise against all objects, nominal states only (no Monte Carlo)
  proposed       optimise against all objects with Monte Carlo robustness (uncertainty-aware)

Every method's outcome is scored the same way, against ALL objects:
deterministic miss / Pc (assumed covariance), propellant, mission impact, and an
INDEPENDENT Monte Carlo (different seed, more samples) for robustness, so the
uncertainty-aware method is not graded by its own samples.

Scenarios are SYNTHETIC and labelled as such: a simulated satellite in a 700 km
Sun-synchronous orbit with engineered threats (random times, miss distances,
crossing angles; seeded). Results are whatever the runs produce; nothing is
tuned after the fact.
"""

from __future__ import annotations

import math
import platform
import time as _time
from dataclasses import replace
from datetime import datetime, timezone

import numpy as np

from . import __version__ as ENGINE_VERSION
from .constants import R_EARTH
from .elements import coe_to_rv
from .maneuver import (
    OptimizerConfig,
    Uncertainty,
    _period,
    body_of,
    evaluate,
    fixed_baseline,
    monte_carlo,
    optimise,
    synthetic_threats,
    threat_tracks,
    time_grid,
)
from .spacecraft import SpacecraftConfig

ALGORITHM_VERSION = "experiments/1.0.0"
EPOCH = datetime(2026, 11, 1, tzinfo=timezone.utc)
METHODS = ("none", "fixed", "single", "multi-nominal", "proposed")

EXPERIMENTS = {
    "E1": ("Original vs modified trajectory", "What does the selected maneuver change, threat by threat, and does an independent higher-fidelity check confirm it?"),
    "E2": ("Single-threat vs multi-threat optimisation", "Does optimising against only the worst threat leave other threats (or create new ones) unsafe?"),
    "E3": ("Nominal vs uncertainty-aware optimisation", "Is the uncertainty-aware maneuver more robust under an independent Monte Carlo, and what does that cost? Tested at the default risk target and in a fuel-first setting."),
    "E4": ("Fixed vs optimised maneuver", "How does a fixed textbook burn compare with an optimised one in success and fuel?"),
    "E5": ("Fuel budget", "How does the per-burn Δv limit affect feasibility and the Δv actually used?"),
    "E6": ("Uncertainty level", "How do larger assumed uncertainties change feasibility, Δv and robustness?"),
    "E7": ("Number of nearby objects", "How do extra nearby objects affect post-maneuver violations and runtime?"),
    "E8": ("SSO preservation", "What does preserving the Sun-synchronous nodal rate cost, and what does ignoring it change?"),
}

PROFILES = {
    "fast": dict(horizon_s=12 * 3600, n_times=4, n_magnitudes=6, refine_rounds=2, shortlist=4),
    "full": dict(horizon_s=24 * 3600, n_times=6, n_magnitudes=8, refine_rounds=4, shortlist=5),
}


# ---------------------------------------------------------------- scenarios
def make_scenario(seed: int, n_threats: int = 3, n_background: int = 0, horizon_s: float = 12 * 3600, unc_scale: float = 1.0):
    rng = np.random.default_rng(1000 + seed)
    raan, u0 = rng.uniform(0, 360), rng.uniform(0, 360)
    r0, v0 = (np.array(x) for x in coe_to_rv(R_EARTH + 700.0, 0.001, 98.19, raan, 0.0, u0))
    cfg = OptimizerConfig(horizon_s=horizon_s)
    times = np.sort(rng.uniform(0.35, 0.95, n_threats)) * horizon_s
    for k in range(1, len(times)):  # at least 40 min apart
        times[k] = max(times[k], times[k - 1] + 2400)
    times = np.minimum(times, horizon_s - 600)
    specs = [dict(tca_s=float(t), miss_km=float(rng.uniform(0.03, 0.25)), crossing_deg=float(rng.uniform(30, 150)),
                  phase_deg=float(rng.uniform(0, 360))) for t in times]
    bg = [dict(tca_s=float(rng.uniform(0.2, 0.98) * horizon_s), miss_km=float(rng.uniform(1.0, 6.0)),
               crossing_deg=float(rng.uniform(20, 160)), phase_deg=float(rng.uniform(0, 360))) for _ in range(n_background)]
    body = body_of(SpacecraftConfig())  # design the geometry against the same body the optimiser propagates
    threats = synthetic_threats(EPOCH, r0, v0, specs, force=cfg.force, body=body)
    threats += synthetic_threats(EPOCH, r0, v0, bg, force=cfg.force, body=body, prefix="SYNTH-BG") if bg else []
    return {"seed": seed, "r0": r0, "v0": v0, "threats": threats, "specs": specs, "background": bg,
            "label": "SYNTHETIC scenario (engineered threats)"}


# ---------------------------------------------------------------- scoring
def score(sc_dict, sc: SpacecraftConfig, cfg: OptimizerConfig, unc: Uncertainty, cand, mc_samples: int = 128) -> dict:
    """Common scoring of any maneuver (or none) against ALL objects of a scenario."""
    r0, v0, threats = sc_dict["r0"], sc_dict["v0"], sc_dict["threats"]
    t = time_grid(cfg.horizon_s, cfg.step_s)
    TR, TV, _ = threat_tracks(EPOCH, t, threats)
    nan = np.array([np.nan, 0.0, 0.0, 0.0])
    rows = np.vstack([nan, nan if cand is None else np.asarray(cand, float)])
    ev = evaluate(EPOCH, r0, v0, t, rows[:1], sc, cfg, unc, threats, TR, TV, None, keep_traj=True)
    nominal = {"R": ev.R[0], "V": ev.V[0], "tca": ev.tca[0]}
    ev2 = evaluate(EPOCH, r0, v0, t, rows, sc, cfg, unc, threats, TR, TV, nominal)
    n = 1
    miss, pc, m = ev2.miss[n], ev2.pc[n], ev2.metrics[n]
    unsafe = int(np.sum((miss < cfg.d_min_km) | (pc > cfg.pc_limit)))
    newly = int(np.sum(((miss < cfg.d_min_km) | (pc > cfg.pc_limit)) & ~((ev2.miss[0] < cfg.d_min_km) | (ev2.pc[0] > cfg.pc_limit))))
    mc = monte_carlo(EPOCH, r0, v0, t, rows[n], sc, cfg, unc, threats, TR, TV, n=mc_samples, seed=987654 + sc_dict["seed"])
    other = [r for r in ev2.reasons[n] if not r.startswith("unsafe")]
    return {
        "success": unsafe == 0 and not other,
        "violations_after": unsafe,
        "new_violations": newly,
        "constraint_violations": other,
        "dv_ms": m["dv_ms"],
        "propellant_g": m["propellant_kg"] * 1000,
        "min_sep_m": float(np.min(miss) * 1000),
        "max_pc_after": float(np.max(pc)),
        "min_sep_before_m": float(np.min(ev2.miss[0]) * 1000),
        "max_pc_before": float(np.max(ev2.pc[0])),
        "da_m": m["da_km"] * 1000,
        "di_deg": m["di_deg"],
        "raan_rate_change_deg_day": m["raan_rate_change_deg_day"],
        "p_violation_independent": mc["p_violation"],
    }


def run_method(method: str, scen, sc: SpacecraftConfig, cfg: OptimizerConfig, unc: Uncertainty, fixed_dv_ms=0.1) -> dict:
    t0 = _time.perf_counter()
    cand, status, extra = None, "none", {}
    if method == "fixed":
        out = fixed_baseline(EPOCH, scen["r0"], scen["v0"], sc, scen["threats"], cfg, unc, dv_ms=fixed_dv_ms)
        s = out["selected"]
        cand = [s["t_m_s"], *s["dv_rtn_ms"]]
        status = "applied"
    elif method in ("single", "multi-nominal", "proposed"):
        c = replace(cfg, threat_mode="single" if method == "single" else "all", use_monte_carlo=(method == "proposed"), validate=False)
        res = optimise(EPOCH, scen["r0"], scen["v0"], sc, scen["threats"], c, unc)
        status = res["status"]
        if res.get("selected"):
            s = res["selected"]
            cand = [s["t_m_s"], *s["dv_rtn_ms"]]
        extra = {"candidates_evaluated": res.get("candidates_evaluated", 0)}
    runtime = _time.perf_counter() - t0
    sc_out = score(scen, sc, cfg, unc, cand)
    return {"method": method, "seed": scen["seed"], "status": status, "maneuver": cand, "runtime_s": runtime, **extra, **sc_out}


# ---------------------------------------------------------------- aggregation
def _agg(rows, keys=("success", "dv_ms", "propellant_g", "min_sep_m", "violations_after", "new_violations", "p_violation_independent", "runtime_s", "raan_rate_change_deg_day")):
    out = {"n": len(rows)}
    for k in keys:
        vals = np.array([float(r[k]) for r in rows if r.get(k) is not None], float)
        if len(vals):
            out[f"{k}_mean"] = float(vals.mean())
            out[f"{k}_std"] = float(vals.std(ddof=1)) if len(vals) > 1 else 0.0
    out["selected_rate"] = float(np.mean([r["maneuver"] is not None for r in rows])) if rows else 0.0
    out["max_pc_after_median"] = float(np.median([r["max_pc_after"] for r in rows])) if rows else None
    return out


def run_experiment(name: str, seeds: int = 3, profile: str = "fast", progress=None) -> dict:
    if name not in EXPERIMENTS:
        raise ValueError(f"unknown experiment {name}")
    prog = progress or (lambda f, m: None)
    base_cfg = OptimizerConfig(**PROFILES[profile])
    unc = Uncertainty(mc_samples=48 if profile == "fast" else 64)
    sc0 = SpacecraftConfig()
    started = datetime.now(timezone.utc)
    wall = _time.perf_counter()
    plan = []  # (group label, method, seed, cfg, unc, sc, scenario kwargs)

    def add(group, methods, cfg=base_cfg, u=unc, sc=sc0, **scen_kw):
        for s in range(seeds):
            for m in methods:
                plan.append((group, m, s, cfg, u, sc, scen_kw))

    if name == "E1":
        add("scenario", ["none", "proposed"])
    elif name == "E2":
        add("3 threats + 4 nearby", ["single", "multi-nominal"], n_background=4)
    elif name == "E3":
        # Two operating points: the default risk target (Pc 1e-7) and a fuel-first setting where risk earns
        # nothing below the hard Pc limit, so the nominal optimiser sits right at the limit.
        add("Pc target 1e-7 (default)", ["multi-nominal", "proposed"])
        add("fuel-first (target = limit)", ["multi-nominal", "proposed"], cfg=replace(base_cfg, pc_target=base_cfg.pc_limit))
    elif name == "E4":
        add("3 threats", ["none", "fixed", "proposed"])
    elif name == "E5":
        for b in (0.02, 0.05, 0.1, 0.25, 0.5, 1.0):
            sc = SpacecraftConfig()
            sc.propulsion.max_dv_per_burn_ms = b
            add(f"{b:g} m/s", ["proposed"], sc=sc)
    elif name == "E6":
        for f in (0.5, 1.0, 2.0, 3.0):
            add(f"x{f:g}", ["multi-nominal", "proposed"], u=replace(unc, scale=f), unc_scale=f)
    elif name == "E7":
        for nb in (0, 4, 8, 16):
            add(f"{nb} nearby", ["single", "proposed"], n_background=nb)
    elif name == "E8":
        for keep in (True, False):
            sc = SpacecraftConfig()
            sc.mission.preserve_sso = keep
            add("SSO preserved" if keep else "unconstrained", ["proposed"], sc=sc)

    rows = []
    cache = {}
    for i, (group, method, seed, cfg, u, sc, kw) in enumerate(plan):
        key = (seed, tuple(sorted(kw.items())))
        if key not in cache:
            cache[key] = make_scenario(seed, horizon_s=cfg.horizon_s, n_background=kw.get("n_background", 0))
        r = run_method(method, cache[key], sc, cfg, u)
        r["group"] = group
        rows.append(r)
        prog((i + 1) / len(plan), f"{group} · {method} · seed {seed}")

    summary = []
    for group in dict.fromkeys(r["group"] for r in rows):
        for method in dict.fromkeys(r["method"] for r in rows):
            sel = [r for r in rows if r["group"] == group and r["method"] == method]
            if sel:
                summary.append({"group": group, "method": method, **_agg(sel)})

    detail = None
    if name == "E1":
        scen = cache[next(iter(cache))]
        res = optimise(EPOCH, scen["r0"], scen["v0"], sc0, scen["threats"], replace(base_cfg, validate=True), unc)
        detail = {"status": res["status"], "explanation": res.get("explanation"), "validation": res.get("validation"),
                  "nominal": res.get("nominal"), "selected": res.get("selected")}

    return {
        "experiment": name,
        "title": EXPERIMENTS[name][0],
        "question": EXPERIMENTS[name][1],
        "profile": profile,
        "seeds": seeds,
        "methods": sorted({r["method"] for r in rows}, key=METHODS.index),
        "config": {"optimizer": base_cfg.to_dict(), "uncertainty": unc.__dict__, "spacecraft": sc0.to_dict(),
                   "scenario": "SYNTHETIC: 700 km SSO, threats with miss 30-250 m, crossing 30-150 deg; background objects 1-6 km"},
        "runs": rows,
        "summary": summary,
        "detail": detail,
        "started": started.isoformat(),
        "runtime_s": _time.perf_counter() - wall,
        "versions": {"engine": ENGINE_VERSION, "experiments": ALGORITHM_VERSION, "python": platform.python_version(),
                     "numpy": np.__version__},
        "label": "SYNTHETIC scenarios; assumed uncertainties. Results are exactly what these runs produced.",
    }


def to_csv(result: dict) -> str:
    keys = ["group", "method", "seed", "status", "success", "violations_after", "new_violations", "dv_ms", "propellant_g",
            "min_sep_before_m", "min_sep_m", "max_pc_before", "max_pc_after", "p_violation_independent", "da_m", "di_deg",
            "raan_rate_change_deg_day", "runtime_s"]
    lines = [",".join(keys)]
    for r in result["runs"]:
        lines.append(",".join("" if r.get(k) is None else (f"{r[k]:.6g}" if isinstance(r[k], float) else str(r[k])) for k in keys))
    return "\n".join(lines) + "\n"


_ = (math, _period)
