"""Satellite digital twin: a configurable spacecraft model.

Everything here is USER-CONFIGURED or SIMULATED. Public orbital data (TLE/GP)
contains no mass, propulsion or fuel information, so none of these numbers is
ever presented as the real state of a real spacecraft.

Rocket equation (Tsiolkovsky):
    Δv     = Isp g0 ln(m0 / mf)
    mf     = m0 exp(-Δv / (Isp g0))
    m_prop = m0 - mf
Constant-thrust burn time: t_b = m_prop Isp g0 / T.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

from .forces import G0

ALGORITHM_VERSION = "digital-twin/1.0.0"

DIRECTIONS = ("+R", "-R", "+T", "-T", "+N", "-N")


@dataclass
class Structure:
    dry_mass_kg: float = 450.0
    area_m2: float = 2.5  # mean cross-section for drag/SRP
    cd: float = 2.2
    cr: float = 1.3


@dataclass
class Propulsion:
    kind: str = "monopropellant (hydrazine)"
    thrust_n: float = 4.0
    isp_s: float = 220.0
    max_burn_s: float = 1800.0  # longest continuous burn allowed
    max_dv_per_burn_ms: float = 1.0  # operational cap per avoidance burn
    min_impulse_dv_ms: float = 0.001  # smallest controllable Δv
    power_w: float = 0.0  # electrical power the thruster needs (electric propulsion)


@dataclass
class Fuel:
    propellant_initial_kg: float = 40.0
    propellant_remaining_kg: float = 40.0  # SIMULATED bookkeeping, not telemetry
    reserve_kg: float = 5.0  # never planned for avoidance (end-of-life disposal etc.)


@dataclass
class Attitude:
    allowed_directions: list[str] = field(default_factory=lambda: list(DIRECTIONS))
    pointing_accuracy_deg: float = 1.0  # 1-sigma execution pointing error
    magnitude_error_frac: float = 0.02  # 1-sigma execution magnitude error
    min_lead_time_s: float = 1800.0  # earliest a burn can be executed after "now" (planning + upload)
    min_time_before_tca_s: float = 600.0  # latest a burn can be before the first threat


@dataclass
class Mission:
    alt_min_km: float = 400.0
    alt_max_km: float = 2000.0
    inc_min_deg: float = 0.0
    inc_max_deg: float = 180.0
    ecc_max: float = 0.05
    preserve_sso: bool = False
    sso_rate_tol_deg_day: float = 0.005  # allowed change of J2 nodal rate when preserving SSO
    da_tol_km: float = 2.0  # mission disruption normalisers
    di_tol_deg: float = 0.01
    de_tol: float = 0.001


@dataclass
class PowerThermal:
    available_power_w: float = 500.0
    max_burns_per_orbit: int = 1


@dataclass
class SpacecraftConfig:
    name: str = "Simulated satellite"
    structure: Structure = field(default_factory=Structure)
    propulsion: Propulsion = field(default_factory=Propulsion)
    fuel: Fuel = field(default_factory=Fuel)
    attitude: Attitude = field(default_factory=Attitude)
    mission: Mission = field(default_factory=Mission)
    power: PowerThermal = field(default_factory=PowerThermal)

    # ------------------------------------------------------------------ derived
    @property
    def wet_mass_kg(self) -> float:
        return self.structure.dry_mass_kg + self.fuel.propellant_remaining_kg

    @property
    def usable_propellant_kg(self) -> float:
        return max(0.0, self.fuel.propellant_remaining_kg - self.fuel.reserve_kg)

    def dv_available_ms(self) -> float:
        m0, mp = self.wet_mass_kg, self.usable_propellant_kg
        return 0.0 if mp <= 0 else self.propulsion.isp_s * G0 * math.log(m0 / (m0 - mp))

    def propellant_for(self, dv_ms: float) -> float:
        return self.wet_mass_kg * (1.0 - math.exp(-dv_ms / (self.propulsion.isp_s * G0)))

    def burn_duration_s(self, dv_ms: float) -> float:
        return self.propellant_for(dv_ms) * self.propulsion.isp_s * G0 / self.propulsion.thrust_n

    def max_single_burn_dv_ms(self) -> float:
        """Largest Δv one burn can deliver: min(operational cap, burn-time limit, usable propellant)."""
        p = self.propulsion
        m0 = self.wet_mass_kg
        mp_time = p.thrust_n * p.max_burn_s / (p.isp_s * G0)
        mp = min(mp_time, self.usable_propellant_kg)
        dv_time = p.isp_s * G0 * math.log(m0 / (m0 - mp)) if 0 < mp < m0 else 0.0
        return min(p.max_dv_per_burn_ms, dv_time)

    def ballistic_coefficient(self) -> float:
        """Cd A / m (m^2/kg)."""
        return self.structure.cd * self.structure.area_m2 / self.wet_mass_kg

    def validate(self) -> list[str]:
        e = []
        s, p, f, a, m = self.structure, self.propulsion, self.fuel, self.attitude, self.mission
        if s.dry_mass_kg <= 0:
            e.append("dry mass must be positive")
        if s.area_m2 <= 0:
            e.append("reference area must be positive")
        if not (1.0 <= s.cd <= 4.0):
            e.append("Cd outside the physical range 1-4")
        if not (1.0 <= s.cr <= 2.0):
            e.append("Cr must be between 1 (absorbing) and 2 (specular reflector)")
        if p.thrust_n <= 0 or p.isp_s <= 0:
            e.append("thrust and Isp must be positive")
        if p.isp_s > 10000:
            e.append("Isp above 10,000 s is not a realistic thruster")
        if p.max_burn_s <= 0 or p.max_dv_per_burn_ms <= 0:
            e.append("burn limits must be positive")
        if f.propellant_remaining_kg < 0 or f.propellant_remaining_kg > f.propellant_initial_kg + 1e-9:
            e.append("remaining propellant must be between 0 and the initial load")
        if f.reserve_kg < 0:
            e.append("reserve can't be negative")
        if not a.allowed_directions or any(d not in DIRECTIONS for d in a.allowed_directions):
            e.append(f"allowed directions must be a non-empty subset of {DIRECTIONS}")
        if m.alt_min_km >= m.alt_max_km:
            e.append("altitude range is empty")
        if m.inc_min_deg > m.inc_max_deg:
            e.append("inclination range is empty")
        if p.power_w > self.power.available_power_w:
            e.append("thruster needs more power than is available: no burn is possible")
        return e

    def summary(self) -> dict:
        return {
            "wet_mass_kg": self.wet_mass_kg,
            "usable_propellant_kg": self.usable_propellant_kg,
            "dv_available_ms": self.dv_available_ms(),
            "max_single_burn_dv_ms": self.max_single_burn_dv_ms(),
            "burn_s_per_10_cm_s": self.burn_duration_s(0.1),
            "propellant_g_per_10_cm_s": self.propellant_for(0.1) * 1000,
            "ballistic_coefficient_m2_kg": self.ballistic_coefficient(),
            "area_to_mass_m2_kg": self.structure.area_m2 / self.wet_mass_kg,
            "validation_errors": self.validate(),
            "data_origin": "user-configured / simulated (public orbital data has no spacecraft properties)",
            "algorithm_version": ALGORITHM_VERSION,
        }

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict) -> "SpacecraftConfig":
        return SpacecraftConfig(
            name=d.get("name", "Simulated satellite"),
            structure=Structure(**d.get("structure", {})),
            propulsion=Propulsion(**d.get("propulsion", {})),
            fuel=Fuel(**d.get("fuel", {})),
            attitude=Attitude(**d.get("attitude", {})),
            mission=Mission(**d.get("mission", {})),
            power=PowerThermal(**d.get("power", {})),
        )


# Typical-value templates. They are starting points the user edits; they don't describe any real spacecraft.
PROPULSION_PRESETS = {
    "cold-gas": Propulsion("cold gas (N2)", thrust_n=0.1, isp_s=65.0, max_burn_s=600.0, max_dv_per_burn_ms=0.3),
    "monoprop": Propulsion("monopropellant (hydrazine)", thrust_n=4.0, isp_s=220.0, max_burn_s=1800.0, max_dv_per_burn_ms=1.0),
    "green-monoprop": Propulsion("green monopropellant (AF-M315E class)", thrust_n=1.0, isp_s=235.0, max_burn_s=1800.0, max_dv_per_burn_ms=1.0),
    "biprop": Propulsion("bipropellant (MMH/NTO)", thrust_n=22.0, isp_s=290.0, max_burn_s=1200.0, max_dv_per_burn_ms=2.0),
    "hall": Propulsion("electric (Hall effect)", thrust_n=0.02, isp_s=1500.0, max_burn_s=5400.0, max_dv_per_burn_ms=0.2, power_w=350.0),
}
