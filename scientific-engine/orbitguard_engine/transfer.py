"""Orbit transfer laboratory (idealised, impulsive, two-body).

Kept deliberately separate from collision avoidance: these are large, planned
orbit changes (LEO -> GEO, raising, lowering, plane changes), not the
millimetre-per-second nudges used to dodge debris.

Formulas (Vallado 2013, ch. 6; Curtis 2014, ch. 6)
  circular speed       v_c = sqrt(mu / r)
  vis-viva             v   = sqrt(mu (2/r - 1/a))
  Hohmann              a_t = (r1 + r2) / 2,  Δv1 = |v_p - v_c1|,  Δv2 = |v_c2 - v_a|,  TOF = pi sqrt(a_t^3 / mu)
  bi-elliptic          two half-ellipses through r_b
  pure plane change    Δv = 2 v sin(Δi / 2)
  combined at apoapsis Δv2 = sqrt(v_a^2 + v_c2^2 - 2 v_a v_c2 cos Δi)

Every transfer is also flown numerically (the burns are applied to a propagated
state), and the orbit actually reached is reported next to the target, so the
analytical numbers are checked by an independent computation.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np
from scipy.optimize import minimize_scalar

from .constants import GEO_RADIUS_KM, MU_EARTH, R_EARTH
from .elements import coe_to_rv, rv_to_coe
from .forces import G0, ForceModel
from .numerical import propagate

ALGORITHM_VERSION = "orbit-transfer/1.0.0"
TWO_BODY = ForceModel(j2=False)
_EPOCH = datetime(2000, 1, 1, 12, tzinfo=timezone.utc)  # two-body: the epoch has no physical effect


def v_circ(r: float, mu: float = MU_EARTH) -> float:
    return math.sqrt(mu / r)


def vis_viva(r: float, a: float, mu: float = MU_EARTH) -> float:
    return math.sqrt(mu * (2.0 / r - 1.0 / a))


def hohmann(r1: float, r2: float, mu: float = MU_EARTH) -> dict:
    at = 0.5 * (r1 + r2)
    v1, v2 = v_circ(r1, mu), v_circ(r2, mu)
    vp, va = vis_viva(r1, at, mu), vis_viva(r2, at, mu)
    dv1, dv2 = vp - v1, v2 - va  # signed: negative when lowering
    return {"a_transfer_km": at, "e_transfer": abs(r2 - r1) / (r1 + r2), "v1_kms": v1, "v2_kms": v2,
            "v_transfer_departure_kms": vp, "v_transfer_arrival_kms": va,
            "dv1_kms": dv1, "dv2_kms": dv2, "dv_total_kms": abs(dv1) + abs(dv2), "tof_s": math.pi * math.sqrt(at**3 / mu)}


def bielliptic(r1: float, r2: float, rb: float, mu: float = MU_EARTH) -> dict:
    a1, a2 = 0.5 * (r1 + rb), 0.5 * (r2 + rb)
    dv1 = vis_viva(r1, a1, mu) - v_circ(r1, mu)
    dv2 = vis_viva(rb, a2, mu) - vis_viva(rb, a1, mu)
    dv3 = vis_viva(r2, a2, mu) - v_circ(r2, mu)
    tof = math.pi * (math.sqrt(a1**3 / mu) + math.sqrt(a2**3 / mu))
    return {"a1_km": a1, "a2_km": a2, "dv1_kms": dv1, "dv2_kms": dv2, "dv3_kms": dv3,
            "dv_total_kms": abs(dv1) + abs(dv2) + abs(dv3), "tof_s": tof}


def plane_change(v: float, di_deg: float) -> float:
    return 2.0 * v * math.sin(math.radians(di_deg) / 2.0)


def combined_dv(va: float, vc: float, di_rad: float) -> float:
    return math.sqrt(max(0.0, va * va + vc * vc - 2 * va * vc * math.cos(di_rad)))


def hohmann_with_plane_change(r1: float, r2: float, di_deg: float, mu: float = MU_EARTH) -> dict:
    """Plane change split between the two burns; the split minimising total Δv is found numerically.
    Also reports the 'all at apoapsis' and 'separate pure plane change' strategies for comparison."""
    h = hohmann(r1, r2, mu)
    di = math.radians(abs(di_deg))  # the cost doesn't depend on the direction of the plane change
    v1, vp, va, v2 = h["v1_kms"], h["v_transfer_departure_kms"], h["v_transfer_arrival_kms"], h["v2_kms"]

    def total(s):
        return combined_dv(v1, vp, s * di) + combined_dv(va, v2, (1 - s) * di)

    opt = minimize_scalar(total, bounds=(0.0, 1.0), method="bounded", options={"xatol": 1e-8})
    s = float(opt.x)
    return {
        **h,
        "di_deg": di_deg,
        "optimal_split_at_departure": s,
        "dv1_kms": combined_dv(v1, vp, s * di),
        "dv2_kms": combined_dv(va, v2, (1 - s) * di),
        "dv_total_kms": total(s),
        "alternatives": {
            "all_at_apoapsis_kms": total(0.0),
            "hohmann_then_separate_plane_change_kms": h["dv_total_kms"] + abs(plane_change(v2, di_deg)),
        },
    }


@dataclass
class TransferRequest:
    kind: str  # hohmann | bielliptic | plane-change | combined | raise-apogee
    alt1_km: float
    alt2_km: float | None = None
    inc1_deg: float = 0.0
    inc2_deg: float | None = None
    alt_b_km: float | None = None  # bi-elliptic intermediate apoapsis
    mass_kg: float | None = None
    isp_s: float | None = None


def _burn_at(r, v, v_target_inertial):
    """Δv in RTN at the current state that produces v_target."""
    R = r / np.linalg.norm(r)
    N = np.cross(r, v)
    N /= np.linalg.norm(N)
    T = np.cross(N, R)
    d = v_target_inertial - v
    return np.array([d @ R, d @ T, d @ N])


def _rotate_about(vec, axis, ang):
    k = axis / np.linalg.norm(axis)
    return vec * math.cos(ang) + np.cross(k, vec) * math.sin(ang) + k * (k @ vec) * (1 - math.cos(ang))


def fly(req: TransferRequest, samples_per_orbit: int = 180) -> dict:
    """Analytical solution + numerical flight of the same burns (two-body), with the orbit reached."""
    r1 = R_EARTH + req.alt1_km
    r2 = R_EARTH + (req.alt2_km if req.alt2_km is not None else req.alt1_km)
    i1 = req.inc1_deg
    i2 = req.inc2_deg if req.inc2_deg is not None else i1
    di = i2 - i1
    # start on the ascending node (u = 0), so apsis burns happen on the line of nodes
    r, v = (np.array(x) for x in coe_to_rv(r1, 0.0, i1, 0.0, 0.0, 0.0))
    legs, burns = [], []
    T1 = 2 * math.pi * math.sqrt(r1**3 / MU_EARTH)

    def coast(r, v, dur, label):
        n = max(8, int(samples_per_orbit * dur / T1))
        tr = propagate(_EPOCH, r, v, np.linspace(0, dur, n), TWO_BODY, rtol=1e-12, atol_km=1e-8)
        legs.append({"label": label, "duration_s": dur, "r_km": tr.r[0].tolist()})
        return tr.r[0, -1], tr.v[0, -1]

    def burn(r, v, v_new, label):
        d_rtn = _burn_at(r, v, v_new)
        burns.append({"label": label, "dv_rtn_kms": d_rtn.tolist(), "dv_kms": float(np.linalg.norm(d_rtn)), "r_km": r.tolist(),
                      "dv_inertial_kms": (v_new - v).tolist()})
        return v_new

    def plane_target(r, v, speed, dinc):
        """velocity of given speed, horizontal, rotated about the radial axis so the inclination changes by dinc."""
        horiz = v - (v @ r) / (r @ r) * r
        horiz = horiz / np.linalg.norm(horiz) * speed
        best = None
        for sgn in (1, -1):
            cand = _rotate_about(horiz, r, sgn * math.radians(dinc))
            err = abs(rv_to_coe(r, cand).i_deg - (rv_to_coe(r, v).i_deg + dinc))
            if best is None or err < best[0]:
                best = (err, cand)
        return best[1]

    r, v = coast(r, v, T1, "initial orbit")
    kind = req.kind
    if kind in ("hohmann", "combined"):
        sol = hohmann(r1, r2) if kind == "hohmann" or di == 0 else hohmann_with_plane_change(r1, r2, di)
        s = sol.get("optimal_split_at_departure", 0.0) if kind == "combined" else 0.0
        at = sol["a_transfer_km"]
        v = burn(r, v, plane_target(r, v, vis_viva(r1, at), s * di), "departure burn")
        r, v = coast(r, v, sol["tof_s"], "transfer arc")
        v = burn(r, v, plane_target(r, v, v_circ(r2), (1 - s) * di if kind == "combined" else 0.0), "arrival burn")
        T2 = 2 * math.pi * math.sqrt(r2**3 / MU_EARTH)
        r, v = coast(r, v, T2, "final orbit")
    elif kind == "bielliptic":
        rb = R_EARTH + (req.alt_b_km or 3 * max(req.alt1_km, req.alt2_km or 0))
        sol = bielliptic(r1, r2, rb)
        v = burn(r, v, plane_target(r, v, vis_viva(r1, sol["a1_km"]), 0.0), "burn 1 (raise apoapsis to r_b)")
        r, v = coast(r, v, math.pi * math.sqrt(sol["a1_km"] ** 3 / MU_EARTH), "first half-ellipse")
        v = burn(r, v, plane_target(r, v, vis_viva(rb, sol["a2_km"]), 0.0), "burn 2 (at r_b)")
        r, v = coast(r, v, math.pi * math.sqrt(sol["a2_km"] ** 3 / MU_EARTH), "second half-ellipse")
        v = burn(r, v, plane_target(r, v, v_circ(r2), 0.0), "burn 3 (circularise)")
        r, v = coast(r, v, 2 * math.pi * math.sqrt(r2**3 / MU_EARTH), "final orbit")
    elif kind == "plane-change":
        sol = {"dv_total_kms": abs(plane_change(v_circ(r1), di)), "dv1_kms": abs(plane_change(v_circ(r1), di)), "tof_s": 0.0}
        r2 = r1
        v = burn(r, v, plane_target(r, v, v_circ(r1), di), "plane change at the node")
        r, v = coast(r, v, T1, "final orbit")
    elif kind == "raise-apogee":
        a_new = 0.5 * (r1 + r2)
        sol = {"dv1_kms": vis_viva(r1, a_new) - v_circ(r1), "dv_total_kms": abs(vis_viva(r1, a_new) - v_circ(r1)),
               "a_new_km": a_new, "e_new": (r2 - r1) / (r2 + r1), "tof_s": 0.0}
        v = burn(r, v, plane_target(r, v, vis_viva(r1, a_new), 0.0), "perigee burn")
        r, v = coast(r, v, 2 * math.pi * math.sqrt(a_new**3 / MU_EARTH), "new elliptical orbit")
    else:
        raise ValueError(f"unknown transfer kind {kind}")

    reached = rv_to_coe(r, v)
    rmag = float(np.linalg.norm(r))
    out = {
        "algorithm_version": ALGORITHM_VERSION,
        "request": req.__dict__,
        "analytical": sol,
        "burns": burns,
        "legs": legs,
        "numerical_dv_total_kms": float(sum(b["dv_kms"] for b in burns)),
        "reached": {"a_km": reached.a_km, "e": reached.e, "i_deg": reached.i_deg, "r_km": rmag,
                    "alt_km": rmag - R_EARTH, "target_r_km": r2 if kind != "raise-apogee" else None, "target_i_deg": i2},
        "label": "IDEALISED: impulsive burns, two-body dynamics. Orbit transfer, not collision avoidance.",
    }
    if req.mass_kg and req.isp_s:
        dvm = out["numerical_dv_total_kms"] * 1000
        mp = req.mass_kg * (1 - math.exp(-dvm / (req.isp_s * G0)))
        out["propellant"] = {"mass_kg": req.mass_kg, "isp_s": req.isp_s, "propellant_kg": mp, "fraction": mp / req.mass_kg}
    return out


PRESETS = {
    "leo-raise": TransferRequest("hohmann", 400, 800, 51.6),
    "leo-lower": TransferRequest("hohmann", 800, 400, 51.6),
    "leo-meo": TransferRequest("hohmann", 500, 20200, 55.0),
    "leo-geo": TransferRequest("combined", 300, GEO_RADIUS_KM - R_EARTH, 28.5, 0.0),
    "gto": TransferRequest("raise-apogee", 250, GEO_RADIUS_KM - R_EARTH, 28.5),
    "plane-change": TransferRequest("plane-change", 700, None, 98.0, 97.0),
    "bielliptic": TransferRequest("bielliptic", 191.34411, 376310.0, 0.0, None, 503873.0),
}
