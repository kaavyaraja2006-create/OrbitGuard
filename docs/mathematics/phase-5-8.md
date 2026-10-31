# Phases 5–8: mathematics, models and design decisions

Everything here is implemented in `scientific-engine/orbitguard_engine/` (`forces.py`,
`numerical.py`, `spacecraft.py`, `maneuver.py`, `transfer.py`, `experiments.py`) and is
exercised by `examples/phase5_8_worked_example.py`. Its real output is in
`research/experiments/phase5_8_worked_example_output.txt`.

## 1. Two propagation pathways (spec §7)

| | Catalogue objects | Maneuverable simulated satellites (digital twins) |
|---|---|---|
| Model | SGP4 on TLE/GP mean elements | Cowell: numerical integration of r̈ = Σ a |
| Frame | TEME | TEME of the plan epoch, held fixed (quasi-inertial) |
| Used for | tracking, screening, threats | nominal and maneuvered trajectories |

**Hand-over.** A twin starts from the SGP4 *osculating* state of its source object at the
plan epoch (`twin_state_at`). From then on it is propagated numerically. TLE mean elements
are never fed to the numerical integrator.

**Frame simplification.** The TEME frame of the epoch is treated as inertial for the
horizon (≤ 72 h). Precession moves true-of-date axes by about 0.14″/day, a few metres at
LEO. That is far below the force-model uncertainty, which is dominated by drag.

## 2. Force model (`forces.py`)

r̈ = −μ r/|r|³ + a_J2 + a_J3 + a_J4 + a_drag + a_SRP + a_Sun + a_Moon + a_thrust

| Term | Formula | Source |
|---|---|---|
| Zonal J2–J4 | closed-form gradients of the zonal potential (EGM-96 J2, J3, J4) | Vallado (2013) §8.6. The test checks each against a finite-difference gradient of the potential to 1e-7 |
| Drag | −½ (C_D A/m) ρ(h) \|v_rel\| v_rel, with v_rel = v − ω_E × r | static exponential atmosphere, Vallado Table 8-4 (0–1000 km) |
| Sun, Moon | μ_k [(s − r)/\|s − r\|³ − s/\|s\|³] | low-precision ephemerides, Vallado Alg. 29 and 31 |
| SRP | ν P☉ C_R (A/m) (AU/d)² û_away, P☉ = 4.56 µN/m² | cannonball, cylindrical shadow ν ∈ {0, 1} |
| Thrust | (T/m) û_RTN, ṁ = −T/(I_sp g₀) | constant RTN-fixed steering |

The ephemerides reproduce Vallado's printed examples. Sun, Example 5-1: (0.9771945,
0.1924424, 0.0834308) AU. Moon, Example 5-3: (−134240.626, −311571.590, −126693.785) km.
They differ from astropy's GCRS values by the expected precession since J2000 (0.37° in 2026).

**Atmosphere limitation.** The exponential model ignores solar and geomagnetic activity,
which change thermospheric density by up to ~10×. Drag results are indicative, not
predictive. NRLMSISE-00 is the natural upgrade.

## 3. Integration (`numerical.py`)

* SciPy `solve_ivp`, DOP853, rtol 1e-9 (optimisation) or 1e-11 (validation), atol 1 mm and 1 µm/s.
* **Batched states.** N trajectories are integrated as one 7N-dimensional ODE with
  vectorised accelerations. All grid candidates (or Monte Carlo samples) cost about the same
  number of steps as a single trajectory.
* **Discontinuities.** Integration is split at every impulse time and every burn on/off time.
* **Impulsive maneuver.** v⁺ = v⁻ + C_RTN→I Δv_RTN, r⁺ = r⁻, m⁺ = m⁻ exp(−|Δv|/(I_sp g₀)).
* **Finite burn.** Thrust is integrated over [t_m − t_b/2, t_m + t_b/2] with changing mass.
  The test confirms that a finite burn converges to the impulsive result (Δa within 0.1 %,
  identical propellant).

Worked numbers (actual output):

* Tangential 1 m/s at 700 km: first-order Δa = 2a²vΔv/μ = 1886.4 m; numerical 1887.1 m.
* 700 km, 98.19° (SSO): J2 theory gives Ω̇ = 0.98589 °/day (SSO needs 0.98565).
* Numerical (J2–J4) vs SGP4 after 24 h from the same state: 1.96 km. That is the expected
  level of agreement between an analytical and a numerical theory, and neither is "truth".

## 4. Digital twin (`spacecraft.py`, spec §10)

Δv = I_sp g₀ ln(m₀/m_f), m_f = m₀ e^(−Δv/(I_sp g₀)), m_prop = m₀ − m_f,
t_burn = m_prop I_sp g₀ / T.

Example: m₀ = 490 kg, I_sp = 220 s, Δv = 0.1 m/s gives m_prop = 22.711 g and t_b = 12.25 s at 4 N.

The usable propellant excludes a reserve. The largest single burn is
min(operational cap, burn-time limit, usable propellant).

Validation rejects impossible configurations:
* C_D outside 1–4
* C_R outside 1–2
* I_sp above 10,000 s
* a thruster needing more power than is available
* empty altitude or inclination bands

**Labelling.** All spacecraft values are user-configured. Propellant bookkeeping after
"Book fuel" is labelled SIMULATED. The catalogue is never modified.

## 5. Maneuver optimisation (`maneuver.py`, spec §11–12)

### 5.1 Candidates
u = [t_m, Δv_R, Δv_T, Δv_N].

* **Times.** (k + ½) revolutions before the first threat (an along-track burn has the
  largest radial effect half a revolution later), plus evenly spaced times. All lie inside
  [now + lead time, first TCA − margin].
* **Directions.** Each allowed ±R, ±T, ±N.
* **Magnitudes.** Log-spaced from 5× the minimum impulse up to the single-burn limit.
* **Default grid.** 6 × 6 × 8 = 288 candidates, each propagated numerically.

### 5.2 Closest approach
A 20 s grid with in-interval linearised relative motion:
τ* = clamp(−Δr·Δv/|Δv|², 0, h), d = |Δr + Δv τ*|.

The global minimum per threat is taken over the whole horizon. This matters: threats on
equal-period crossing orbits re-encounter every half revolution. The test checks the result
against a 10 ms brute-force search to within 1 m.

### 5.3 Hard constraints (each violation recorded per candidate)
* |Δv| ≤ Δv_max,single; |Δv| ≥ minimum impulse
* m_prop ≤ usable propellant; t_burn ≤ t_burn,max
* burn direction among the allowed directions
* t_m inside the maneuver window
* h_min ≤ h(t) ≤ h_max over the whole horizon
* i_min ≤ i⁺ ≤ i_max; e⁺ ≤ e_max (post-burn osculating elements)
* SSO preservation: |Ω̇_J2(a⁺, e⁺, i⁺) − Ω̇_J2(a⁻, e⁻, i⁻)| ≤ tolerance
* for every threat k: miss_k ≥ d_min **and** Pc_k ≤ Pc_limit

### 5.4 Objective (feasible candidates)
J = w₁R + w₂F + w₃M + w₄U, with default weights (0.5, 0.25, 0.15, 0.10).

* R = max_k clip((log₁₀Pc_k − log₁₀Pc_target)/(log₁₀Pc_limit − log₁₀Pc_target), 0, 1).
  There is no extra credit below the target (default 1e-7), so fuel decides once risk is low.
  Without this, a log-risk term keeps buying ever-smaller Pc with ever-larger burns. This was
  observed in the first implementation: 131 mm/s instead of ~70.
* F = |Δv| / Δv_max,single.
* M = (|Δa|/Δa_tol + |Δi|/Δi_tol + |Δe|/Δe_tol)/3, post-burn vs nominal at the same instant.
* U = Monte Carlo probability that any threat comes within d_min.

Pc uses the 2-D short-encounter model (Phase 4) with **assumed** RTN covariances for the
satellite and each threat.

### 5.5 Search
1. **Grid** (batched).
2. **Pattern search.** Around the 3 best feasible candidates: ±Δt and ±30 % on each RTN
   component, plus a shrink move. Steps halve each round, for 4 rounds.
3. **Robust shortlist.** The cheapest feasible candidates, plus the cheapest candidate at each
   safety-margin tier (worst miss ≥ 1.5, 2, 3, 5, 8, 12, 20, 30, 50 × d_min). Without the tiers
   every shortlisted burn sits at the deterministic limit, which is exactly what uncertainty
   breaks. In the first run all five were fragile (11 % violation).
4. **Monte Carlo** on the shortlist (64 samples each, batched). Sampled errors:
   * initial position and velocity (RTN)
   * execution magnitude (2 %) and pointing (1°)
   * secondary position at TCA, applied in the encounter plane
   The hard robustness limit is P(violation) ≤ 5 %.
5. **Robust fuel trim.** The chosen burn is shrunk step by step (×0.85, ×0.7, ×0.55, ×0.4) while
   it stays feasible and robust. In the worked example this took 220 → 72 mm/s at 0 % violation.
6. **Independent validation.** A different setup:
   * full force model (J2–J4, drag, Sun, Moon, SRP)
   * a **finite** burn of the twin's thrust centred on t_m
   * rtol 1e-11
   All threats and constraints are re-checked, and the whole catalogue is re-screened for
   conjunctions the maneuver creates or worsens.

If no candidate satisfies the hard constraints (or robustness), the result says so and
nothing is selected.

## 6. Orbit transfer laboratory (`transfer.py`, spec §14)

* Hohmann: a_t = (r₁ + r₂)/2, Δv₁ = v_p − v_c1, Δv₂ = v_c2 − v_a, TOF = π√(a_t³/μ).
* Bi-elliptic: three burns through r_b.
* Plane change: Δv = 2v sin(Δi/2).
* Combined plane change: Δv = √(v_a² + v_c² − 2v_a v_c cos Δi). The split between the two
  burns is optimised numerically.

Every transfer is also flown numerically with the same burns. The orbit actually reached is
reported next to the target (e.g. GEO a = 42159.4856 km, e ≈ 1e-11).

Checked against Vallado Example 6-1 (3.935224 km/s, 5.256713 h) and Example 6-2
(bi-elliptic 3.904057 km/s, 593.92 h).

## 7. Research experiments (`experiments.py`, spec §18)

* **Methods.** No maneuver; fixed +T 0.1 m/s half a revolution before the first threat;
  single-threat; multi-threat nominal; proposed (uncertainty-aware).
* **Common scoring.** Every method is scored against all objects: deterministic miss and Pc,
  propellant, mission impact. Robustness comes from an **independent** Monte Carlo (128
  samples, a different seed from the optimiser's).
* **Scenarios.** SYNTHETIC and seeded: 700 km SSO, 3 threats with misses of 30–250 m,
  crossing angles of 30–150°, and optional background objects at 1–6 km.
* **E1–E8.** As in spec §18. E3 is run at the default risk target and in a fuel-first
  setting (target = limit), so both regimes are visible.
* **Outputs.** Results are stored with configuration, seeds and versions, in
  `research/experiments/results/*.json|csv` and in the database (Research Analytics).

## 8. Known limitations

* Assumed covariances: the Pc values are conditional on them.
* Static atmosphere; low-precision ephemerides; no Earth orientation parameters.
* RTN-fixed steering; no attitude dynamics; at most one burn per plan.
* Synthetic threats propagate with conservative forces (J2–J4) so they can be run backwards
  in time.
* Pattern search is local; the grid makes it global enough for single-burn avoidance, but
  this is not a proof of optimality.
