"""SGP4 propagation for catalog (TLE/GP) objects.

Pathway A in the ORBITGUARD architecture. Output states are in TEME (the
frame SGP4 is defined in); use :mod:`orbitguard_engine.frames` to convert.
SGP4 failures are surfaced with their documented meaning, never hidden.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import numpy as np
from sgp4.api import WGS72, SatrecArray, Satrec

from .frames import FRAME_ITRF, FRAME_TEME, datetime_to_jd, ecef_to_geodetic, teme_to_itrf, teme_to_itrf_many
from .tle import TLE

ALGORITHM_VERSION = "sgp4-propagation/1.0.0 (python-sgp4, WGS-72)"

SGP4_ERRORS = {
    0: "ok",
    1: "mean eccentricity out of range (< 0 or >= 1)",
    2: "mean motion is negative",
    3: "perturbed eccentricity out of range",
    4: "semi-latus rectum is negative",
    5: "satellite has decayed (epoch elements below Earth surface)",
    6: "satellite has decayed",
}


def satrec_from_tle(tle: TLE) -> Satrec:
    return Satrec.twoline2rv(tle.line1, tle.line2, WGS72)


@dataclass
class MeanElements:
    """SGP4 (Brouwer) mean elements recovered from the TLE.

    Suitable for orbit-regime classification, NOT for comparing with
    osculating elements from a numerical propagator.
    """

    a_km: float
    e: float
    i_deg: float
    raan_deg: float
    argp_deg: float
    mean_anomaly_deg: float
    mean_motion_rev_day: float
    epoch: datetime
    kind: str = "SGP4 mean (Brouwer), WGS-72"


def mean_elements(sat: Satrec, epoch: datetime) -> MeanElements:
    a_km = sat.a * sat.radiusearthkm  # sat.a is in Earth radii (un-Kozai'd mean motion)
    return MeanElements(
        a_km=a_km,
        e=sat.ecco,
        i_deg=math.degrees(sat.inclo),
        raan_deg=math.degrees(sat.nodeo),
        argp_deg=math.degrees(sat.argpo),
        mean_anomaly_deg=math.degrees(sat.mo),
        mean_motion_rev_day=sat.no_kozai * 1440.0 / (2 * math.pi),
        epoch=epoch,
    )


@dataclass
class StateVector:
    time: datetime
    r_km: np.ndarray
    v_kms: np.ndarray
    frame: str
    error_code: int = 0

    @property
    def ok(self) -> bool:
        return self.error_code == 0


def propagate(sat: Satrec, when: datetime) -> StateVector:
    jd, fr = datetime_to_jd(when)
    err, r, v = sat.sgp4(jd, fr)
    return StateVector(when, np.array(r), np.array(v), FRAME_TEME, err)


def propagate_tsince(sat: Satrec, minutes_since_epoch: float) -> StateVector:
    """Propagate by minutes from the TLE epoch (used for verification vectors)."""
    err, r, v = sat.sgp4_tsince(minutes_since_epoch)
    epoch = datetime(2000, 1, 1, 12, tzinfo=timezone.utc) + timedelta(days=sat.jdsatepoch + sat.jdsatepochF - 2451545.0)
    return StateVector(epoch + timedelta(minutes=minutes_since_epoch), np.array(r), np.array(v), FRAME_TEME, err)


def time_grid(start: datetime, duration_s: float, step_s: float) -> list[datetime]:
    if step_s <= 0 or duration_s < 0:
        raise ValueError("step must be > 0 and duration >= 0")
    n = int(math.floor(duration_s / step_s)) + 1
    return [start + timedelta(seconds=k * step_s) for k in range(n)]


@dataclass
class Track:
    times: list[datetime]
    r_teme: np.ndarray  # (N,3) km
    v_teme: np.ndarray  # (N,3) km/s
    r_itrf: np.ndarray  # (N,3) km
    lat_deg: np.ndarray
    lon_deg: np.ndarray
    alt_km: np.ndarray
    errors: np.ndarray  # (N,) SGP4 codes
    frames: tuple[str, str] = (FRAME_TEME, FRAME_ITRF)


def propagate_track(sat: Satrec, times: list[datetime]) -> Track:
    jds = np.empty(len(times))
    frs = np.empty(len(times))
    for k, t in enumerate(times):
        jds[k], frs[k] = datetime_to_jd(t)
    e, r, v = sat.sgp4_array(jds, frs)
    r_itrf = teme_to_itrf_many(r, jds, frs)
    lat, lon, alt = ecef_to_geodetic(r_itrf)
    return Track(times, r, v, r_itrf, np.atleast_1d(lat), np.atleast_1d(lon), np.atleast_1d(alt), e)


@dataclass
class Snapshot:
    """Positions of many objects at one instant."""

    time: datetime
    r_teme: np.ndarray  # (M,3)
    v_teme: np.ndarray
    r_itrf: np.ndarray
    errors: np.ndarray  # (M,)


def propagate_many(sats: list[Satrec], when: datetime) -> Snapshot:
    """Vectorised SGP4 for M satellites at one time (C++ SatrecArray)."""
    if not sats:
        empty = np.zeros((0, 3))
        return Snapshot(when, empty, empty, empty, np.zeros(0, dtype=int))
    jd, fr = datetime_to_jd(when)
    arr = SatrecArray(sats)
    e, r, v = arr.sgp4(np.array([jd]), np.array([fr]))
    r = r[:, 0, :]
    v = v[:, 0, :]
    r_itrf, _ = teme_to_itrf(r, v, jd, fr)
    return Snapshot(when, r, v, np.atleast_2d(r_itrf), e[:, 0])
