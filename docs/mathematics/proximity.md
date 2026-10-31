# Proximity detection (multi-satellite tracking)

Proximity answers **how close**, never **how likely to collide**. Collision probability needs
covariance and is computed only in Collision Assessment.

## Current proximity at time t

All catalogue objects are propagated with SGP4 to the same instant t (one vectorised call),
so every state is in the same TEME frame at the same time. For the selected satellite P and
an object B:

    r_rel = r_B − r_P                    (km)
    d     = |r_rel|                      (km, invariant under any rotation of the frame)
    v_rel = |v_B − v_P|                  (km/s)
    ṙ     = (r_rel · (v_B − v_P)) / d    (km/s; < 0 closing, > 0 opening)
    r_rel in P's RTN frame (radial, along-track, cross-track)

Objects with an SGP4 error at t are excluded and counted. Altitude is never used as a
proxy: two objects at the same altitude can be 14,000 km apart (tested).

States are cached per (catalogue version, timestamp), so changing the radius or type filter
does not re-propagate.

## Future proximity over [t0, t0 + H]

1. **Shell filter.** Objects whose perigee/apogee shell can't come within R + 50 km of the
   satellite's are dropped (Hoots et al. 1984).
2. **Grid with in-interval linearisation.** States on a uniform grid (default 60 s). Within
   each interval the closest relative distance is found in closed form:
   τ* = clamp(−(Δr·Δv)/|Δv|², 0, h), d = |Δr + Δv τ*|, flagged if d ≤ R + max(5 km, 0.05 R).
3. **Windows.** Consecutive flagged intervals form one proximity window. Its minimum is
   refined with bounded Brent minimisation of the true SGP4 distance (1 ms) around the best
   interval; grid samples are checked too, so the minimum may sit on a window boundary
   (e.g. co-orbital objects drifting apart).
4. **Entry / exit.** Brent root-finding on f(t) = |r_rel(t)| − R (10 µs tolerance, ~0.1 m at
   10 km/s). An object already inside at t0 has no entry; one still inside at t0 + H has no exit.

## Validation (automated tests)

| Test | Result |
|---|---|
| 3D distance vs hand-computed vectors, self/failed rows excluded, sorted | exact |
| Same orbit, Δmean anomaly = 0.05° → chord 2a·sin(0.025°) | within 2 %; along-track RTN component > 99 % |
| Crossing pair: TCA vs engineered meeting time | < 5 s (J2 shifts it slightly) |
| Minimum distance vs 10 ms brute force | < 10 m |
| Distance at reported entry/exit | R ± 1 m (independent SGP4 evaluation) |
| Fly-through duration vs 2√(R² − d²)/v_rel | within 2 % |
| Co-orbital object inside the sphere for the whole horizon | inside_at_start, no entry/exit, duration = H |
| GEO object vs LEO satellite | removed by the shell filter |
| API: current distances equal an independent SGP4 computation | < 1 mm |

## Uncertainty

TLE/SGP4 element sets carry no covariance, so no uncertainty region is drawn and the UI says
"NOT AVAILABLE". Element-set age is shown for every object, because accuracy degrades with it.

## Colours

Selected satellites: cyan/green/blue family, each distinct · their orbits: the same colour ·
nearby objects: orange · objects in a HIGH-priority *screened conjunction* (from Collision
Assessment, not from proximity): red.
