"""Numerical (Cowell) propagation of maneuverable simulated satellites.

State per sample: X = [r (km), v (km/s), m (kg)], integrated with SciPy's
``solve_ivp`` (DOP853 by default). Many samples are integrated *together* as one
ODE system (vectorised accelerations), which is what makes candidate
evaluation and Monte Carlo cheap: 300 trajectories cost about as much as a few.

Maneuvers
---------
* Impulsive: at t_m the velocity jumps, position is unchanged:
      v+ = v- + C_RTN->I(r, v-) dv_RTN,   r+ = r-
  Propellant from the rocket equation  m+ = m- exp(-|dv| / (Isp g0)).
* Finite burn: constant thrust T along a direction fixed in the instantaneous RTN
  frame for [t_on, t_on + duration]:
      a_thrust = (T / m) u_I,   dm/dt = -T / (Isp g0)
The integration is split at every maneuver time so the integrator never steps
across a discontinuity.

Frame: the TEME frame of the start epoch is held fixed and treated as inertial.
Over a few days the true-of-date axes move by well under an arcsecond per day
relative to an inertial frame (precession ~0.14"/day), i.e. a few metres at LEO,
far below the force-model uncertainty (drag). Initial states come from SGP4 in
TEME, so no frame conversion is needed at the hand-over.
"""

from __future__ import annotations

import time as _time
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np
from scipy.integrate import solve_ivp

from .forces import (
    FRAME_INERTIAL,
    G0,
    MU_MOON,
    MU_SUN,
    ForceModel,
    accel_central,
    accel_drag,
    accel_srp,
    accel_third_body,
    accel_zonal,
    moon_position_km,
    sun_position_km,
)
from .frames import datetime_to_jd

ALGORITHM_VERSION = "numerical-propagation/1.0.0"


@dataclass
class Body:
    """Physical properties used by drag/SRP (scalar or per-sample arrays)."""

    mass_kg: float | np.ndarray = 500.0
    area_m2: float = 2.0
    cd: float = 2.2
    cr: float = 1.3


@dataclass
class Impulse:
    """Impulsive Δv at t_s (seconds after epoch). dv_rtn_kms: (3,) or (N, 3); zero rows = no burn."""

    t_s: float
    dv_rtn_kms: np.ndarray
    isp_s: float | None = None  # if given, mass is reduced by the rocket equation


@dataclass
class FiniteBurn:
    t_on_s: float
    duration_s: float
    thrust_n: float | np.ndarray
    isp_s: float
    dir_rtn: np.ndarray  # (3,) or (N, 3) unit vectors (fixed in RTN)


@dataclass
class Trajectory:
    t_s: np.ndarray  # (T,)
    r: np.ndarray  # (N, T, 3)
    v: np.ndarray  # (N, T, 3)
    m: np.ndarray  # (N, T)
    epoch: datetime
    force: ForceModel
    stats: dict = field(default_factory=dict)
    frame: str = FRAME_INERTIAL
    algorithm_version: str = ALGORITHM_VERSION


def rtn_matrices(r: np.ndarray, v: np.ndarray) -> np.ndarray:
    """(N, 3, 3) matrices whose ROWS are R, T, N unit vectors (inertial components)."""
    R = r / np.linalg.norm(r, axis=1, keepdims=True)
    N = np.cross(r, v)
    N /= np.linalg.norm(N, axis=1, keepdims=True)
    T = np.cross(N, R)
    return np.stack([R, T, N], axis=1)


def rtn_to_inertial(r: np.ndarray, v: np.ndarray, vec_rtn: np.ndarray) -> np.ndarray:
    m = rtn_matrices(r, v)
    return np.einsum("nij,ni->nj", m, vec_rtn)


def _as_rows(x, n: int) -> np.ndarray:
    a = np.asarray(x, float)
    return np.broadcast_to(a, (n,) + a.shape[-1:]).copy() if a.ndim == 1 else a.reshape(n, -1).copy()


def _as_col(x, n: int) -> np.ndarray:
    return np.broadcast_to(np.asarray(x, float), (n,)).copy()


def propagate(
    epoch: datetime,
    r0,
    v0,
    t_eval,
    force: ForceModel | None = None,
    body: Body | None = None,
    impulses: list[Impulse] | tuple = (),
    burns: list[FiniteBurn] | tuple = (),
    rtol: float = 1e-10,
    atol_km: float = 1e-6,
    method: str = "DOP853",
    max_step: float = np.inf,
) -> Trajectory:
    """Propagate N samples (r0, v0 of shape (N,3) or (3,)) to the times in t_eval (s, ascending, >= 0)."""
    force = force or ForceModel()
    body = body or Body()
    r0 = np.atleast_2d(np.asarray(r0, float))
    v0 = np.atleast_2d(np.asarray(v0, float))
    n = r0.shape[0]
    t_eval = np.asarray(t_eval, float)
    if t_eval.ndim != 1 or len(t_eval) == 0 or np.any(np.diff(t_eval) < 0) or t_eval[0] < 0:
        raise ValueError("t_eval must be a non-empty ascending array of seconds >= 0")
    jd0, fr0 = datetime_to_jd(epoch)
    jd_epoch = jd0 + fr0

    mass0 = _as_col(body.mass_kg, n)
    area = float(body.area_m2)
    cd_a, cr_a = float(body.cd) * area, float(body.cr) * area

    imps = []
    for im in impulses:
        imps.append((float(im.t_s), _as_rows(im.dv_rtn_kms, n), im.isp_s))
    brn = []
    for b in burns:
        if b.duration_s <= 0:
            continue
        brn.append((float(b.t_on_s), float(b.t_on_s + b.duration_s), _as_col(b.thrust_n, n), float(b.isp_s), _as_rows(b.dir_rtn, n)))

    t_end = float(t_eval[-1])
    breaks = sorted({t for t, *_ in imps if 0 < t < t_end} | {x for b in brn for x in (b[0], b[1]) if 0 < x < t_end})
    edges = [0.0] + breaks + [t_end]

    nfev = 0

    def rhs_factory(active_burns):
        def rhs(t, y):
            nonlocal nfev
            nfev += 1
            Y = y.reshape(n, 7)
            r, v, m = Y[:, :3], Y[:, 3:6], Y[:, 6]
            a = accel_central(r)
            if force.j2 or force.j3 or force.j4:
                a = a + accel_zonal(r, force.j2, force.j3, force.j4)
            if force.drag:
                a = a + accel_drag(r, v, cd_a / m)
            if force.sun or force.srp:
                s = sun_position_km(jd_epoch + t / 86400.0)
                if force.sun:
                    a = a + accel_third_body(r, s, MU_SUN)
                if force.srp:
                    a = a + accel_srp(r, s, cr_a / m)
            if force.moon:
                a = a + accel_third_body(r, moon_position_km(jd_epoch + t / 86400.0), MU_MOON)
            dm = np.zeros(n)
            for _, _, thrust, isp, dirs in active_burns:
                u = rtn_to_inertial(r, v, dirs)
                a = a + (thrust / m)[:, None] * u * 1e-3  # N/kg = m/s^2 -> km/s^2
                dm = dm - thrust / (isp * G0)
            out = np.empty_like(Y)
            out[:, :3] = v
            out[:, 3:6] = a
            out[:, 6] = dm
            return out.ravel()

        return rhs

    atol = np.tile(np.array([atol_km] * 3 + [atol_km * 1e-3] * 3 + [1e-6]), n)
    y = np.concatenate([r0, v0, mass0[:, None]], axis=1).ravel()

    T = len(t_eval)
    R = np.empty((n, T, 3))
    V = np.empty((n, T, 3))
    M = np.empty((n, T))
    filled = np.zeros(T, bool)
    wall = _time.perf_counter()
    status_msgs = []

    def record(mask_idx, ys):
        Ys = ys.T.reshape(len(mask_idx), n, 7)
        R[:, mask_idx] = np.transpose(Ys[:, :, :3], (1, 0, 2))
        V[:, mask_idx] = np.transpose(Ys[:, :, 3:6], (1, 0, 2))
        M[:, mask_idx] = Ys[:, :, 6].T
        filled[mask_idx] = True

    at0 = np.nonzero(t_eval == 0.0)[0]
    if len(at0):
        record(at0, np.repeat(y[:, None], len(at0), axis=1))

    for a, b in zip(edges[:-1], edges[1:]):
        # impulses at the segment start
        for t_i, dv, isp in imps:
            if t_i == a and (a > 0 or t_i == 0.0):
                Y = y.reshape(n, 7)
                dvi = rtn_to_inertial(Y[:, :3], Y[:, 3:6], dv)
                Y[:, 3:6] += dvi
                if isp:
                    Y[:, 6] *= np.exp(-np.linalg.norm(dv, axis=1) * 1e3 / (isp * G0))
                y = Y.ravel()
        if b <= a:
            continue
        mid = 0.5 * (a + b)
        active = [bb for bb in brn if bb[0] <= mid < bb[1]]
        idx = np.nonzero((t_eval > a) & (t_eval <= b))[0]
        pts = np.unique(np.append(t_eval[idx], b))  # always end exactly at b
        sol = solve_ivp(rhs_factory(active), (a, b), y, method=method, t_eval=pts, rtol=rtol, atol=atol, max_step=max_step)
        if not sol.success:
            raise RuntimeError(f"Integration failed in [{a}, {b}] s: {sol.message}")
        if len(idx):
            pos = np.searchsorted(pts, t_eval[idx])
            record(idx, sol.y[:, pos])
        y = sol.y[:, -1].copy()  # state at b (pre-maneuver) for the next segment
        status_msgs.append(sol.message)

    if not filled.all():
        raise RuntimeError("internal: some requested times were not filled")
    stats = {
        "samples": n,
        "segments": len(edges) - 1,
        "rhs_evaluations": nfev,
        "runtime_s": _time.perf_counter() - wall,
        "method": method,
        "rtol": rtol,
        "atol_km": atol_km,
        "force_model": force.describe(),
    }
    return Trajectory(t_eval, R, V, M, epoch, force, stats)


def propellant_for_dv(m0_kg: float, dv_ms: float, isp_s: float) -> float:
    """Rocket equation: m_prop = m0 (1 - exp(-dv / (Isp g0)))."""
    return m0_kg * (1.0 - np.exp(-dv_ms / (isp_s * G0)))


def dv_available(m0_kg: float, m_prop_kg: float, isp_s: float) -> float:
    """Δv (m/s) from all usable propellant: Isp g0 ln(m0 / (m0 - m_prop))."""
    if m_prop_kg <= 0:
        return 0.0
    return float(isp_s * G0 * np.log(m0_kg / (m0_kg - m_prop_kg)))


def burn_duration(m0_kg: float, dv_ms: float, thrust_n: float, isp_s: float) -> float:
    """Constant-thrust burn time for dv: t = m_prop Isp g0 / T."""
    return float(propellant_for_dv(m0_kg, dv_ms, isp_s) * isp_s * G0 / thrust_n)
