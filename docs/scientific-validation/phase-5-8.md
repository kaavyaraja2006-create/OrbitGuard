# Phases 5–8: scientific validation

Every row is an automated test (`scientific-engine/tests/`, `backend/tests/`).
Run them with `python -m pytest -q`.

## Phase 5: force models, numerical propagation, digital twin (`test_phase5.py`)

| Check | Reference | Result |
|---|---|---|
| Sun position, 2 Apr 2006 | Vallado Ex. 5-1 (0.9771945, 0.1924424, 0.0834308) AU | within 5e-6 AU |
| Moon position, 28 Apr 1994 | Vallado Ex. 5-3 (−134240.626, −311571.590, −126693.785) km | within 1 km |
| J2, J3, J4, J2+J3+J4 accelerations | finite-difference gradient of the zonal potential | rtol 1e-7 |
| Exponential atmosphere | Vallado Table 8-4 (ρ(400 km) = 3.725e-12) | exact; monotonic 100–1000 km |
| Two-body vs Kepler, 1 period / 1 day | analytical | < 10 cm / < 1 m |
| Energy and angular momentum (two-body, 1 day) | conservation | < 1e-8 relative |
| J2 nodal regression, 700 km 98.19°, 3 days | ½-order secular theory | within 0.02° (≈ 0.9856 °/day: really SSO) |
| Numerical (J2–J4) vs SGP4, 24 h | independent analytical theory | < 15 km (actual 1.96 km) |
| Drag decay at 300 km | da/dt = −ρ (C_D A/m)(v_rel/v)² √(μa) | within 3 % |
| Batched = individual propagation | full force model | < 1 cm |
| Impulsive tangential burn | Gauss / vis-viva Δa = 2a²vΔv/μ | 1e-3 relative |
| Mass after impulse | rocket equation | 1e-12 relative |
| Finite burn → impulsive | same Δv | Δa within 0.1 %, same propellant |
| Rocket equation round trip, hand value | 10 m/s, 500 kg, I_sp 220 s → 2.3125 kg | exact |
| Twin summary and validation | hand-computed; power check | exact |

## Phase 6: maneuver optimisation (`test_phase6.py`)

| Check | Result |
|---|---|
| Synthetic threats pass at the designed TCA and miss | within 1 m and 1 s |
| Linearised closest approach vs 10 ms brute force | < 1 m |
| Candidate grid respects the maneuver window, directions and Δv limit | ✓ |
| Optimiser selects a feasible maneuver, safe against **every** threat; miss and Pc improve | ✓ |
| SSO nodal rate preserved when required | within tolerance |
| Monte Carlo violation after < before, and ≤ limit | ✓ |
| Independent validation (finite burn, full force model) | PASSED |
| Every candidate's feasibility matches its rejection reasons | ✓ |
| Far threats → "no maneuver needed" | ✓ |
| 4 mm/s budget → honest "no feasible/robust candidate", nothing selected | ✓ |
| Only ±N allowed → selected burn has zero R and T | ✓ |
| Single-threat baseline sees one threat but is scored against all | ✓ |

## Phase 7: orbit transfer laboratory (`test_phase7_transfer.py`)

| Check | Reference | Result |
|---|---|---|
| Hohmann LEO→GEO | Vallado Ex. 6-1: 2.457038 + 1.478187 = 3.935224 km/s, 5.256713 h | within 1e-5 km/s, 1e-4 h |
| Bi-elliptic | Vallado Ex. 6-2: 3.904057 km/s, 593.919 h | within 1e-4 km/s, 0.05 h |
| Plane change | 2v sin(Δi/2) | exact |
| Combined LEO→GEO from 28.5° (both signs of Δi) | optimal split < all-at-apoapsis < separate plane change; ≈ 4.2–4.35 km/s | ✓ |
| Flown transfers reach the target (raise, lower, MEO, GEO, plane change) | a within 50 m, e < 1e-5, i within 1e-4° | ✓ |
| Flown Δv = analytical Δv | 1e-6 relative | ✓ |
| GTO apogee | GEO radius | within 0.1 km |

A real bug was found by looking at the UI: a *negative* plane change (28.5° → 0°) made the
"separate plane change" alternative subtract instead of add. It is fixed, and both signs are
now tested.

## Phase 8: experiments (`test_phase8_experiments.py`)

| Check | Result |
|---|---|
| Scenarios are seeded (same seed, same scenario) and labelled SYNTHETIC | ✓ |
| E4 reruns give bit-identical Δv, separations and Monte Carlo results | ✓ |
| "No maneuver" really is dangerous in the scenarios | ✓ |
| CSV export has one row per run | ✓ |

## Backend integration (`backend/tests/test_mission.py`)

The full flow, through the real API with real accounts:
1. a twin is created from a catalogue object (SSO detected from its actual nodal rate)
2. numerical propagation is compared with SGP4 (< 10 km over 6 h)
3. the plan is optimised against two synthetic threats and independently validated
4. the report contains every section the spec requires
5. the simulation produces original, modified and two threat tracks, with separation after > before
6. fuel is booked once (SIMULATED); a second booking is refused
7. the transfer lab is open to the public role
8. research experiments can be run by a scientist; a mission manager can read but not run them
9. alerts are scoped per organisation

The permission upgrade from a pre-Phase-5 database grants only the new permissions and
keeps an administrator's earlier edits.
