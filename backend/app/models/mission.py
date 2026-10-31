"""Phase 5-8 tables: digital twins, maneuver planning, simulations, alerts, experiments.

Simulated data lives only here. Nothing in these tables ever modifies a catalogue
record (space_objects / orbital_elements): a digital twin starts from a copy of a
catalogue object's computed state and is a separate, simulated satellite.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..core.db import Base
from . import utcnow


class PropulsionModel(Base):
    __tablename__ = "propulsion_models"
    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str | None] = mapped_column(String(32), nullable=True, unique=True)  # presets only
    name: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(64))
    thrust_n: Mapped[float] = mapped_column(Float)
    isp_s: Mapped[float] = mapped_column(Float)
    max_burn_s: Mapped[float] = mapped_column(Float)
    max_dv_per_burn_ms: Mapped[float] = mapped_column(Float)
    min_impulse_dv_ms: Mapped[float] = mapped_column(Float, default=0.001)
    power_w: Mapped[float] = mapped_column(Float, default=0.0)
    is_preset: Mapped[bool] = mapped_column(Boolean, default=False)
    organization_id: Mapped[int | None] = mapped_column(ForeignKey("organizations.id"), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DigitalTwin(Base):
    __tablename__ = "satellite_digital_twins"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    source_norad_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    source_element_set_id: Mapped[int | None] = mapped_column(ForeignKey("orbital_elements.id"), nullable=True)
    state_source: Mapped[str] = mapped_column(Text)  # how the initial state was obtained
    epoch: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    r_km: Mapped[list] = mapped_column(JSON)  # TEME at epoch
    v_kms: Mapped[list] = mapped_column(JSON)
    config: Mapped[dict] = mapped_column(JSON)  # SpacecraftConfig.to_dict()
    propulsion_model_id: Mapped[int | None] = mapped_column(ForeignKey("propulsion_models.id"), nullable=True)
    fuel_log: Mapped[list | None] = mapped_column(JSON, nullable=True)  # simulated propellant bookkeeping
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class OrbitalState(Base):
    """Computed Cartesian states with frame and provenance (twin initial states, re-anchors)."""

    __tablename__ = "orbital_states"
    id: Mapped[int] = mapped_column(primary_key=True)
    twin_id: Mapped[int | None] = mapped_column(ForeignKey("satellite_digital_twins.id"), nullable=True, index=True)
    norad_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    epoch: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    frame: Mapped[str] = mapped_column(String(64))
    r_km: Mapped[list] = mapped_column(JSON)
    v_kms: Mapped[list] = mapped_column(JSON)
    source: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ManeuverPlan(Base):
    __tablename__ = "maneuver_plans"
    id: Mapped[int] = mapped_column(primary_key=True)
    twin_id: Mapped[int] = mapped_column(ForeignKey("satellite_digital_twins.id"), index=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    method: Mapped[str] = mapped_column(String(32), default="proposed")
    status: Mapped[str] = mapped_column(String(32), default="queued")
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    stage: Mapped[str | None] = mapped_column(String(128), nullable=True)
    params: Mapped[dict] = mapped_column(JSON)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    algorithm_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ManeuverCandidate(Base):
    __tablename__ = "maneuver_candidates"
    id: Mapped[int] = mapped_column(primary_key=True)
    plan_id: Mapped[int] = mapped_column(ForeignKey("maneuver_plans.id"), index=True)
    rank: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(String(16))  # nominal | selected | candidate
    t_m: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dv_r_ms: Mapped[float] = mapped_column(Float)
    dv_t_ms: Mapped[float] = mapped_column(Float)
    dv_n_ms: Mapped[float] = mapped_column(Float)
    dv_ms: Mapped[float] = mapped_column(Float)
    feasible: Mapped[bool] = mapped_column(Boolean)
    reasons: Mapped[list] = mapped_column(JSON)
    objective: Mapped[float | None] = mapped_column(Float, nullable=True)
    data: Mapped[dict] = mapped_column(JSON)


class SimulationRun(Base):
    __tablename__ = "simulation_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    plan_id: Mapped[int | None] = mapped_column(ForeignKey("maneuver_plans.id"), nullable=True, index=True)
    twin_id: Mapped[int] = mapped_column(ForeignKey("satellite_digital_twins.id"), index=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="queued")
    config: Mapped[dict] = mapped_column(JSON)
    versions: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SimulationTrajectory(Base):
    __tablename__ = "simulation_trajectories"
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("simulation_runs.id"), index=True)
    label: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(16))  # original | modified | threat
    frame: Mapped[str] = mapped_column(String(96))
    start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    step_s: Mapped[float] = mapped_column(Float)
    data: Mapped[dict] = mapped_column(JSON)  # {"ecef_km": [[x,y,z]...], "vel_kms": [...], "teme_km": [...]}


class SimulationMetric(Base):
    __tablename__ = "simulation_metrics"
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("simulation_runs.id"), index=True)
    name: Mapped[str] = mapped_column(String(64))
    value: Mapped[float | None] = mapped_column(Float, nullable=True)
    unit: Mapped[str | None] = mapped_column(String(16), nullable=True)
    context: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class SystemAlert(Base):
    __tablename__ = "system_alerts"
    id: Mapped[int] = mapped_column(primary_key=True)
    organization_id: Mapped[int | None] = mapped_column(ForeignKey("organizations.id"), nullable=True, index=True)  # None = everyone
    permission: Mapped[str | None] = mapped_column(String(64), nullable=True)  # who may see it
    severity: Mapped[str] = mapped_column(String(16))  # info | warning | critical
    kind: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(200))
    message: Mapped[str] = mapped_column(Text)
    link: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class AlertRead(Base):
    __tablename__ = "alert_reads"
    id: Mapped[int] = mapped_column(primary_key=True)
    alert_id: Mapped[int] = mapped_column(ForeignKey("system_alerts.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    __table_args__ = (UniqueConstraint("alert_id", "user_id"),)


class ExperimentRun(Base):
    __tablename__ = "experiment_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(8))
    profile: Mapped[str] = mapped_column(String(16))
    seeds: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="queued")
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    stage: Mapped[str | None] = mapped_column(String(160), nullable=True)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    organization_id: Mapped[int | None] = mapped_column(ForeignKey("organizations.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PermissionCatalog(Base):
    """Permissions this database has already been offered, so upgrades grant only NEW ones by default."""

    __tablename__ = "permission_catalog"
    id: Mapped[int] = mapped_column(primary_key=True)
    permission: Mapped[str] = mapped_column(String(64), unique=True)
    introduced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
