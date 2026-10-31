# Mathematics — Phases 1–2

Every number below was produced by `scientific-engine/examples/worked_example.py`
(run it to reproduce). Units: km, s, degrees unless stated.

## 1. Two Earth models, on purpose

| Use | Constants | Why |
|---|---|---|
| Anything derived from TLE mean elements (SGP4, catalog classification) | WGS-72: μ = 398600.8 km³/s², Rₑ = 6378.135 km | SGP4 and TLEs are defined against WGS-72; mixing models biases *a* |
| Geodetic lat/lon/alt, general astrodynamics | WGS-84 / EGM-96: μ = 398600.4418, Rₑ = 6378.137, J₂ = 1.08262668e-3, f = 1/298.257223563 | Modern geodetic reference |

TLE elements are **SGP4 mean elements**, never treated as osculating Keplerian elements.
The inspector shows both and labels them.

## 2. Orbital elements and derived parameters

From a state vector (r, v), algorithm RV2COE (Vallado):

- h = r × v, n = k̂ × h, e = ((v² − μ/r) r − (r·v) v) / μ
- ε = v²/2 − μ/r, a = −μ / (2ε), p = h²/μ, i = acos(h_z / |h|)
- Ω, ω, ν from the node and eccentricity vectors, with quadrant checks
- Circular or equatorial orbits: the undefined angles are **flagged**, and the defined
  substitute (argument of latitude, longitude of periapsis or true longitude) is returned.

Derived:

- r_p = a(1 − e), r_a = a(1 + e), h = r − Rₑ
- T = 2π √(a³/μ), n = √(μ/a³)
- J₂ secular rates: Ω̇ = −(3/2) J₂ n (Rₑ/p)² cos i, ω̇ = (3/4) J₂ n (Rₑ/p)² (5cos²i − 1)

### Worked example 1 — Vanguard 1 (NORAD 5), Vallado verification TLE

```
Checksums: line1 computed=3 stored=3, line2 computed=7 stored=7
a (SGP4 mean)      = 8635.355832 km   (Kozai n from TLE gives 8632.534542 km)
r_p = 8635.3558 x 0.8140333 = 7029.4672 km  -> h_p = 651.3322 km
r_a = 8635.3558 x 1.1859667 = 10241.2445 km -> h_a = 3863.1095 km
T   = 7986.0338 s = 133.1006 min
n   = 7.867716927e-04 rad/s ; p = 8336.7140 km
Ω̇   = -3.059488 deg/day
SGP4 state at epoch (TEME): r = [7022.46529266, -1400.08296755, 0.03995155] km
Vallado tcppver.out:            [7022.46529266, -1400.08296755, 0.03995155] km   |dr| = 0.007 mm
Osculating a at epoch = 8638.2045 km (+2.849 km from mean a, as expected)
```

**Classification result:** no label. Status `unclassified-regime`, regions crossed LEO + MEO.
Vanguard 1's apogee (3863 km) is above the LEO ceiling, its perigee (651 km) is below MEO,
and e = 0.186 is under the project HEO threshold (0.25). See §4 for the open decision.

## 3. Sun-synchronous condition

A Sun-synchronous orbit precesses eastward once per tropical year:
Ω̇_SSO = 360° / 365.2422 d = 0.985647 °/day = 1.991064e-7 rad/s.

### Worked example 2 — 700 km circular orbit

```
a = 7078.137 km, n = 1.060206448e-03 rad/s
cos i = −Ω̇ / (1.5 J2 n (Re/a)²) = −0.142421  ->  i = 98.1880°
Classification: ['LEO', 'POLAR', 'SSO']
```

This is the standard textbook result (≈98.2° at 700 km), and it is covered by a unit test.

## 4. Multi-label classification rules (`orbit-classification/1.0.0`)

Each label is evaluated independently. Thresholds live in `ClassificationConfig`.

| Label | Rule | Default |
|---|---|---|
| LEO | apogee altitude < ceiling | 2000 km |
| MEO | perigee ≥ 2000 km and apogee < GEO altitude − band | band 200 km |
| GEO | mean motion within tolerance of 1 rev / sidereal day | ±0.005 rev/day (≈ ±140 km) |
| ↳ geostationary | GEO and e ≤ 0.01 and i ≤ 1° | |
| POLAR | \|i − 90°\| ≤ band | 10° (project convention) |
| SSO | \|Ω̇_J2 − 0.9856\| ≤ tolerance | 0.05 °/day |
| HEO | e ≥ threshold | 0.25 (project convention) |

The GEO tolerance was tightened from 0.015 to 0.005 rev/day after a test showed the
looser value labelled IADC graveyard orbits (+300 km) as GEO.

**Open decision:** orbits like Vanguard 1 (eccentric, crossing LEO and MEO, e < 0.25)
fit none of the six labels. Options: lower the HEO threshold, add a "LEO–MEO crossing"
qualifier, or keep reporting them as unclassified with `regions_crossed`. Currently the
last option is used because it invents nothing.

## 5. Reference frames

```
TEME --R3(GMST)--> PEF ≈ ITRF   (Earth-fixed, used for the globe)
```

- GMST is the IAU-82 expression used inside SGP4 (unit test: 280.46061837° at J2000.0).
- v_ITRF = R3 v_TEME − ω⊕ × r_ITRF.
- **Approximations (documented, acceptable for TLE visualisation only):** polar motion
  neglected (~10 m), UT1 ≈ UTC (≤ 0.9 s, up to ~0.4 km at the equator). Phase 4 conjunction
  work must use proper EOP data.
- Geodetic conversion: Bowring iteration on WGS-84, round-trip tested to 1e-9° / 1 mm.
- RTN basis: R = r̂, N = (r × v)/|r × v|, T = N × R (orthonormality tested).
