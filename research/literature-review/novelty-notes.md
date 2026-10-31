# Novelty notes (literature check, 30 Oct 2026)

Conclusion of the initial literature check: most single "novel" ideas in the
original plan are already published, so the contribution must be a specific gap
with a measurable claim. Verify each item below with a full literature review.

## Already published (do not claim as new)

- Multi-encounter, uncertainty-aware CAM optimisation: Pavanello, Pirovano, Armellin et al.
  (arXiv 2406.03654); Sánchez & Vasile, CASSANDRA (IAC 2021).
- RL / MDP for maneuver decisions: Ferrara et al. (arXiv 2508.05876); several 2025 theses.
- ML-improved TLE propagation and TLE covariance: Curzi et al. 2022 (RNN);
  Verhaeghe et al., SmallSat 2025 (Tiny Time Mixer).
- CDM-sequence risk forecasting: Bayesian LSTM (arXiv 2012.12450), HMM (arXiv 2311.10633),
  TCN-Transformer (arXiv 2609.13191). ESA Kelvins: last-CDM baseline was hard to beat.

## Proposed contribution (candidate)

**Regime-aware conformal uncertainty for public-catalog conjunction screening.**

1. Calibrated error regions with a distribution-free coverage guarantee, conditioned on
   TLE age, altitude band, object type, geomagnetic activity and recent-maneuver flag.
2. Certified screening filters: use the calibrated bounds to prune pair checks with a
   bounded miss rate; report speed-up vs. miss rate.
3. Decision-level evaluation: false-alarm / missed-approach rates vs. fixed-sigma,
   TLE-differencing covariance (Osweiler/Kelso) and a learned regressor.

Data: CelesTrak/Space-Track TLE history, NOAA/GFZ Kp and F10.7, ILRS precise ephemerides
for ground truth on a subset.

No conformal-prediction work on TLE-based screening was found in the initial search —
**this must be confirmed** before claiming it.

## What Phases 5-8 implement for the primary contribution (spec §2)

"Uncertainty-aware multi-threat orbital maneuver optimisation with mission-constraint
preservation" is now implemented end to end (`orbitguard_engine/maneuver.py`):

- multi-threat evaluation over the full horizon (global minimum per object, so repeated
  half-revolution encounters are caught);
- hard mission constraints separated from the soft objective (altitude band, inclination,
  eccentricity, SSO nodal-rate preservation, Δv, propellant, burn time, attitude);
- a robust shortlist with margin tiers, Monte Carlo through the nonlinear dynamics, and a
  robust fuel trim;
- independent validation with a different model (finite burn, full force model) and a
  catalogue re-screen for secondary conjunctions;
- explainability: every rejected candidate keeps its reasons, and the explanation is
  generated only from computed numbers.

**Not claimed as unprecedented.** Robust and chance-constrained collision-avoidance
maneuver design has prior work (e.g. Bombardelli & Hernando-Ayuso 2015; Gonzalo, Colombo
& Di Lizia 2021; Armellin's group on multiple encounters; NASA CARA practice). The
contribution to argue in the report is the *combination*:
- multi-threat + mission-constraint-preserving + uncertainty-aware selection
- independent validation
- explanations traceable to every candidate
- open, reproducible baselines (E1–E8)

A literature table comparing these features must be completed before any novelty claim.
