"""Worked calculations for Phases 5-8 with inputs, formulas, intermediate values and results.

    python examples/phase5_8_worked_example.py
"""

from __future__ import annotations

import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from orbitguard_engine.conjunction import satrec_from_elements  # noqa: E402
from orbitguard_engine.constants import MU_EARTH, R_EARTH  # noqa: E402
from orbitguard_engine.elements import coe_to_rv, j2_secular_rates, rv_to_coe  # noqa: E402
from orbitguard_engine.forces import G0, ForceModel  # noqa: E402
from orbitguard_engine.frames import datetime_to_jd  # noqa: E402
from orbitguard_engine.maneuver import OptimizerConfig, Uncertainty, body_of, optimise, synthetic_threats  # noqa: E402
from orbitguard_engine.numerical import Impulse, propagate  # noqa: E402
from orbitguard_engine.spacecraft import SpacecraftConfig  # noqa: E402
from orbitguard_engine.transfer import TransferRequest, fly, hohmann  # noqa: E402

EP = datetime(2026, 11, 1, tzinfo=timezone.utc)
line = "-" * 78

print(line, "\n1. Rocket equation (digital twin)")
sc = SpacecraftConfig()
m0, isp, dv = sc.wet_mass_kg, sc.propulsion.isp_s, 0.10
mf = m0 * math.exp(-dv / (isp * G0))
print(f"   m0 = {m0} kg, Isp = {isp} s, g0 = {G0}, dv = {dv} m/s")
print(f"   mf = m0 exp(-dv/(Isp g0)) = {mf:.6f} kg  ->  m_prop = {m0 - mf:.6f} kg ({(m0 - mf) * 1000:.3f} g)")
print(f"   burn time = m_prop Isp g0 / T = {(m0 - mf) * isp * G0 / sc.propulsion.thrust_n:.3f} s at T = {sc.propulsion.thrust_n} N")
print(f"   usable propellant {sc.usable_propellant_kg} kg -> dv_available = Isp g0 ln(m0/(m0-mp)) = {sc.dv_available_ms():.4f} m/s")

print(line, "\n2. Impulsive tangential burn: Gauss / vis-viva check")
a = R_EARTH + 700
r, v = (np.array(x) for x in coe_to_rv(a, 0, 0, 0, 0, 0))
tr = propagate(EP, r, v, np.array([0.0, 1.0]), ForceModel(j2=False), impulses=[Impulse(0.5, [0, 1e-3, 0])])
coe = rv_to_coe(tr.r[0, 1], tr.v[0, 1])
vc = math.sqrt(MU_EARTH / a)
print(f"   a = {a:.3f} km, v_c = {vc:.6f} km/s, dv_T = 1 m/s")
print(f"   first order: da = 2 a^2 v dv / mu = {2 * a * a * vc * 1e-3 / MU_EARTH * 1000:.3f} m")
print(f"   numerical:   da = {(coe.a_km - a) * 1000:.3f} m")

print(line, "\n3. J2 nodal regression of a 700 km SSO (98.19 deg), 3 days")
r, v = (np.array(x) for x in coe_to_rv(a, 0, 98.19, 30, 0, 0))
tr = propagate(EP, r, v, np.array([0.0, 3 * 86400]), ForceModel(j2=True))
d = (rv_to_coe(tr.r[0, 1], tr.v[0, 1]).raan_deg - rv_to_coe(tr.r[0, 0], tr.v[0, 0]).raan_deg + 180) % 360 - 180
rate = math.degrees(j2_secular_rates(a, 0, 98.19)[0]) * 86400
print(f"   theory dRAAN/dt = -3/2 J2 n (Re/p)^2 cos i = {rate:.5f} deg/day (SSO needs 0.98565)")
print(f"   numerical drift over 3 days = {d:.4f} deg  ({d / 3:.5f} deg/day, osculating)")

print(line, "\n4. Numerical (J2-J4) vs SGP4 after 24 h, same initial state")
sat = satrec_from_elements(EP, 7078.0, 1e-3, 98.0, 40.0, 10.0, 0.0)
jd, fr = datetime_to_jd(EP)
_, r0, v0 = sat.sgp4(jd, fr)
for name, fm in (("J2", ForceModel(True)), ("J2+J3+J4", ForceModel(True, True, True))):
    trn = propagate(EP, r0, v0, np.array([86400.0]), fm)
    _, r1, _ = sat.sgp4(jd, fr + 1.0)
    print(f"   {name:9s}: |r_num - r_SGP4| = {np.linalg.norm(trn.r[0, 0] - np.array(r1)):.3f} km   (rhs evals {trn.stats['rhs_evaluations']})")

print(line, "\n5. Hohmann LEO -> GEO (Vallado Example 6-1 radii)")
h = hohmann(R_EARTH + 191.34411, R_EARTH + 35781.34857)
print(f"   dv1 = {h['dv1_kms']:.6f}, dv2 = {h['dv2_kms']:.6f}, total = {h['dv_total_kms']:.6f} km/s, TOF = {h['tof_s'] / 3600:.6f} h")
f = fly(TransferRequest("hohmann", 191.34411, 35781.34857, 0.0))
print(f"   flown numerically: a = {f['reached']['a_km']:.4f} km (target {R_EARTH + 35781.34857:.4f}), e = {f['reached']['e']:.2e}")

print(line, "\n6. Multi-threat optimisation (SYNTHETIC scenario, ASSUMED covariance)")
r0, v0 = (np.array(x) for x in coe_to_rv(R_EARTH + 700, 0.001, 98.19, 30, 0, 10))
cfg = OptimizerConfig(horizon_s=86400)
sc2 = SpacecraftConfig()
sc2.mission.preserve_sso = True
th = synthetic_threats(EP, r0, v0, [dict(tca_s=30000, miss_km=0.08, crossing_deg=70, phase_deg=10),
                                     dict(tca_s=52000, miss_km=0.15, crossing_deg=120, phase_deg=80),
                                     dict(tca_s=71000, miss_km=0.3, crossing_deg=40, phase_deg=200)], force=cfg.force, body=body_of(sc2))
res = optimise(EP, r0, v0, sc2, th, cfg, Uncertainty())
print(f"   status: {res['status']}; candidates propagated: {res['candidates_evaluated']}; runtime {res['runtime_s']:.1f} s")
for st in res["stages"]:
    print("   stage", st)
for x in res.get("explanation", []):
    print("   -", x)
