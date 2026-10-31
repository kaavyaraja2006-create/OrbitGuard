# What the E1–E8 runs show (and what they don't)

Source: `summary.md` and the JSON/CSV files next to it.

**Setup.** Each configuration has 5 seeds, using the fast profile: 12 h horizon, 700 km SSO
simulated satellite, 3 SYNTHETIC threats with designed misses of 30–250 m, and ASSUMED
covariances. "Success" means every object ends with miss ≥ 200 m and Pc ≤ 1e-4, and no other
hard constraint is violated. "Indep. P(viol.)" is a 128-sample Monte Carlo with a seed the
optimiser never saw.

The sample is small (n = 5 per cell), so the differences below are indications, not
statistically established results. Run `python examples/run_experiments.py --seeds 20` before
quoting any of them.

## Findings supported by these runs

1. **Doing nothing is unsafe in every scenario (E1, E4).** No maneuver: 0/5 safe, 3 unsafe
   objects on average, worst miss ~76 m, independent P(violation) 23.8 %. The proposed method:
   5/5 safe, worst miss ~1.7 km, 0.0 %. In E1 seed 0 the independent high-fidelity validation
   (finite burn, full force model) passed.

2. **A fixed textbook burn is not enough (E4).** A fixed +T 0.1 m/s burn half a revolution
   before the first threat made 1/5 scenarios safe and left 1.2 unsafe objects on average. The
   optimiser used more Δv (292 ± 143 mm/s) and was always safe.

3. **Single-threat optimisation leaves other threats unsafe and creates new ones (E2, E7).**
   * The single-threat baseline was safe in 3/5 scenarios.
   * With 4–16 nearby background objects it created 0.4–0.6 new violations per scenario
     (objects that were safe before the burn).
   * Its independent P(violation) rose from 6.6 % to 11.4 % as nearby objects went from 0 to 16.
   * Multi-threat optimisation stayed at 5/5 safe, 0 new violations, ≤ 0.6 %.
   * The cost is runtime: 4.9 s → 8.5 s as nearby objects go from 0 to 16.

4. **Fuel budget sets feasibility sharply (E5).** Safe scenarios by per-burn Δv limit:
   0/5 at 0.02 m/s, 1/5 at 0.05, 2/5 at 0.1, 5/5 from 0.25 m/s. When the budget was too small
   the optimiser reported that no acceptable maneuver exists (nothing selected) instead of
   returning an unsafe one.

5. **Required Δv grows with the assumed uncertainty (E6).** Mean Δv was 76 → 231 → 483 →
   602 mm/s at ×0.5, ×1, ×2 and ×3 the default sigmas, because a fixed Pc target needs a larger
   miss when the covariance is larger. Collision probability is conditional on the covariance:
   with assumed sigmas, the "required" maneuver is only as good as those assumptions.

## Where the proposed uncertainty-aware stage did *not* make a big difference

6. **E3, default risk target (Pc 1e-7).** Nominal multi-threat optimisation was already robust:
   0.2 % independent violation vs 0.0 % for the proposed method, which used +26 % Δv
   (231 → 292 mm/s). A strict risk target already buys large margins.

7. **E3, fuel-first setting (risk target = Pc limit).** The nominal optimiser sat closer to the
   limit: 4.8 % independent violation. The proposed method reduced this to 3.4 % at +72 % Δv
   (84 → 145 mm/s). The improvement is real but modest, and both are under the 5 % limit on
   average. The optimiser's own 48-sample Monte Carlo is coarse (95 % interval ±6 points at
   5 %), which limits how finely it can trade robustness for fuel. More samples, or importance
   sampling, is the obvious next step.

8. **E6 at ×2 and ×3 uncertainty:** both methods chose the same or nearly the same burns. With
   large uncertainty the Pc target dominates, and Monte Carlo has nothing left to fix.

9. **E8, SSO preservation, was never binding.** Results are identical with and without the
   constraint. The selected burns are along-track, and they change the J2 nodal rate by about
   2e-4 °/day, well inside the 5e-3 °/day tolerance. The constraint would bind for cross-track
   burns or a tighter tolerance. That still needs to be shown with a scenario designed for it,
   not assumed.

## What this means for the paper

* **Strong points:** multi-threat evaluation over the full horizon (E2, E7), honest
  infeasibility reporting (E5), and independent validation of every selected maneuver (E1).
* **Weak point:** the uncertainty-aware stage. It helps mostly when the operator sets a
  fuel-first risk target (E3); with a strict target, nominal optimisation is already robust.
  Claims should be framed that way.
* **Before any claim:** run more seeds; add scenarios where the SSO constraint binds; use the
  full 24 h profile; and compare against at least one published robust-avoidance method from
  the literature table.
