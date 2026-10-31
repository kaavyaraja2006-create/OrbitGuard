"""Database models (Phase 1 subset of the 16-table design).

Implemented now: space_objects, orbital_elements, orbit_classifications,
data_sources, ingestion_runs, audit_logs. Raw source records are preserved;
element sets are append-only history keyed by (norad_id, epoch).
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..core.db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class DataSource(Base):
    __tablename__ = "data_sources"
    id: Mapped[int] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(String(64))  # "celestrak" | "user-upload"
    name: Mapped[str] = mapped_column(String(128))  # group or upload label
    url: Mapped[str | None] = mapped_column(Text, nullable=True)
    format: Mapped[str] = mapped_column(String(16), default="TLE")
    __table_args__ = (UniqueConstraint("provider", "name"),)


class IngestionRun(Base):
    __tablename__ = "ingestion_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("data_sources.id"))
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued|running|succeeded|failed|skipped
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    records_received: Mapped[int] = mapped_column(Integer, default=0)
    records_new: Mapped[int] = mapped_column(Integer, default=0)
    records_duplicate: Mapped[int] = mapped_column(Integer, default=0)
    records_rejected: Mapped[int] = mapped_column(Integer, default=0)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    raw_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    raw_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source: Mapped[DataSource] = relationship()


class SpaceObject(Base):
    __tablename__ = "space_objects"
    norad_id: Mapped[int] = mapped_column(primary_key=True, autoincrement=False)
    name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    intl_designator: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Object type and operational status are kept separate on purpose.
    object_type: Mapped[str] = mapped_column(String(16), default="UNKNOWN")  # PAYLOAD|ROCKET BODY|DEBRIS|UNKNOWN
    object_type_source: Mapped[str] = mapped_column(String(64), default="none")
    operational_status: Mapped[str] = mapped_column(String(16), default="UNKNOWN")
    operational_status_source: Mapped[str] = mapped_column(String(64), default="none")
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    elements: Mapped[list["OrbitalElementSet"]] = relationship(back_populates="obj", order_by="OrbitalElementSet.epoch")


class OrbitalElementSet(Base):
    __tablename__ = "orbital_elements"
    id: Mapped[int] = mapped_column(primary_key=True)
    norad_id: Mapped[int] = mapped_column(ForeignKey("space_objects.norad_id"), index=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("data_sources.id"))
    run_id: Mapped[int] = mapped_column(ForeignKey("ingestion_runs.id"))
    epoch: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    retrieved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    line1: Mapped[str] = mapped_column(String(69))
    line2: Mapped[str] = mapped_column(String(69))
    element_kind: Mapped[str] = mapped_column(String(32), default="TLE/SGP4 mean")
    # Cached SGP4 mean values for fast filtering (never treated as osculating)
    mean_a_km: Mapped[float] = mapped_column(Float)
    mean_e: Mapped[float] = mapped_column(Float)
    mean_i_deg: Mapped[float] = mapped_column(Float)
    perigee_alt_km: Mapped[float] = mapped_column(Float)
    apogee_alt_km: Mapped[float] = mapped_column(Float)
    period_min: Mapped[float] = mapped_column(Float)
    obj: Mapped[SpaceObject] = relationship(back_populates="elements")
    source: Mapped[DataSource] = relationship()
    __table_args__ = (UniqueConstraint("norad_id", "epoch"), Index("ix_elements_epoch", "epoch"))


class OrbitClassification(Base):
    __tablename__ = "orbit_classifications"
    id: Mapped[int] = mapped_column(primary_key=True)
    element_set_id: Mapped[int] = mapped_column(ForeignKey("orbital_elements.id"), unique=True)
    labels: Mapped[list] = mapped_column(JSON)
    geo_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    status: Mapped[str] = mapped_column(String(32))
    result: Mapped[dict] = mapped_column(JSON)  # full criteria, config, warnings
    algorithm_version: Mapped[str] = mapped_column(String(64))
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    kind: Mapped[str] = mapped_column(String(32))
    message: Mapped[str] = mapped_column(Text)
    details: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class ScreeningRun(Base):
    """One conjunction screening of a primary object against the catalog."""

    __tablename__ = "screening_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    primary_norad_id: Mapped[int] = mapped_column(ForeignKey("space_objects.norad_id"), index=True)
    primary_element_set_id: Mapped[int] = mapped_column(ForeignKey("orbital_elements.id"))
    start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    horizon_s: Mapped[float] = mapped_column(Float)
    step_s: Mapped[float] = mapped_column(Float)
    threshold_km: Mapped[float] = mapped_column(Float)
    hbr_km: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(16), default="queued")
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    stats: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    warnings: Mapped[list | None] = mapped_column(JSON, nullable=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    algorithm_version: Mapped[str | None] = mapped_column(String(64), nullable=True)


class ConjunctionEventRow(Base):
    __tablename__ = "conjunction_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("screening_runs.id"), index=True)
    primary_norad_id: Mapped[int] = mapped_column(Integer, index=True)
    secondary_norad_id: Mapped[int] = mapped_column(Integer, index=True)
    primary_element_set_id: Mapped[int] = mapped_column(ForeignKey("orbital_elements.id"))
    secondary_element_set_id: Mapped[int] = mapped_column(ForeignKey("orbital_elements.id"))
    tca: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    miss_distance_km: Mapped[float] = mapped_column(Float)
    relative_speed_kms: Mapped[float] = mapped_column(Float)
    approach_angle_deg: Mapped[float] = mapped_column(Float)
    miss_rtn_km: Mapped[list] = mapped_column(JSON)
    geometry: Mapped[dict] = mapped_column(JSON)  # TEME states at TCA
    pc_max_isotropic: Mapped[float] = mapped_column(Float)
    priority: Mapped[str] = mapped_column(String(8))


class CollisionAssessmentRow(Base):
    __tablename__ = "collision_assessments"
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("conjunction_events.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    hbr_km: Mapped[float] = mapped_column(Float)
    covariance_source: Mapped[str] = mapped_column(String(64))
    inputs: Mapped[dict] = mapped_column(JSON)
    result: Mapped[dict] = mapped_column(JSON)
    algorithm_version: Mapped[str] = mapped_column(String(64))


# ------------------------------------------------------- external validation
class DatasetJob(Base):
    """Import / comparison jobs for external reference datasets (Kelvins, SOCRATES)."""

    __tablename__ = "dataset_jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))  # kelvins-import | socrates-import | socrates-compare
    status: Mapped[str] = mapped_column(String(16), default="queued")
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    params: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    files: Mapped[list | None] = mapped_column(JSON, nullable=True)  # provenance: path, size, sha256
    summary: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)


class KelvinsCdm(Base):
    __tablename__ = "kelvins_cdms"
    id: Mapped[int] = mapped_column(primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("dataset_jobs.id"), index=True)
    split: Mapped[str] = mapped_column(String(16), index=True)  # train | test | test_private
    event_id: Mapped[int] = mapped_column(Integer, index=True)
    mission_id: Mapped[int] = mapped_column(Integer, index=True)
    time_to_tca_d: Mapped[float] = mapped_column(Float)
    esa_risk: Mapped[float | None] = mapped_column(Float, nullable=True)  # log10 Pc
    esa_max_risk_estimate: Mapped[float | None] = mapped_column(Float, nullable=True)
    esa_mahalanobis: Mapped[float | None] = mapped_column(Float, nullable=True)
    miss_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    relative_speed_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    chaser_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    geometry_status: Mapped[str] = mapped_column(String(64))  # "ok" or rejection reason
    our_mahalanobis: Mapped[float | None] = mapped_column(Float, nullable=True)
    inferred_hbr_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    our_log10_pc: Mapped[float | None] = mapped_column(Float, nullable=True)  # with mission-median HBR
    inputs: Mapped[list | None] = mapped_column(JSON, nullable=True)  # fields needed to recompute (fixed order)


class SocratesConjunction(Base):
    __tablename__ = "socrates_conjunctions"
    id: Mapped[int] = mapped_column(primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("dataset_jobs.id"), index=True)
    norad_1: Mapped[int] = mapped_column(Integer, index=True)
    name_1: Mapped[str] = mapped_column(String(64))
    status_1: Mapped[str | None] = mapped_column(String(4), nullable=True)
    dse_1: Mapped[float] = mapped_column(Float)
    norad_2: Mapped[int] = mapped_column(Integer, index=True)
    name_2: Mapped[str] = mapped_column(String(64))
    status_2: Mapped[str | None] = mapped_column(String(4), nullable=True)
    dse_2: Mapped[float] = mapped_column(Float)
    tca: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    range_km: Mapped[float] = mapped_column(Float, index=True)
    relative_speed_kms: Mapped[float] = mapped_column(Float)
    max_prob: Mapped[float] = mapped_column(Float)
    dilution_km: Mapped[float] = mapped_column(Float)
    # comparison (filled by a socrates-compare job)
    compare_status: Mapped[str | None] = mapped_column(String(48), nullable=True)
    epoch_offset_1_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    epoch_offset_2_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    our_tca: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    our_range_km: Mapped[float | None] = mapped_column(Float, nullable=True)
    our_relative_speed_kms: Mapped[float | None] = mapped_column(Float, nullable=True)


# Identity / access control / proximity tables (separate module, new tables only)
from .auth import (  # noqa: E402,F401
    AuthToken,
    Department,
    EmailOutbox,
    OrgSatellite,
    Organization,
    ProximityJob,
    RolePermission,
    SatelliteAssignment,
    User,
    UserSession,
)
from .mission import (  # noqa: E402,F401
    AlertRead,
    DigitalTwin,
    ExperimentRun,
    ManeuverCandidate,
    ManeuverPlan,
    OrbitalState,
    PermissionCatalog,
    PropulsionModel,
    SimulationMetric,
    SimulationRun,
    SimulationTrajectory,
    SystemAlert,
)
