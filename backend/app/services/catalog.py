"""In-memory index of the latest element set per object, with SGP4 Satrecs.

Rebuilt lazily after each successful ingestion so position snapshots for
thousands of objects are a single vectorised SGP4 call.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import datetime

from sgp4.api import WGS72, Satrec
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import OrbitalElementSet, OrbitClassification, SpaceObject
from .timeutil import as_utc


@dataclass
class CatalogEntry:
    norad_id: int
    name: str | None
    object_type: str
    element_set_id: int
    epoch: datetime
    labels: list[str]
    satrec: Satrec
    operational_status: str = "UNKNOWN"
    intl_designator: str | None = None


class CatalogCache:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: list[CatalogEntry] | None = None
        self._array = None
        self.version = 0  # bumped on every invalidation (keys derived caches)

    def invalidate(self) -> None:
        with self._lock:
            self._entries = None
            self._array = None
            self.version += 1

    def snapshot(self, s: Session):
        """(entries, SatrecArray) taken atomically, so array rows always match entry order."""
        from sgp4.api import SatrecArray

        with self._lock:
            if self._entries is None:
                self._entries = self._build(s)
            if self._array is None and self._entries:
                self._array = SatrecArray([e.satrec for e in self._entries])
            return self._entries, self._array

    def entries(self, s: Session) -> list[CatalogEntry]:
        with self._lock:
            if self._entries is None:
                self._entries = self._build(s)
            return self._entries

    @staticmethod
    def _build(s: Session) -> list[CatalogEntry]:
        latest = (
            select(OrbitalElementSet.norad_id, func.max(OrbitalElementSet.epoch).label("ep"))
            .group_by(OrbitalElementSet.norad_id)
            .subquery()
        )
        rows = s.execute(
            select(OrbitalElementSet, SpaceObject, OrbitClassification)
            .join(latest, (latest.c.norad_id == OrbitalElementSet.norad_id) & (latest.c.ep == OrbitalElementSet.epoch))
            .join(SpaceObject, SpaceObject.norad_id == OrbitalElementSet.norad_id)
            .outerjoin(OrbitClassification, OrbitClassification.element_set_id == OrbitalElementSet.id)
            .order_by(OrbitalElementSet.norad_id)
        ).all()
        out = []
        for es, obj, cls in rows:
            out.append(
                CatalogEntry(
                    norad_id=obj.norad_id,
                    name=obj.name,
                    object_type=obj.object_type,
                    element_set_id=es.id,
                    epoch=as_utc(es.epoch),
                    labels=list(cls.labels) if cls else [],
                    satrec=Satrec.twoline2rv(es.line1, es.line2, WGS72),
                    operational_status=obj.operational_status,
                    intl_designator=obj.intl_designator,
                )
            )
        return out


catalog_cache = CatalogCache()
