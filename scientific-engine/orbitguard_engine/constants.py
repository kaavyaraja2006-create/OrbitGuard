"""Physical constants used across the ORBITGUARD scientific engine.

Two Earth models appear deliberately:

* WGS-72 constants are what SGP4 and TLE mean elements are defined against.
  Anything derived *from TLE mean elements* must use these, otherwise the
  semi-major axis recovered from mean motion is inconsistent with SGP4.
* WGS-84 constants are used for geodetic (latitude / longitude / altitude)
  conversion of Earth-fixed positions, because that is the reference
  ellipsoid for modern geodetic coordinates.

Units: km, s, rad unless a name says otherwise.
"""

from __future__ import annotations

import math

# --- WGS-72 (SGP4 / TLE consistency) -------------------------------------
MU_WGS72 = 398600.8  # km^3 / s^2
RE_WGS72 = 6378.135  # km
J2_WGS72 = 0.001082616

# --- EGM-96 / WGS-84 (general astrodynamics + geodesy) -------------------
MU_EARTH = 398600.4418  # km^3 / s^2
R_EARTH = 6378.137  # km, equatorial radius
J2 = 1.08262668e-3
WGS84_F = 1.0 / 298.257223563
WGS84_E2 = WGS84_F * (2.0 - WGS84_F)

# Earth rotation rate (inertial), rad/s
OMEGA_EARTH = 7.2921158553e-5

# Time
SECONDS_PER_DAY = 86400.0
SIDEREAL_DAY_S = 86164.0905  # mean sidereal day, s
TROPICAL_YEAR_DAYS = 365.2421897

# Required nodal precession for a Sun-synchronous orbit:
# one full revolution (2*pi) per tropical year, eastward (positive).
SSO_RAAN_RATE_RAD_S = 2.0 * math.pi / (TROPICAL_YEAR_DAYS * SECONDS_PER_DAY)
SSO_RAAN_RATE_DEG_DAY = 360.0 / TROPICAL_YEAR_DAYS  # ~0.9856 deg/day

# Geostationary radius from Kepler's third law with the sidereal day.
GEO_RADIUS_KM = (MU_EARTH * (SIDEREAL_DAY_S / (2.0 * math.pi)) ** 2) ** (1.0 / 3.0)
GEO_ALTITUDE_KM = GEO_RADIUS_KM - R_EARTH  # ~35786 km

DEG = math.pi / 180.0
