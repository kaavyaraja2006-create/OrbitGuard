"""CelesTrak GP adapter.

Responsibilities: build the request, enforce CelesTrak's refresh etiquette,
handle network/HTTP errors explicitly, and return the raw payload with its
provenance. Parsing and storage happen in :mod:`app.ingestion.service`.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx

from ..core.config import CELESTRAK_GROUPS, settings


class ProviderError(RuntimeError):
    pass


@dataclass
class FetchResult:
    url: str
    text: str
    retrieved_at: datetime
    sha256: str  # of the raw provider payload, before any conversion
    n_bytes: int
    format: str = "TLE"
    conversion_problems: list[str] | None = None


def group_url(group: str) -> str:
    if group not in CELESTRAK_GROUPS:
        raise ProviderError(f"Unknown CelesTrak group '{group}'")
    # CSV (OMM) rather than TLE: CelesTrak does not publish TLEs for objects with
    # 6-digit catalog numbers (>= 100000), so TLE format silently misses new launches.
    return f"{settings.celestrak_base_url}?GROUP={group}&FORMAT=csv"


def omm_csv_to_tle_text(text: str) -> tuple[str, list[str]]:
    """Convert CelesTrak OMM CSV to named 3-line TLE text for the existing pipeline.

    Objects 100000-339999 are written with Alpha-5 catalog numbers (e.g. A0048),
    which the TLE parser and SGP4 support. Rows that cannot be converted are
    reported, never dropped silently.
    """
    import io

    from sgp4 import omm
    from sgp4.api import Satrec
    from sgp4.exporter import export_tle

    out, problems = [], []
    for k, fields in enumerate(omm.parse_csv(io.StringIO(text)), start=2):
        name = (fields.get("OBJECT_NAME") or "").strip()
        try:
            sat = Satrec()
            omm.initialize(sat, fields)
            l1, l2 = export_tle(sat)
        except Exception as exc:  # e.g. catalog numbers beyond Alpha-5 range
            problems.append(f"row {k} ({name or fields.get('NORAD_CAT_ID')}): {exc}")
            continue
        out.append(f"{name}\n{l1}\n{l2}\n")
    return "".join(out), problems


def fetch_group(group: str, client: httpx.Client | None = None) -> FetchResult:
    url = group_url(group)
    own = client is None
    client = client or httpx.Client(timeout=settings.http_timeout_s, headers={"User-Agent": settings.user_agent}, follow_redirects=True)
    try:
        resp = client.get(url)
    except httpx.HTTPError as exc:
        raise ProviderError(f"Network error contacting CelesTrak: {exc.__class__.__name__}: {exc}") from exc
    finally:
        if own:
            client.close()
    if resp.status_code == 403:
        raise ProviderError("CelesTrak refused the request (HTTP 403). This usually means the group was downloaded too often; wait and retry.")
    if resp.status_code != 200:
        raise ProviderError(f"CelesTrak returned HTTP {resp.status_code}")
    text = resp.text
    stripped = text.strip()
    if not stripped:
        raise ProviderError("CelesTrak returned an empty response")
    raw = text.encode()
    sha, n_bytes, fmt, problems = hashlib.sha256(raw).hexdigest(), len(raw), "TLE", None
    first = stripped.splitlines()[0]
    if first.startswith("OBJECT_NAME"):
        fmt = "OMM CSV"
        text, problems = omm_csv_to_tle_text(text)
        if not text:
            raise ProviderError("CelesTrak CSV contained no convertible element sets" + (f": {problems[:3]}" if problems else ""))
    elif not any(ln.startswith("1 ") for ln in stripped.splitlines()[:5]):
        # CelesTrak answers some invalid queries with a plain-text message.
        raise ProviderError(f"CelesTrak response is not GP data: {stripped[:200]!r}")
    return FetchResult(url, text, datetime.now(timezone.utc), sha, n_bytes, fmt, problems)
