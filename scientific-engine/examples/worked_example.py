"""Worked calculations for the documentation, printed with intermediate values.

Run:  python examples/worked_example.py
Every number in docs/mathematics/phase-1-2.md comes from this script's output.
"""

from __future__ import annotations

import math

import numpy as np

from orbitguard_engine.classification import classify_orbit, required_sso_inclination_deg
from orbitguard_engine.constants import J2, MU_EARTH, MU_WGS72, R_EARTH, RE_WGS72, SECONDS_PER_DAY, SSO_RAAN_RATE_DEG_DAY
from orbitguard_engine.elements import derived_parameters, rv_to_coe
from orbitguard_engine.propagation import mean_elements, propagate_tsince, satrec_from_tle
from orbitguard_engine.tle import parse_tle, tle_checksum

L1 = "1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753"
L2 = "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667"

print("=" * 72)
print("EXAMPLE 1 - Vanguard 1 (NORAD 5), Vallado SGP4 verification case")
print("=" * 72)
print(f"Checksums: line1 computed={tle_checksum(L1)} stored={L1[68]}, line2 computed={tle_checksum(L2)} stored={L2[68]}")
tle = parse_tle(L1, L2)
print(f"Epoch: {tle.epoch.isoformat()}  i={tle.inclination_deg} deg  e={tle.eccentricity}  n={tle.mean_motion_rev_day} rev/day")

sat = satrec_from_tle(tle)
me = mean_elements(sat, tle.epoch)
print("\n-- SGP4 mean elements (WGS-72) --")
print(f"a = {me.a_km:.6f} km   (Kozai n from TLE gives {(MU_WGS72 / (sat.no_kozai / 60) ** 2) ** (1 / 3):.6f} km)")

d = derived_parameters(me.a_km, me.e, me.i_deg, mu=MU_WGS72, re=RE_WGS72)
print("\n-- Derived parameters --")
print(f"r_p = a(1-e) = {me.a_km:.4f} x {1 - me.e:.7f} = {d.perigee_radius_km:.4f} km  -> h_p = {d.perigee_altitude_km:.4f} km")
print(f"r_a = a(1+e) = {me.a_km:.4f} x {1 + me.e:.7f} = {d.apogee_radius_km:.4f} km  -> h_a = {d.apogee_altitude_km:.4f} km")
print(f"T = 2 pi sqrt(a^3/mu) = {d.period_s:.4f} s = {d.period_min:.4f} min")
n = math.sqrt(MU_WGS72 / me.a_km**3)
p = me.a_km * (1 - me.e**2)
print(f"n = sqrt(mu/a^3) = {n:.9e} rad/s ; p = a(1-e^2) = {p:.4f} km")
print(f"RAAN rate = -(3/2) J2 n (Re/p)^2 cos i = {d.raan_rate_deg_day:.6f} deg/day")

cls = classify_orbit(me.a_km, me.e, me.i_deg, mu=MU_WGS72, re=RE_WGS72)
print("\n-- Classification --")
for c in cls.criteria:
    print(f"  {c.label:5s} value={c.value:12.5f}  threshold: {c.threshold:45s} -> {'MATCH' if c.passed else 'no'}")
print(f"Labels: {cls.labels}  status: {cls.status}  regions crossed: {cls.regions_crossed}")

sv = propagate_tsince(sat, 0.0)
ref = np.array([7022.46529266, -1400.08296755, 0.03995155])
print("\n-- SGP4 state at epoch (TEME) vs Vallado tcppver.out --")
print(f"r  = {np.round(sv.r_km, 8).tolist()} km")
print(f"ref= {ref.tolist()} km")
print(f"|dr| = {np.linalg.norm(sv.r_km - ref) * 1e6:.3f} mm")
osc = rv_to_coe(sv.r_km, sv.v_kms, mu=MU_WGS72)
print(f"Osculating at epoch: a={osc.a_km:.4f} km e={osc.e:.6f} i={osc.i_deg:.5f} deg (differs from mean a by {osc.a_km - me.a_km:+.3f} km, as expected)")

print("\n" + "=" * 72)
print("EXAMPLE 2 - Sun-synchronous condition for a 700 km circular orbit")
print("=" * 72)
a = R_EARTH + 700.0
n = math.sqrt(MU_EARTH / a**3)
target = math.radians(SSO_RAAN_RATE_DEG_DAY) / SECONDS_PER_DAY
cos_i = -target / (1.5 * J2 * n * (R_EARTH / a) ** 2)
print(f"a = {a:.3f} km, n = {n:.9e} rad/s")
print(f"Required RAAN rate = 360/365.2422 = {SSO_RAAN_RATE_DEG_DAY:.6f} deg/day = {target:.6e} rad/s")
print(f"cos i = -Omega_dot / (1.5 J2 n (Re/a)^2) = {cos_i:.6f}  ->  i = {math.degrees(math.acos(cos_i)):.4f} deg")
print(f"(library) required_sso_inclination_deg = {required_sso_inclination_deg(a):.4f} deg")
res = classify_orbit(a, 0.0, required_sso_inclination_deg(a))
print(f"Classification: {res.labels}")
