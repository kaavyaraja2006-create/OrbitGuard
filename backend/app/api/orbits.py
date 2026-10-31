"""Stateless computation endpoints: classify / propagate arbitrary inputs."""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

from orbitguard_engine.classification import ClassificationConfig, classify_orbit
from orbitguard_engine.constants import MU_EARTH, MU_WGS72, R_EARTH, RE_WGS72
from orbitguard_engine.elements import derived_parameters, rv_to_coe
from orbitguard_engine.frames import FRAME_ITRF
from orbitguard_engine.propagation import SGP4_ERRORS, mean_elements, propagate_track, satrec_from_tle, time_grid
from orbitguard_engine.tle import TLEError, parse_tle

from ..services.timeutil import parse_time

router = APIRouter(prefix="/orbits", tags=["orbits"])


class ClassifyRequest(BaseModel):
    line1: str | None = None
    line2: str | None = None
    a_km: float | None = Field(None, gt=0)
    e: float | None = Field(None, ge=0, lt=1)
    i_deg: float | None = Field(None, ge=0, le=180)
    r_km: list[float] | None = Field(None, min_length=3, max_length=3)
    v_kms: list[float] | None = Field(None, min_length=3, max_length=3)
    config: dict | None = None

    @model_validator(mode="after")
    def one_input(self):
        modes = [self.line1 is not None, self.a_km is not None, self.r_km is not None]
        if sum(modes) != 1:
            raise ValueError("Provide exactly one of: TLE (line1+line2), elements (a_km,e,i_deg), or state (r_km,v_kms)")
        return self


@router.post("/classify")
def classify(req: ClassifyRequest):
    try:
        cfg = ClassificationConfig(**(req.config or {}))
    except TypeError as exc:
        raise HTTPException(400, f"Invalid config: {exc}")
    if req.line1 is not None:
        if req.line2 is None:
            raise HTTPException(400, "line2 is required with line1")
        try:
            tle = parse_tle(req.line1, req.line2)
        except TLEError as exc:
            raise HTTPException(400, str(exc))
        me = mean_elements(satrec_from_tle(tle), tle.epoch)
        a, e, i, mu, re, kind = me.a_km, me.e, me.i_deg, MU_WGS72, RE_WGS72, "SGP4 mean elements (WGS-72)"
    elif req.a_km is not None:
        if req.e is None or req.i_deg is None:
            raise HTTPException(400, "a_km, e and i_deg are all required")
        a, e, i, mu, re, kind = req.a_km, req.e, req.i_deg, MU_EARTH, R_EARTH, "user-supplied elements"
    else:
        if req.v_kms is None:
            raise HTTPException(400, "v_kms is required with r_km")
        coe = rv_to_coe(req.r_km, req.v_kms)
        a, e, i, mu, re, kind = coe.a_km, coe.e, coe.i_deg, MU_EARTH, R_EARTH, "osculating elements from inertial state"
    try:
        res = classify_orbit(a, e, i, mu=mu, re=re, config=cfg)
        d = derived_parameters(a, e, i, mu=mu, re=re)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"input_kind": kind, "a_km": a, "e": e, "i_deg": i, "derived": d.to_dict(), "classification": res.to_dict()}


@router.get("/classification-rules")
def classification_rules():
    """The active thresholds, so the UI shows the real rules rather than prose."""
    from dataclasses import asdict

    from orbitguard_engine.classification import ALGORITHM_VERSION
    from orbitguard_engine.constants import GEO_ALTITUDE_KM, SIDEREAL_DAY_S, SSO_RAAN_RATE_DEG_DAY

    return {
        "algorithm_version": ALGORITHM_VERSION,
        "config": asdict(ClassificationConfig()),
        "constants": {
            "geo_altitude_km": GEO_ALTITUDE_KM,
            "sidereal_day_s": SIDEREAL_DAY_S,
            "sso_raan_rate_deg_day": SSO_RAAN_RATE_DEG_DAY,
        },
        "notes": [
            "Labels are evaluated independently (multi-label).",
            "Catalog objects are classified from SGP4 mean elements (WGS-72).",
            "HEO eccentricity threshold and polar band are project conventions.",
        ],
    }


class PropagateRequest(BaseModel):
    line1: str
    line2: str
    start: str | None = None
    duration_s: float = Field(5400, gt=0, le=30 * 86400)
    step_s: float = Field(60, gt=0)


@router.post("/propagate")
def propagate_tle(req: PropagateRequest):
    try:
        tle = parse_tle(req.line1, req.line2)
        t0 = parse_time(req.start)
    except (TLEError, ValueError) as exc:
        raise HTTPException(400, str(exc))
    n = int(req.duration_s / req.step_s) + 1
    if n > 5000:
        raise HTTPException(400, f"{n} points requested; maximum is 5000")
    tr = propagate_track(satrec_from_tle(tle), time_grid(t0, req.duration_s, req.step_s))
    return {
        "epoch": tle.epoch.isoformat(),
        "frames": {"teme": "TEME", "itrf": FRAME_ITRF},
        "times": [t.isoformat() for t in tr.times],
        "r_teme_km": np.round(tr.r_teme, 6).tolist(),
        "v_teme_kms": np.round(tr.v_teme, 9).tolist(),
        "r_itrf_km": np.round(tr.r_itrf, 6).tolist(),
        "lat_deg": tr.lat_deg.tolist(),
        "lon_deg": tr.lon_deg.tolist(),
        "alt_km": tr.alt_km.tolist(),
        "error_codes": tr.errors.tolist(),
        "error_meanings": {int(c): SGP4_ERRORS.get(int(c), "unknown") for c in set(tr.errors.tolist()) if c},
    }
