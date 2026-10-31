"""Anonymous, read-only showcase for the landing page.

Returns a small, rate-limited summary of the public catalogue: counts, data freshness,
a bounded sample of SGP4 positions and a few orbit tracks. Everything is computed from
the stored element sets at request time; nothing is invented. No user, organisation,
twin, plan or conjunction data is exposed here.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from orbitguard_engine.frames import FRAME_ITRF, datetime_to_jd, teme_to_itrf, teme_to_itrf_many

from ..auth.service import RateLimiter
from ..core.db import get_session
from ..models import IngestionRun
from ..services.catalog import catalog_cache
from .auth import client_ip

router = APIRouter(tags=["public"])

MAX_POINTS = 600  # bounded sample, stratified by object type
MAX_TRACKS = 4
TRACK_POINTS = 180
# well-known payloads preferred for the orbit lines (only used if present in the catalogue)
NOTABLE = (25544, 48274, 20580, 43013, 33591, 28654, 27424)

showcase_limiter = RateLimiter(limit=60, window_s=60)
_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()
CACHE_S = 5.0


def _sample(types: list[str], rng: np.random.Generator) -> np.ndarray:
    """Indices of at most MAX_POINTS objects, keeping each type's share (min 1 per type)."""
    n = len(types)
    if n <= MAX_POINTS:
        return np.arange(n)
    arr = np.array(types)
    out = []
    for t in sorted(set(types)):
        idx = np.nonzero(arr == t)[0]
        k = max(1, round(MAX_POINTS * len(idx) / n))
        out.append(rng.choice(idx, size=min(k, len(idx)), replace=False))
    return np.sort(np.concatenate(out))[:MAX_POINTS]


def _build(s: Session, now: datetime) -> dict:
    entries, arr = catalog_cache.snapshot(s)
    by_type: dict[str, int] = {}
    for e in entries:
        by_type[e.object_type] = by_type.get(e.object_type, 0) + 1
    last = s.scalar(select(IngestionRun.finished_at).where(IngestionRun.status == "succeeded").order_by(IngestionRun.finished_at.desc()).limit(1))
    newest = max((e.epoch for e in entries), default=None)
    out = {
        "generated_at": now.isoformat(),
        "frame": FRAME_ITRF,
        "units": "km",
        "tracked_objects": len(entries),
        "by_type": by_type,
        "newest_epoch": newest.isoformat() if newest else None,
        "last_ingestion": last.isoformat() if last else None,
        "sample": {"count": 0, "of": len(entries), "types": [], "ecef_km": []},
        "tracks": [],
        "label": "Positions propagated with SGP4 from the stored catalogue at generated_at; a bounded sample is shown.",
    }
    if arr is None or not entries:
        return out
    jd, fr = datetime_to_jd(now)
    err, r, v = arr.sgp4(np.array([jd]), np.array([fr]))
    ok = err[:, 0] == 0
    good = np.nonzero(ok)[0]
    if len(good) == 0:
        return out
    pick = good[_sample([entries[i].object_type for i in good], np.random.default_rng(int(now.timestamp()) // 3600))]
    r_itrf, _ = teme_to_itrf(r[pick, 0, :], v[pick, 0, :], jd, fr)
    r_itrf = np.atleast_2d(r_itrf)
    out["sample"] = {"count": int(len(pick)), "of": len(entries), "types": [entries[i].object_type for i in pick],
                     "ecef_km": np.round(r_itrf, 2).ravel().tolist()}
    # orbit tracks: notable payloads first, then payloads spread over altitude regimes
    pos = {e.norad_id: i for i, e in enumerate(entries)}
    chosen = [pos[n] for n in NOTABLE if n in pos and ok[pos[n]]][:MAX_TRACKS]
    if len(chosen) < MAX_TRACKS:
        payloads = [i for i in good if entries[i].object_type == "PAYLOAD" and i not in chosen]
        if not payloads:  # no payloads catalogued: fall back to any object
            payloads = [i for i in good if i not in chosen]
        if payloads:
            alt = np.linalg.norm(r[payloads, 0, :], axis=1)
            order = np.argsort(alt)
            for q in np.linspace(0, len(order) - 1, MAX_TRACKS - len(chosen)).astype(int):
                if payloads[order[q]] not in chosen:
                    chosen.append(payloads[order[q]])
    for i in chosen:
        e = entries[i]
        sat = e.satrec
        period_min = 2 * np.pi / sat.no_kozai  # rad/min
        t = np.linspace(0.0, period_min * 60.0, TRACK_POINTS)
        jj, ff = np.full(TRACK_POINTS, jd), fr + t / 86400.0
        er, rr, vv = sat.sgp4_array(jj, ff)
        keep = er == 0
        if keep.sum() < 2:
            continue
        ri = teme_to_itrf_many(rr[keep], jj[keep], ff[keep])
        out["tracks"].append({"norad_id": e.norad_id, "name": e.name, "type": e.object_type, "period_min": round(float(period_min), 3),
                              "ecef_km": np.round(np.atleast_2d(ri), 1).ravel().tolist()})
    return out


@router.get("/public/showcase")
def showcase(request: Request, s: Session = Depends(get_session)):
    if not showcase_limiter.hit(f"showcase:{client_ip(request)}"):
        raise HTTPException(429, "Too many requests; try again in a minute")
    now = datetime.now(timezone.utc)
    with _lock:
        hit = _cache.get("v")
        if hit and time.monotonic() - hit[0] < CACHE_S:
            return hit[1]
    data = _build(s, now)
    with _lock:
        _cache["v"] = (time.monotonic(), data)
    return data
