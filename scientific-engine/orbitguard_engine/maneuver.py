"""Uncertainty-aware multi-threat collision-avoidance maneuver optimisation.

Pipeline (each stage is recorded so the result can be explained and reproduced)

0. Nominal: the simulated satellite is propagated numerically (no maneuver) and
   every threat is evaluated: closest approach, miss distance and Pc.
1. Candidate generation: u = [t_m, Δv_R, Δv_T, Δv_N] on a bounded grid of
   maneuver times x allowed directions x magnitudes. Every candidate is
   propagated numerically (all candidates together as one batched ODE).
2. Hard constraints (Δv, propellant, burn time, directions, maneuver window,
   altitude band, inclination band, eccentricity, SSO preservation, per-threat
   miss distance and Pc). Violations are recorded per candidate.
3. Objective  J(u) = w1 R + w2 F + w3 M + w4 U  on feasible candidates:
     R  residual risk   max_k clip((log10 Pc_k - log10 Pc_target) / (log10 Pc_limit - log10 Pc_target), 0, 1)
                        (no extra credit for pushing Pc below the target, so fuel then decides)
     F  fuel            |Δv| / Δv_max_single_burn
     M  mission         (|Δa|/Δa_tol + |Δi|/Δi_tol + |Δe|/Δe_tol) / 3   (post-burn, vs nominal)
     U  robustness      Monte Carlo probability that any threat comes closer than d_min
4. Local refinement (pattern search with shrinking steps) around the best feasible candidates.
5. Monte Carlo robustness on a shortlist: initial-state errors and execution errors
   (magnitude, pointing) are propagated through the nonlinear dynamics; secondary
   position errors are sampled at TCA. Ranking by the full J; hard robustness limit.
6. Independent validation of the selected maneuver with a different, higher-fidelity
   setup: full force model, FINITE burn of the twin's thrust centred on t_m,
   tighter tolerances, all threats re-evaluated, constraints re-checked, and the
   catalogue re-screened for secondary conjunctions created by the maneuver.

If nothing satisfies the hard constraints, the result says so. Nothing is ever
reported as avoided without propagating the modified trajectory.
"""

from __future__ import annotations

import math
import time as _time
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta

import numpy as np
from sgp4.api import Satrec, SatrecArray

from .collision import encounter_plane, pc_2d, project_covariance
from .constants import MU_EARTH, R_EARTH, SSO_RAAN_RATE_DEG_DAY
from .conjunction import shell_radii
from .elements import j2_secular_rates
from .forces import G0, ForceModel
from .frames import datetime_to_jd
from .numerical import Body, FiniteBurn, Impulse, propagate, rtn_matrices
from .spacecraft import SpacecraftConfig

ALGORITHM_VERSION = "maneuver-optimisation/1.0.0"
DIR_VECTORS = {"+R": (1, 0, 0), "-R": (-1, 0, 0), "+T": (0, 1, 0), "-T": (0, -1, 0), "+N": (0, 0, 1), "-N": (0, 0, -1)}
PC_FLOOR = 1e-10
TRIM_FACTORS = (0.85, 0.7, 0.55, 0.4)
MARGIN_TIERS = (1.5, 2.0, 3.0, 5.0, 8.0, 12.0, 20.0, 30.0, 50.0)


# ================================================================ inputs
@dataclass
class Threat:
    id: str
    name: str
    kind: str  # "catalog" | "synthetic"
    satrec: Satrec | None = None
    norad_id: int | None = None
    # synthetic threats are defined by a state at t_ref_s (seconds after the plan epoch)
    t_ref_s: float | None = None
    r_ref: list[float] | None = None
    v_ref: list[float] | None = None
    sigma_rtn_km: tuple[float, float, float] = (0.2, 0.6, 0.2)  # ASSUMED 1-sigma at TCA

    def public(self) -> dict:
        d = {k: v for k, v in asdict(self).items() if k != "satrec"}
        d["label"] = "SYNTHETIC (engineered test object)" if self.kind == "synthetic" else "catalogue object (SGP4)"
        return d


@dataclass
class Uncertainty:
    """All values are ASSUMED (TLE data carries no covariance)."""

    primary_sigma_rtn_km: tuple[float, float, float] = (0.1, 0.3, 0.1)  # at TCA, for analytical Pc
    hbr_km: float = 0.02
    mc_samples: int = 64
    initial_pos_sigma_rtn_km: tuple[float, float, float] = (0.02, 0.05, 0.02)
    initial_vel_sigma_rtn_mms: tuple[float, float, float] = (0.2, 0.5, 0.2)  # mm/s
    scale: float = 1.0  # multiplies every sigma (sensitivity experiments)
    seed: int = 0


@dataclass
class OptimizerConfig:
    horizon_s: float = 86400.0
    step_s: float = 20.0
    weights: tuple[float, float, float, float] = (0.5, 0.25, 0.15, 0.10)
    pc_limit: float = 1e-4
    pc_target: float = 1e-7
    d_min_km: float = 0.2
    p_violation_max: float = 0.05
    n_times: int = 6
    n_magnitudes: int = 8
    refine_rounds: int = 4
    refine_top_k: int = 3
    shortlist: int = 5
    use_monte_carlo: bool = True  # False -> "multi-threat nominal" baseline
    threat_mode: str = "all"  # "all" | "single" (single-threat baseline: only the worst threat)
    force: ForceModel = field(default_factory=lambda: ForceModel(j2=True, drag=True))
    validation_force: ForceModel = field(default_factory=ForceModel.full)
    validate: bool = True
    screen_threshold_km: float = 5.0
    rtol: float = 1e-9

    def to_dict(self) -> dict:
        d = asdict(self)
        d["force"] = self.force.describe()
        d["validation_force"] = self.validation_force.describe()
        return d


# ================================================================ helpers
def time_grid(horizon_s: float, step_s: float) -> np.ndarray:
    n = int(math.floor(horizon_s / step_s + 1e-9))
    t = np.arange(n + 1) * step_s
    return t if t[-1] == horizon_s else np.append(t, horizon_s)


_REVERSIBLE = ForceModel(j2=True, j3=True, j4=True)  # conservative, time-independent: can run backwards


def _propagate_from_reference(epoch, t_ref, r_ref, v_ref, t):
    """Conservative-force propagation of one object to all grid times, forwards and backwards from t_ref."""
    out_r = np.empty((len(t), 3))
    out_v = np.empty((len(t), 3))
    fwd = t >= t_ref
    if fwd.any():
        tr = propagate(epoch + timedelta(seconds=t_ref), r_ref, v_ref, t[fwd] - t_ref, _REVERSIBLE)
        out_r[fwd], out_v[fwd] = tr.r[0], tr.v[0]
    bwd = ~fwd
    if bwd.any():
        # time reversal: (r, -v) forward by dt equals (r, v) backward by dt for conservative static fields
        dt = (t_ref - t[bwd])[::-1]
        tr = propagate(epoch, r_ref, -np.asarray(v_ref), dt, _REVERSIBLE)
        out_r[bwd] = tr.r[0][::-1]
        out_v[bwd] = -tr.v[0][::-1]
    return out_r, out_v


def threat_tracks(epoch: datetime, t: np.ndarray, threats: list[Threat]):
    K = len(threats)
    TR = np.full((K, len(t), 3), np.nan)
    TV = np.full((K, len(t), 3), np.nan)
    status = []
    jd0, fr0 = datetime_to_jd(epoch)
    for k, th in enumerate(threats):
        if th.kind == "catalog":
            e, r, v = th.satrec.sgp4_array(np.full(len(t), jd0), fr0 + t / 86400.0)
            ok = e == 0
            TR[k, ok], TV[k, ok] = r[ok], v[ok]
            status.append("ok" if ok.all() else f"SGP4 failed at {int((~ok).sum())} of {len(t)} times")
        else:
            TR[k], TV[k] = _propagate_from_reference(epoch, th.t_ref_s, th.r_ref, th.v_ref, t)
            status.append("ok")
    return TR, TV, status


def closest_approaches(t, R, V, TR, TV):
    """Per candidate n and threat k: global minimum distance over the horizon.

    Uses the in-interval linearised relative motion (the screening method). With a
    20 s grid the linearisation error near closest approach is below a metre
    (relative acceleration ~ gravity-gradient x separation).
    """
    N, K = R.shape[0], TR.shape[0]
    miss = np.full((N, K), np.inf)
    tca = np.zeros((N, K))
    rrel = np.zeros((N, K, 3))
    vrel = np.zeros((N, K, 3))
    j_at = np.zeros((N, K), int)
    tau_at = np.zeros((N, K))
    h = np.diff(t)
    for k in range(K):
        dr = TR[k][None] - R  # (N, T, 3) secondary minus primary
        dv = TV[k][None] - V
        dr0, dv0 = dr[:, :-1], dv[:, :-1]
        dvv = np.einsum("ijk,ijk->ij", dv0, dv0)
        with np.errstate(invalid="ignore", divide="ignore"):
            tau = np.where(dvv > 0, -np.einsum("ijk,ijk->ij", dr0, dv0) / np.where(dvv > 0, dvv, 1.0), 0.0)
        tau = np.clip(tau, 0.0, h[None, :])
        d = np.linalg.norm(dr0 + dv0 * tau[..., None], axis=2)
        d = np.where(np.isnan(d), np.inf, d)
        j = np.argmin(d, axis=1)
        idx = np.arange(N)
        miss[:, k] = d[idx, j]
        tca[:, k] = t[j] + tau[idx, j]
        rrel[:, k] = dr0[idx, j] + dv0[idx, j] * tau[idx, j][:, None]
        vrel[:, k] = dv0[idx, j]
        j_at[:, k] = j
        tau_at[:, k] = tau[idx, j]
    return {"miss": miss, "tca": tca, "rrel": rrel, "vrel": vrel, "j": j_at, "tau": tau_at}


def _cov_rtn(r, v, sig):
    m = rtn_matrices(r[None], v[None])[0]
    return m.T @ np.diag(np.square(sig)) @ m


def pc_values(ca, R, V, TR, TV, threats, unc: Uncertainty):
    """Analytical 2-D Pc per candidate/threat with ASSUMED covariances (primary + secondary)."""
    N, K = ca["miss"].shape
    pc = np.zeros((N, K))
    sp = np.asarray(unc.primary_sigma_rtn_km) * unc.scale
    for k in range(K):
        ss = np.asarray(threats[k].sigma_rtn_km) * unc.scale
        for n in range(N):
            if not np.isfinite(ca["miss"][n, k]):
                continue
            j, tau = ca["j"][n, k], ca["tau"][n, k]
            rp, vp = R[n, j] + V[n, j] * tau, V[n, j]
            rs, vs = TR[k, j] + TV[k, j] * tau, TV[k, j]
            C = _cov_rtn(rp, vp, sp) + _cov_rtn(rs, vs, ss)
            basis, m2 = encounter_plane(ca["rrel"][n, k], ca["vrel"][n, k])
            pc[n, k] = pc_2d(m2, project_covariance(basis, C), unc.hbr_km)
    return pc


def _osc(r, v):
    """Vectorised osculating a, e, i (deg)."""
    rn = np.linalg.norm(r, axis=-1)
    v2 = np.sum(v * v, axis=-1)
    a = 1.0 / (2.0 / rn - v2 / MU_EARTH)
    h = np.cross(r, v)
    hn = np.linalg.norm(h, axis=-1)
    evec = np.cross(v, h) / MU_EARTH - r / rn[..., None]
    e = np.linalg.norm(evec, axis=-1)
    i = np.degrees(np.arccos(np.clip(h[..., 2] / hn, -1, 1)))
    return a, e, i


def _risk_term(pc_row, pc_limit, pc_target):
    worst = max(PC_FLOOR, float(np.max(pc_row))) if len(pc_row) else PC_FLOOR
    span = math.log10(pc_limit) - math.log10(pc_target)
    if span <= 0:  # target at (or above) the limit: risk only matters above the limit (step)
        return 0.0 if worst <= pc_limit else 1.0
    x = (math.log10(worst) - math.log10(pc_target)) / span
    return min(1.0, max(0.0, x))


# ============================================================== candidates
def candidate_grid(t_first_tca: float, period_s: float, sc: SpacecraftConfig, cfg: OptimizerConfig) -> np.ndarray:
    """[t_m (s), dvR, dvT, dvN (m/s)] rows. Times include (k + 1/2) revolutions before the first TCA,
    where an along-track burn has the largest effect on the radial miss."""
    at = sc.attitude
    lo = at.min_lead_time_s
    hi = t_first_tca - at.min_time_before_tca_s
    if hi <= lo:
        return np.zeros((0, 4))
    times = {t_first_tca - (k + 0.5) * period_s for k in range(8)}
    times = sorted(x for x in times if lo <= x <= hi)[-max(1, cfg.n_times // 2):]
    extra = np.linspace(lo, hi, max(2, cfg.n_times - len(times)))
    times = sorted(set(np.round(np.concatenate([times, extra]), 1)))
    dv_hi = sc.max_single_burn_dv_ms()
    dv_lo = max(sc.propulsion.min_impulse_dv_ms, 1e-3)
    if dv_hi <= dv_lo:
        return np.zeros((0, 4))
    mags = np.geomspace(dv_lo * 5, dv_hi, cfg.n_magnitudes)
    rows = []
    for tm in times:
        for d in at.allowed_directions:
            u = np.array(DIR_VECTORS[d], float)
            for m in mags:
                rows.append([tm, *(u * m)])
    return np.array(rows)


def _impulses(cands: np.ndarray, isp: float) -> list[Impulse]:
    """Group candidates by maneuver time: one Impulse per distinct time, zero rows elsewhere."""
    out = []
    for tm in np.unique(cands[:, 0]):
        if not np.isfinite(tm):
            continue
        dv = np.where((cands[:, 0] == tm)[:, None], cands[:, 1:4] / 1000.0, 0.0)
        out.append(Impulse(float(tm), dv, isp_s=isp))
    return out


# ============================================================== evaluation
@dataclass
class Evaluation:
    cands: np.ndarray
    miss: np.ndarray
    tca: np.ndarray
    pc: np.ndarray
    feasible: np.ndarray
    reasons: list[list[str]]
    metrics: list[dict]
    terms: np.ndarray  # (N, 4) R F M U (U = nan until Monte Carlo)
    J: np.ndarray
    R: np.ndarray | None = None
    V: np.ndarray | None = None


def evaluate(epoch, r0, v0, t, cands, sc: SpacecraftConfig, cfg: OptimizerConfig, unc: Uncertainty, threats, TR, TV,
             nominal: dict | None, keep_traj=False, force=None, rtol=None) -> Evaluation:
    """Propagate candidates (rows of [t_m, dvR, dvT, dvN] m/s; t_m = nan means no maneuver) and score them."""
    N = len(cands)
    body = Body(mass_kg=sc.wet_mass_kg, area_m2=sc.structure.area_m2, cd=sc.structure.cd, cr=sc.structure.cr)
    tr = propagate(epoch, np.repeat(np.atleast_2d(r0), N, 0), np.repeat(np.atleast_2d(v0), N, 0), t,
                   force or cfg.force, body, impulses=_impulses(cands, sc.propulsion.isp_s), rtol=rtol or cfg.rtol)
    R, V = tr.r, tr.v
    ca = closest_approaches(t, R, V, TR, TV)
    pc = pc_values(ca, R, V, TR, TV, threats, unc)
    alt = np.linalg.norm(R, axis=2) - R_EARTH
    m, mi, at = sc.mission, sc.propulsion, sc.attitude
    first_tca = float(np.min(nominal["tca"])) if nominal is not None else float(np.min(ca["tca"][0]))
    feasible = np.ones(N, bool)
    reasons: list[list[str]] = []
    metrics: list[dict] = []
    terms = np.full((N, 4), np.nan)
    for n in range(N):
        tm, dvr, dvt, dvn = cands[n]
        dv = float(np.linalg.norm(cands[n, 1:]))
        why = []
        has_burn = np.isfinite(tm) and dv > 0
        prop = sc.propellant_for(dv) if has_burn else 0.0
        burn_s = sc.burn_duration_s(dv) if has_burn else 0.0
        if has_burn:
            for comp, (pos, neg) in zip((dvr, dvt, dvn), (("+R", "-R"), ("+T", "-T"), ("+N", "-N"))):
                if comp > 1e-9 and pos not in at.allowed_directions or comp < -1e-9 and neg not in at.allowed_directions:
                    why.append("direction not allowed by attitude constraints")
                    break
            if dv > sc.max_single_burn_dv_ms() + 1e-12:
                why.append("Δv above the single-burn limit")
            if dv < mi.min_impulse_dv_ms:
                why.append("Δv below the minimum controllable impulse")
            if prop > sc.usable_propellant_kg:
                why.append("not enough usable propellant")
            if burn_s > mi.max_burn_s:
                why.append("burn longer than the maximum burn duration")
            if tm < at.min_lead_time_s:
                why.append("before the earliest executable time")
            if tm > first_tca - at.min_time_before_tca_s:
                why.append("too close to (or after) the first threat")
        if alt[n].min() < m.alt_min_km or alt[n].max() > m.alt_max_km:
            why.append("altitude leaves the mission band")
        # post-burn osculating elements, compared with the nominal at the same instant
        jp = int(np.searchsorted(t, tm, side="right")) if has_burn else 1
        jp = min(max(jp, 0), len(t) - 1)
        a1, e1, i1 = _osc(R[n, jp], V[n, jp])
        if nominal is not None:
            a0, e0, i0 = _osc(nominal["R"][jp], nominal["V"][jp])
        else:
            a0, e0, i0 = a1, e1, i1
        if not (m.inc_min_deg <= i1 <= m.inc_max_deg):
            why.append("inclination outside the mission band")
        if e1 > m.ecc_max:
            why.append("eccentricity above the mission limit")
        rate1 = math.degrees(j2_secular_rates(a1, e1, i1)[0]) * 86400
        rate0 = math.degrees(j2_secular_rates(a0, e0, i0)[0]) * 86400
        if m.preserve_sso and abs(rate1 - rate0) > m.sso_rate_tol_deg_day:
            why.append("breaks Sun-synchronous nodal rate")
        unsafe = [threats[k].name for k in range(len(threats)) if ca["miss"][n, k] < cfg.d_min_km or pc[n, k] > cfg.pc_limit]
        if unsafe:
            why.append("unsafe vs " + ", ".join(unsafe[:3]) + ("…" if len(unsafe) > 3 else ""))
        Rt = _risk_term(pc[n], cfg.pc_limit, cfg.pc_target)
        Ft = dv / max(sc.max_single_burn_dv_ms(), 1e-9)
        Mt = (abs(a1 - a0) / m.da_tol_km + abs(i1 - i0) / m.di_tol_deg + abs(e1 - e0) / m.de_tol) / 3.0
        terms[n, :3] = (Rt, Ft, Mt)
        feasible[n] = not why
        reasons.append(why)
        metrics.append(
            {
                "dv_ms": dv,
                "propellant_kg": prop,
                "burn_s": burn_s,
                "da_km": a1 - a0,
                "de": e1 - e0,
                "di_deg": i1 - i0,
                "raan_rate_change_deg_day": rate1 - rate0,
                "sso_rate_deg_day": rate1,
                "alt_min_km": float(alt[n].min()),
                "alt_max_km": float(alt[n].max()),
            }
        )
    w = np.asarray(cfg.weights, float)
    J = terms[:, :3] @ w[:3]
    ev = Evaluation(cands, ca["miss"], ca["tca"], pc, feasible, reasons, metrics, terms, J)
    if keep_traj:
        ev.R, ev.V = R, V
    return ev


# ============================================================ Monte Carlo
def monte_carlo(epoch, r0, v0, t, cand, sc: SpacecraftConfig, cfg: OptimizerConfig, unc: Uncertainty, threats, TR, TV, n=None, seed=None) -> dict:
    """Probability that any threat comes closer than d_min, under ASSUMED initial-state, execution and
    secondary-position errors, propagated through the full nonlinear dynamics."""
    n = n or unc.mc_samples
    rng = np.random.default_rng(unc.seed if seed is None else seed)
    s = unc.scale
    m0 = rtn_matrices(np.atleast_2d(r0), np.atleast_2d(v0))[0]
    dr = rng.normal(size=(n, 3)) * np.asarray(unc.initial_pos_sigma_rtn_km) * s
    dv0 = rng.normal(size=(n, 3)) * np.asarray(unc.initial_vel_sigma_rtn_mms) * 1e-6 * s
    rs = np.asarray(r0)[None] + dr @ m0
    vs = np.asarray(v0)[None] + dv0 @ m0
    impulses = []
    tm = cand[0]
    dvn = np.asarray(cand[1:], float)
    if np.isfinite(tm) and np.linalg.norm(dvn) > 0:
        mag = np.linalg.norm(dvn)
        # execution errors: magnitude (fraction) and pointing (small random tilt)
        k = 1.0 + rng.normal(size=n) * sc.attitude.magnitude_error_frac * s
        tilt = rng.normal(size=(n, 3)) * math.radians(sc.attitude.pointing_accuracy_deg) * s
        u = dvn / mag
        tilt -= (tilt @ u)[:, None] * u[None]
        dirs = u[None] + tilt
        dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
        impulses = [Impulse(float(tm), dirs * (mag * k)[:, None] / 1000.0, isp_s=sc.propulsion.isp_s)]
    body = Body(mass_kg=sc.wet_mass_kg, area_m2=sc.structure.area_m2, cd=sc.structure.cd, cr=sc.structure.cr)
    tr = propagate(epoch, rs, vs, t, cfg.force, body, impulses=impulses, rtol=cfg.rtol)
    ca = closest_approaches(t, tr.r, tr.v, TR, TV)
    miss = ca["miss"].copy()
    # secondary position error at TCA (assumed), applied in each threat's RTN frame
    for kk, th in enumerate(threats):
        ss = np.asarray(th.sigma_rtn_km) * s
        for i in range(n):
            j, tau = ca["j"][i, kk], ca["tau"][i, kk]
            mk = rtn_matrices(TR[kk, j][None], TV[kk, j][None])[0]
            off = (rng.normal(size=3) * ss) @ mk
            rel = ca["rrel"][i, kk] + off
            vr = ca["vrel"][i, kk]
            # keep the encounter-plane component (the along-velocity part shifts TCA, not the miss)
            vhat = vr / max(np.linalg.norm(vr), 1e-12)
            miss[i, kk] = np.linalg.norm(rel - (rel @ vhat) * vhat)
    worst = miss.min(axis=1)
    viol = worst < cfg.d_min_km
    hits = worst < unc.hbr_km
    p = float(viol.mean())
    return {
        "samples": n,
        "p_violation": p,
        "p_violation_ci95": [max(0.0, p - 1.96 * math.sqrt(p * (1 - p) / n)), min(1.0, p + 1.96 * math.sqrt(max(p * (1 - p), 1e-12) / n))],
        "hits_within_hbr": int(hits.sum()),
        "pc_mc_upper_95": (3.0 / n) if hits.sum() == 0 else None,
        "worst_miss_km_percentiles": dict(zip(("p5", "p50", "p95"), np.percentile(worst, [5, 50, 95]).tolist())),
        "per_threat_min_miss_km_p5": np.percentile(miss, 5, axis=0).tolist(),
        "d_min_km": cfg.d_min_km,
        "assumptions": {
            "initial_pos_sigma_rtn_km": list(np.asarray(unc.initial_pos_sigma_rtn_km) * s),
            "initial_vel_sigma_rtn_mms": list(np.asarray(unc.initial_vel_sigma_rtn_mms) * s),
            "execution_magnitude_sigma": sc.attitude.magnitude_error_frac * s,
            "execution_pointing_sigma_deg": sc.attitude.pointing_accuracy_deg * s,
            "secondary_sigma_rtn_km": "per threat (ASSUMED), scaled by %.2f" % s,
        },
    }


# ============================================================ catalogue screen
def screen_trajectory(epoch, t, Rp, Vp, satrecs: list[tuple[int, Satrec]], threshold_km: float, chunk=256) -> list[dict]:
    """Screen one numerically propagated trajectory against SGP4 catalogue objects."""
    if not satrecs:
        return []
    r_norm = np.linalg.norm(Rp, axis=1)
    rp_min, rp_max = r_norm.min(), r_norm.max()
    kept = []
    for oid, s in satrecs:
        lo, hi = shell_radii(s)
        if not (lo > rp_max + 50 + threshold_km or hi < rp_min - 50 - threshold_km):
            kept.append((oid, s))
    jd0, fr0 = datetime_to_jd(epoch)
    jd = np.full(len(t), jd0)
    fr = fr0 + t / 86400.0
    out = []
    for c0 in range(0, len(kept), chunk):
        part = kept[c0 : c0 + chunk]
        e, r, v = SatrecArray([s for _, s in part]).sgp4(jd, fr)
        r = np.where((e == 0)[..., None], r, np.nan)
        v = np.where((e == 0)[..., None], v, np.nan)
        ca = closest_approaches(t, r, v, Rp[None], Vp[None])  # roles swapped: "candidates" = catalogue
        for i, (oid, _) in enumerate(part):
            if ca["miss"][i, 0] <= threshold_km:
                out.append({"norad_id": int(oid), "tca_s": float(ca["tca"][i, 0]), "miss_km": float(ca["miss"][i, 0]),
                            "relative_speed_kms": float(np.linalg.norm(ca["vrel"][i, 0]))})
    return sorted(out, key=lambda x: x["miss_km"])


# ============================================================ optimiser
def _cand_dict(ev: Evaluation, n: int, threats, epoch) -> dict:
    tm, r_, t_, n_ = ev.cands[n]
    return {
        "t_m_s": None if not np.isfinite(tm) else float(tm),
        "t_m": None if not np.isfinite(tm) else (epoch + timedelta(seconds=float(tm))).isoformat(),
        "dv_rtn_ms": [float(r_), float(t_), float(n_)],
        "feasible": bool(ev.feasible[n]),
        "reasons": ev.reasons[n],
        "per_threat": [
            {"threat": threats[k].name, "miss_km": float(ev.miss[n, k]), "pc": float(ev.pc[n, k]),
             "tca": (epoch + timedelta(seconds=float(ev.tca[n, k]))).isoformat()}
            for k in range(len(threats))
        ],
        "terms": {"R": float(ev.terms[n, 0]), "F": float(ev.terms[n, 1]), "M": float(ev.terms[n, 2]),
                  "U": None if np.isnan(ev.terms[n, 3]) else float(ev.terms[n, 3])},
        "J": float(ev.J[n]),
        **ev.metrics[n],
    }


def body_of(sc: SpacecraftConfig) -> Body:
    """The physical body the optimiser propagates for this spacecraft (drag/SRP properties)."""
    return Body(mass_kg=sc.wet_mass_kg, area_m2=sc.structure.area_m2, cd=sc.structure.cd, cr=sc.structure.cr)


def _period(r0, v0) -> float:
    a = 1.0 / (2.0 / np.linalg.norm(r0) - np.dot(v0, v0) / MU_EARTH)
    return 2 * math.pi * math.sqrt(a**3 / MU_EARTH)


def optimise(epoch: datetime, r0, v0, sc: SpacecraftConfig, threats: list[Threat], cfg: OptimizerConfig | None = None,
             unc: Uncertainty | None = None, catalogue: list[tuple[int, Satrec]] | None = None, progress=None) -> dict:
    cfg = cfg or OptimizerConfig()
    unc = unc or Uncertainty()
    wall = _time.perf_counter()
    r0, v0 = np.asarray(r0, float), np.asarray(v0, float)
    prog = progress or (lambda f, msg: None)
    errors = sc.validate()
    if errors:
        return {"status": "invalid-spacecraft", "message": "; ".join(errors), "algorithm_version": ALGORITHM_VERSION}
    if not threats:
        return {"status": "no-threats", "message": "No threats were given: nothing to avoid.", "algorithm_version": ALGORITHM_VERSION}

    t = time_grid(cfg.horizon_s, cfg.step_s)
    prog(0.02, "propagating threats")
    TR, TV, tstatus = threat_tracks(epoch, t, threats)
    nan = np.array([[np.nan, 0.0, 0.0, 0.0]])
    prog(0.05, "nominal trajectory")
    nom = evaluate(epoch, r0, v0, t, nan, sc, cfg, unc, threats, TR, TV, None, keep_traj=True)
    nominal = {"R": nom.R[0], "V": nom.V[0], "tca": nom.tca[0], "miss": nom.miss[0], "pc": nom.pc[0]}

    # which threats the optimiser "sees" (single-threat baseline sees only the worst one)
    active = list(range(len(threats)))
    if cfg.threat_mode == "single":
        worst = int(np.argmax(nom.pc[0] + 1e-30 * (1 / np.maximum(nom.miss[0], 1e-9))))
        active = [worst]
    a_threats = [threats[k] for k in active]
    a_TR, a_TV = TR[active], TV[active]
    a_nominal = {**nominal, "tca": nominal["tca"][active]}

    base = {
        "algorithm_version": ALGORITHM_VERSION,
        "epoch": epoch.isoformat(),
        "config": cfg.to_dict(),
        "uncertainty": {**asdict(unc), "label": "ASSUMED (not from data)"},
        "spacecraft": sc.summary(),
        "threats": [{**th.public(), "track_status": s} for th, s in zip(threats, tstatus)],
        "threats_considered": [threats[k].name for k in active],
        "nominal": _cand_dict(nom, 0, threats, epoch),
    }
    nominal_safe = all(nom.miss[0, k] >= cfg.d_min_km and nom.pc[0, k] <= cfg.pc_limit for k in range(len(threats)))
    if nominal_safe:
        prog(1.0, "done")
        return {**base, "status": "no-maneuver-needed", "message": "Every threat already satisfies the miss-distance and Pc limits without a maneuver.",
                "selected": None, "runtime_s": _time.perf_counter() - wall, "stages": []}

    period = _period(r0, v0)
    first_tca = float(np.min(a_nominal["tca"]))
    grid = candidate_grid(first_tca, period, sc, cfg)
    stages = []
    if len(grid) == 0:
        prog(1.0, "done")
        return {**base, "status": "no-feasible-candidate", "selected": None, "stages": [],
                "message": "No maneuver window exists: the first threat is too soon for the minimum lead time, or the twin can't deliver the minimum Δv.",
                "runtime_s": _time.perf_counter() - wall}

    prog(0.1, f"evaluating {len(grid)} grid candidates")
    ev = evaluate(epoch, r0, v0, t, grid, sc, cfg, unc, a_threats, a_TR, a_TV, a_nominal)
    pool = [(ev, n) for n in range(len(grid))]
    stages.append({"stage": "grid", "candidates": len(grid), "feasible": int(ev.feasible.sum()),
                   "rejections": dict(Counter(r.split(" vs ")[0] for rs in ev.reasons for r in rs))})

    # ---- local refinement (pattern search) around the best feasible grid candidates
    prog(0.4, "refining")
    def best_feasible(pairs, k):
        f = [(e.J[n], e, n) for e, n in pairs if e.feasible[n]]
        f.sort(key=lambda x: x[0])
        return f[:k]

    centres = [e.cands[n].copy() for _, e, n in best_feasible(pool, cfg.refine_top_k)]
    step_t = period / 16
    step_frac = 0.3
    refined_total = 0
    for rnd in range(cfg.refine_rounds):
        if not centres:
            break
        trial = []
        for c in centres:
            mag = np.linalg.norm(c[1:])
            for dt_ in (-step_t, step_t):
                trial.append([c[0] + dt_, *c[1:]])
            for ax in range(3):
                for sgn in (-1, 1):
                    q = c.copy()
                    q[1 + ax] += sgn * step_frac * mag
                    trial.append(q)
            q = c.copy()
            q[1:] *= (1 - step_frac)
            trial.append(q)
        trial = np.array(trial)
        ev_r = evaluate(epoch, r0, v0, t, trial, sc, cfg, unc, a_threats, a_TR, a_TV, a_nominal)
        refined_total += len(trial)
        pool += [(ev_r, n) for n in range(len(trial))]
        centres = [e.cands[n].copy() for _, e, n in best_feasible(pool, cfg.refine_top_k)]
        step_t /= 2
        step_frac /= 2
        prog(0.4 + 0.25 * (rnd + 1) / cfg.refine_rounds, f"refinement round {rnd + 1}")
    stages.append({"stage": "refinement", "candidates": refined_total,
                   "feasible": int(sum(1 for e, n in pool[len(grid):] if e.feasible[n]))})

    feas = best_feasible(pool, 10**9)
    # Robust shortlist: the cheapest candidates by J, plus the cheapest candidate at each safety-margin
    # tier (worst-case miss >= m x d_min). Without the tiers every shortlisted burn would sit right at the
    # deterministic limit, which is exactly what uncertainty makes fragile.
    short, seen = [], set()

    def add(e, n):
        key = tuple(np.round(e.cands[n], 4))
        if key not in seen:
            seen.add(key)
            short.append((e, n))

    for _, e, n in feas[: max(1, cfg.shortlist // 2)]:
        add(e, n)
    for tier in MARGIN_TIERS:
        for _, e, n in feas:
            if np.min(e.miss[n]) >= tier * cfg.d_min_km:
                add(e, n)
                break

    all_rows = [_cand_dict(e, n, a_threats, epoch) for e, n in pool]
    rejected = Counter(r.split(" vs ")[0] for d in all_rows for r in d["reasons"])
    if not short:
        prog(1.0, "done")
        best_bad = min(all_rows, key=lambda d: (len(d["reasons"]), d["J"]))
        return {**base, "status": "no-feasible-candidate", "selected": None, "stages": stages,
                "message": "No candidate satisfied every hard constraint. Nothing is selected.",
                "closest_attempt": best_bad, "rejection_summary": dict(rejected),
                "candidates_evaluated": len(all_rows), "runtime_s": _time.perf_counter() - wall,
                "top_candidates": sorted(all_rows, key=lambda d: (not d["feasible"], d["J"]))[:20]}

    # ---- Monte Carlo robustness on the shortlist (proposed method)
    mc_results = {}
    w = np.asarray(cfg.weights, float)
    ranked = []
    if cfg.use_monte_carlo:
        prog(0.7, f"Monte Carlo ({unc.mc_samples} samples x {len(short)} candidates)")
        mc_nominal = monte_carlo(epoch, r0, v0, t, np.array([np.nan, 0, 0, 0]), sc, cfg, unc, a_threats, a_TR, a_TV)
        for i, (e, n) in enumerate(short):
            mc = monte_carlo(epoch, r0, v0, t, e.cands[n], sc, cfg, unc, a_threats, a_TR, a_TV)
            e.terms[n, 3] = mc["p_violation"]
            J = float(e.terms[n, :3] @ w[:3] + w[3] * mc["p_violation"])
            ranked.append((mc["p_violation"] <= cfg.p_violation_max, J, e, n, mc))
            prog(0.7 + 0.15 * (i + 1) / len(short), "Monte Carlo")
        ranked.sort(key=lambda x: (not x[0], x[1]))
        robust = [x for x in ranked if x[0]]
        stages.append({"stage": "monte-carlo", "candidates": len(short), "robust": len(robust), "samples_each": unc.mc_samples})
        if not robust:
            prog(1.0, "done")
            return {**base, "status": "no-robust-candidate", "selected": None, "stages": stages,
                    "message": f"Feasible candidates exist, but none keeps the violation probability under {cfg.p_violation_max:.0%} "
                               "with the assumed uncertainties. Nothing is selected.",
                    "shortlist": [{**_cand_dict(e, n, a_threats, epoch), "monte_carlo": mc} for _, _, e, n, mc in ranked],
                    "monte_carlo_nominal": mc_nominal, "rejection_summary": dict(rejected),
                    "candidates_evaluated": len(all_rows), "runtime_s": _time.perf_counter() - wall}
        _, Jsel, e_sel, n_sel, mc_sel = robust[0]
        # ---- robust fuel trim: shrink the chosen burn while it stays feasible AND robust
        prog(0.86, "robust fuel trim")
        trims = []
        best_row = e_sel.cands[n_sel].copy()
        for f in TRIM_FACTORS:
            row = best_row.copy()
            row[1:] = e_sel.cands[n_sel][1:] * f
            ev_t = evaluate(epoch, r0, v0, t, row[None], sc, cfg, unc, a_threats, a_TR, a_TV, a_nominal)
            if not ev_t.feasible[0]:
                trims.append({"factor": f, "result": "infeasible: " + "; ".join(ev_t.reasons[0])})
                break
            mc_t = monte_carlo(epoch, r0, v0, t, row, sc, cfg, unc, a_threats, a_TR, a_TV)
            if mc_t["p_violation"] > cfg.p_violation_max:
                trims.append({"factor": f, "result": f"not robust (p={mc_t['p_violation']:.1%})"})
                break
            ev_t.terms[0, 3] = mc_t["p_violation"]
            J_t = float(ev_t.terms[0, :3] @ w[:3] + w[3] * mc_t["p_violation"])
            trims.append({"factor": f, "result": f"accepted (p={mc_t['p_violation']:.1%}, J={J_t:.4f})"})
            if J_t <= Jsel:
                e_sel, n_sel, mc_sel, Jsel = ev_t, 0, mc_t, J_t
        stages.append({"stage": "robust-trim", "steps": trims})
        mc_results = {"nominal": mc_nominal, "selected": mc_sel}
    else:
        e_sel, n_sel = short[0]
        Jsel = float(e_sel.J[n_sel])

    selected_row = e_sel.cands[n_sel].copy()
    # ---- evaluate the selected maneuver against ALL threats (matters for the single-threat baseline)
    full = evaluate(epoch, r0, v0, t, np.vstack([nan, selected_row]), sc, cfg, unc, threats, TR, TV, nominal, keep_traj=True)
    selected = _cand_dict(full, 1, threats, epoch)
    selected["J"] = Jsel
    selected["terms"]["U"] = None if not cfg.use_monte_carlo else float(e_sel.terms[n_sel, 3])
    nominal_all = _cand_dict(full, 0, threats, epoch)

    result = {
        **base,
        "status": "selected",
        "selected": selected,
        "nominal": nominal_all,
        "stages": stages,
        "candidates_evaluated": len(all_rows),
        "rejection_summary": dict(rejected),
        "top_candidates": sorted(all_rows, key=lambda d: (not d["feasible"], d["J"]))[:20],
        "monte_carlo": mc_results,
        "safe_against_all_threats": bool(full.feasible[1]) and all(not r.startswith("unsafe") for r in full.reasons[1]),
    }

    if cfg.validate:
        prog(0.88, "independent validation (finite burn, full force model)")
        result["validation"] = validate(epoch, r0, v0, sc, threats, selected_row, cfg, unc, catalogue or [], TR=None)
    result["explanation"] = explain(result)
    result["runtime_s"] = _time.perf_counter() - wall
    prog(1.0, "done")
    return result


def validate(epoch, r0, v0, sc: SpacecraftConfig, threats, cand, cfg: OptimizerConfig, unc: Uncertainty,
             catalogue: list[tuple[int, Satrec]], TR=None) -> dict:
    """Independent check with a different model: full forces, finite burn centred on t_m, tighter tolerance."""
    t = time_grid(cfg.horizon_s, cfg.step_s)
    TRv, TVv, _ = threat_tracks(epoch, t, threats)
    tm, dvr, dvt, dvn = cand
    dv = float(np.linalg.norm([dvr, dvt, dvn]))
    tb = sc.burn_duration_s(dv)
    body = Body(mass_kg=sc.wet_mass_kg, area_m2=sc.structure.area_m2, cd=sc.structure.cd, cr=sc.structure.cr)
    burn = FiniteBurn(float(tm) - tb / 2, tb, sc.propulsion.thrust_n, sc.propulsion.isp_s, np.array([dvr, dvt, dvn]) / dv)
    nom = propagate(epoch, r0, v0, t, cfg.validation_force, body, rtol=1e-11)
    mod = propagate(epoch, r0, v0, t, cfg.validation_force, body, burns=[burn], rtol=1e-11)
    R = np.stack([nom.r[0], mod.r[0]])
    V = np.stack([nom.v[0], mod.v[0]])
    ca = closest_approaches(t, R, V, TRv, TVv)
    pc = pc_values(ca, R, V, TRv, TVv, threats, unc)
    checks = []
    for k, th in enumerate(threats):
        ok = ca["miss"][1, k] >= cfg.d_min_km and pc[1, k] <= cfg.pc_limit
        checks.append({"threat": th.name, "miss_before_km": float(ca["miss"][0, k]), "miss_after_km": float(ca["miss"][1, k]),
                       "pc_before": float(pc[0, k]), "pc_after": float(pc[1, k]), "pass": bool(ok)})
    alt = np.linalg.norm(mod.r[0], axis=1) - R_EARTH
    m = sc.mission
    cons = {
        "altitude_band": bool(alt.min() >= m.alt_min_km and alt.max() <= m.alt_max_km),
        "burn_duration": tb <= sc.propulsion.max_burn_s,
        "propellant": float(mod.m[0, -1]) >= sc.wet_mass_kg - sc.usable_propellant_kg - 1e-9,
    }
    new_conj = []
    if catalogue:
        before = {c["norad_id"]: c for c in screen_trajectory(epoch, t, nom.r[0], nom.v[0], catalogue, cfg.screen_threshold_km)}
        after = screen_trajectory(epoch, t, mod.r[0], mod.v[0], catalogue, cfg.screen_threshold_km)
        threat_ids = {th.norad_id for th in threats if th.norad_id}
        for c in after:
            if c["norad_id"] in threat_ids:
                continue
            b = before.get(c["norad_id"])
            if b is None or c["miss_km"] < b["miss_km"] - 0.1:
                c["tca"] = (epoch + timedelta(seconds=c["tca_s"])).isoformat()
                c["miss_before_km"] = b["miss_km"] if b else None
                new_conj.append(c)
    secondary_unsafe = [c for c in new_conj if c["miss_km"] < cfg.d_min_km]
    passed = all(c["pass"] for c in checks) and all(cons.values()) and not secondary_unsafe
    return {
        "status": "passed" if passed else "failed",
        "method": "finite burn of %.1f s centred on t_m, %s, rtol 1e-11" % (tb, ", ".join(cfg.validation_force.describe())),
        "burn_duration_s": tb,
        "propellant_used_kg": float(nom.m[0, -1] - mod.m[0, -1]),
        "threats": checks,
        "constraints": cons,
        "catalogue_objects_screened": len(catalogue),
        "new_or_closer_conjunctions": new_conj[:20],
        "secondary_unsafe": secondary_unsafe,
        "final_position_offset_km": float(np.linalg.norm(mod.r[0, -1] - nom.r[0, -1])),
    }


def explain(res: dict) -> list[str]:
    """Plain-language explanation built only from computed numbers."""
    s, nom = res.get("selected"), res.get("nominal")
    if not s:
        return [res.get("message", "")]
    out = []
    dvr, dvt, dvn = s["dv_rtn_ms"]
    comp = max(zip((abs(dvr), abs(dvt), abs(dvn)), ("radial", "along-track", "cross-track")))[1]
    out.append(f"Burn {s['dv_ms'] * 1000:.1f} mm/s, mainly {comp}, at {s['t_m']} "
               f"(R {dvr * 1000:+.1f}, T {dvt * 1000:+.1f}, N {dvn * 1000:+.1f} mm/s).")
    for b, a in zip(nom["per_threat"], s["per_threat"]):
        out.append(f"{a['threat']}: miss {b['miss_km'] * 1000:.0f} m → {a['miss_km'] * 1000:.0f} m, Pc {b['pc']:.1e} → {a['pc']:.1e} (assumed covariance).")
    out.append(f"Costs {s['propellant_kg'] * 1000:.1f} g of propellant ({s['burn_s']:.0f} s burn); Δa {s['da_km'] * 1000:+.0f} m, "
               f"Δi {s['di_deg']:+.4f}°, Δe {s['de']:+.5f}.")
    n_rej = res.get("candidates_evaluated", 0) - sum(1 for c in res.get("top_candidates", []) if c["feasible"])
    top = sorted(res.get("rejection_summary", {}).items(), key=lambda kv: -kv[1])[:3]
    if top:
        out.append(f"{res.get('candidates_evaluated', 0)} candidates propagated; most common rejection reasons: "
                   + "; ".join(f"{k} ({v})" for k, v in top) + ".")
    if res.get("monte_carlo"):
        mc = res["monte_carlo"]
        out.append(f"Monte Carlo ({mc['selected']['samples']} samples): probability of coming within {mc['selected']['d_min_km'] * 1000:.0f} m "
                   f"is {mc['selected']['p_violation']:.1%} after the burn vs {mc['nominal']['p_violation']:.1%} without it.")
    v = res.get("validation")
    if v:
        out.append(f"Independent validation ({v['method']}): {v['status'].upper()}"
                   + (f"; {len(v['new_or_closer_conjunctions'])} catalogue objects came closer than before" if v["new_or_closer_conjunctions"] else "") + ".")
    _ = n_rej
    return out


# ============================================================ synthetic scenarios
def synthetic_threats(epoch, r0, v0, specs: list[dict], force: ForceModel | None = None, body: Body | None = None,
                      sigma_rtn_km=(0.2, 0.6, 0.2), prefix="SYNTH-T") -> list[Threat]:
    """Engineer threats that pass the nominal trajectory at chosen times and miss distances.

    spec: {"tca_s", "miss_km", "crossing_deg" (angle between velocity vectors), "phase_deg" (direction of the
    miss vector in the encounter plane, 0 = towards radial)}. Labelled SYNTHETIC everywhere.
    """
    force = force or ForceModel(j2=True, drag=True)
    times = np.array(sorted({float(s["tca_s"]) for s in specs}))
    tr = propagate(epoch, r0, v0, times, force, body or Body())
    out = []
    for i, s in enumerate(specs):
        j = int(np.searchsorted(times, float(s["tca_s"])))
        rp, vp = tr.r[0, j], tr.v[0, j]
        rhat = rp / np.linalg.norm(rp)
        ang = math.radians(s.get("crossing_deg", 60.0))
        # rotate the primary velocity about the radial axis (Rodrigues): same speed, different plane
        vs = vp * math.cos(ang) + np.cross(rhat, vp) * math.sin(ang) + rhat * (rhat @ vp) * (1 - math.cos(ang))
        vrel = vs - vp
        e1 = rhat - (rhat @ vrel) / (vrel @ vrel) * vrel
        e1 /= np.linalg.norm(e1)
        e2 = np.cross(vrel / np.linalg.norm(vrel), e1)
        ph = math.radians(s.get("phase_deg", 0.0))
        rs = rp + s["miss_km"] * (math.cos(ph) * e1 + math.sin(ph) * e2)
        out.append(Threat(id=f"{prefix}{i + 1}", name=f"{prefix}{i + 1}", kind="synthetic", t_ref_s=float(s["tca_s"]),
                          r_ref=rs.tolist(), v_ref=vs.tolist(), sigma_rtn_km=tuple(sigma_rtn_km)))
    return out


def fixed_baseline(epoch, r0, v0, sc: SpacecraftConfig, threats, cfg: OptimizerConfig, unc: Uncertainty, dv_ms: float = 0.1) -> dict:
    """Baseline: fixed +T burn of dv_ms half a revolution before the first threat (no search)."""
    t = time_grid(cfg.horizon_s, cfg.step_s)
    TR, TV, _ = threat_tracks(epoch, t, threats)
    nan = np.array([[np.nan, 0, 0, 0]])
    nom = evaluate(epoch, r0, v0, t, nan, sc, cfg, unc, threats, TR, TV, None, keep_traj=True)
    nominal = {"R": nom.R[0], "V": nom.V[0], "tca": nom.tca[0]}
    first = float(np.min(nom.tca[0]))
    tm = max(sc.attitude.min_lead_time_s, first - 0.5 * _period(r0, v0))
    cand = np.array([[tm, 0.0, dv_ms, 0.0]])
    ev = evaluate(epoch, r0, v0, t, np.vstack([nan, cand]), sc, cfg, unc, threats, TR, TV, nominal)
    return {"nominal": _cand_dict(ev, 0, threats, epoch), "selected": _cand_dict(ev, 1, threats, epoch),
            "status": "selected" if ev.feasible[1] else "infeasible"}
