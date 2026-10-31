# Phase 4 — Conjunction screening and collision probability

Numbers below come from `scientific-engine/examples/phase4_validation.py`
(full output: `research/experiments/phase4_validation_output.txt`) and the test suite.

## 1. Screening pipeline (`conjunction-screening/1.0.0`)

**Step 1 — Apogee/perigee filter** (Hoots, Crawford & Roehrich 1984). A pair is dropped when
r_p(secondary) > r_a(primary) + pad or r_a(secondary) < r_p(primary) − pad, with
pad = threshold + 50 km to absorb TLE error and perturbations over the horizon.

**Step 2 — Time-grid screening with in-interval linearisation.** All candidates are propagated
with vectorised SGP4 (chunks of 256) on a uniform grid of step h. Sampled distances alone miss
fast encounters: at 15 km/s relative speed, objects move 900 km between 60 s samples. So within
each interval the relative motion is linearised:

    τ* = clamp( −(Δr·Δv) / |Δv|², 0, h ),     d_lin = | Δr + Δv τ* |

and an interval is flagged if min(d_lin, d at the next sample) ≤ threshold + 5 km margin. Near
a conjunction the relative acceleration is tiny (both objects feel almost the same gravity), so
the linear model is accurate there.

**Step 3 — Refinement.** Each flagged window is refined by bounded Brent minimisation of the
true SGP4 distance with a tolerance of 1 ms.

Distances and relative speeds are computed in TEME. They are frame-invariant, so the
UT1/polar-motion approximations used for the Earth-fixed display don't affect them.

Outputs per event: TCA, miss distance, relative speed, approach angle, the miss vector in the
primary's RTN frame, and both TEME states at TCA (stored for reproducible Pc computation).

### Validation

| Test | Result |
|---|---|
| Engineered crossing between grid samples (TCA at t = 1234.5 s, 60 s grid) | Found; relative speed matches 2v·sin(Δi/2) within 1% |
| Same with a 300 s grid (≈1800 km relative motion per step) | Still found |
| Refined TCA vs 10 ms brute-force sweep | Within 0.02 s; refined miss ≤ brute-force minimum |
| Shell filter | Drops the GEO object; no false event for a same-plane object half an orbit away |
| Relative trajectory | Range minimum at TCA (±1 s) |
| End-to-end API | Upload → background screening → event within 10 s of the engineered TCA |

Synthetic UI scenario (`examples/synthetic_scenario.py`, SGP4-solved phasing): designed
encounter at epoch + 3 h → found at 15:01:59.9997 UTC (designed 15:02:00), miss 4.157 km,
almost purely radial (4.157 / −0.004 / −0.0002 km RTN), plus a second pass at 21.8 km.

### Benchmark (synthetic random LEO catalog, 24 h horizon, 60 s step, 10 km threshold)

| Catalog size | After shell filter | Pair-intervals evaluated | Events | Runtime |
|---|---|---|---|---|
| 1,000 | 161 | 231,840 | 0 | 0.22 s |
| 5,000 | 709 | 1,020,960 | 1 | 0.71 s |
| 10,000 | 1,515 | 2,181,600 | 1 | 1.83 s |

## 2. Collision probability (`pc-2d-gauss-legendre/1.0.0`)

Short-term encounter model (Foster & Estes 1992; Chan 2008; Alfano 2005):

- rectilinear relative motion during the encounter;
- Gaussian position errors, constant over the encounter, independent between objects;
- combined spherical hard body of radius HBR.

**Encounter plane:** ẑ = v_rel/|v_rel|, x̂ along the miss component ⊥ ẑ, ŷ = ẑ × x̂.
Covariances are rotated RTN → inertial with C = Bᵀ C_RTN B (B rows = R̂, T̂, N̂), summed, and
projected: C₂ = P C Pᵀ with P = [x̂; ŷ].

    Pc = ∬_{x²+y² ≤ HBR²} N(x | m, C₂) dA

evaluated in polar coordinates: 48-point Gauss–Legendre in radius, a 96-point periodic
trapezoid in angle (spectrally accurate for periodic integrands).

| Check | Result |
|---|---|
| Zero miss, isotropic: Pc = 1 − exp(−R²/2σ²) | relative error 1e-15 to 6e-14 |
| Offset, correlated covariance vs 4×10⁶-sample Monte Carlo | \|diff\|/SE = 0.24 and 0.42 |
| Small body: Pc → πR²·N(m) | 1e-6 relative |
| Covariance rotation / projection | trace preserved; along-v_rel variance drops out |
| API ellipse vs independent hand projection | identical (1.118 × 4.156 km at 90°) |

### When there is no covariance (all TLE data)

ORBITGUARD does not invent a covariance. It reports the geometry plus the **worst case over
isotropic covariances**: max over σ of Pc(d, σI), which tends to R²/(e·d²) at σ = d/√2.

| d, R | Pc_max | R²/(e d²) | σ* vs d/√2 |
|---|---|---|---|
| 1.0 km, 10 m | 3.678794e-05 | 3.678794e-05 | 0.7071 / 0.7071 |
| 0.2 km, 20 m | 3.678810e-03 | 3.678794e-03 | 0.1411 / 0.1414 |

It is labelled as a reference, **not** an upper bound: an elongated covariance aligned with
the miss vector can exceed it.

### Assumed covariance

Users can enter 1σ RTN position uncertainties for both objects. The result is labelled
**ASSUMED COVARIANCE**, stored with its inputs (`collision_assessments` table, audit log), and
comes with a sensitivity sweep of Pc for covariance scale factors 0.1–10×.

## 3. Priority

Without covariance, priority is geometric and explainable: HIGH < 1 km, MEDIUM < 5 km,
LOW otherwise. Each event also carries a **data confidence** from the longest prediction span
(|TCA − element epoch|): adequate ≤ 3 d, reduced ≤ 7 d, low beyond.
