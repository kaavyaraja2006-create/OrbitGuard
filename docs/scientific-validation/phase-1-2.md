# Scientific validation — Phases 1–2

Run with `pytest -q` in `scientific-engine/` and `backend/`. All results below are from actual runs.

## Results

| Check | Reference | Result |
|---|---|---|
| SGP4 position/velocity | Vallado `tcppver.out` (AIAA 2006-6753), 666 states over 29 objects | max \|Δr\| = 1.2e-7 km, all \|Δv\| < 1e-7 km/s |
| `rv_to_coe` osculating elements | Elements printed in `tcppver.out` for each state (WGS-72 μ) | 522 states: a to 1e-6 relative, e to 2e-6, i/Ω to 2e-5°, ω/ν to 1e-3° |
| TLE checksum validator | Vallado `SGP4-VER.TLE` | Flags exactly the 3 hand-edited cases (33333–33335), accepts the other 29 |
| coe ↔ rv round trip | Analytic | p to 1e-10 relative, angles to 1e-7° |
| Energy and angular momentum | ε = −μ/2a, h = √(μp) | 1e-12 relative |
| GMST | 280.46061837° at J2000.0 | 1e-6° |
| TEME → ITRF | Rotation invariants | \|r\| preserved to 1e-14, z unchanged |
| Geodetic round trip | WGS-84 | 1e-9°, 1e-6 km (equator, poles, GEO altitude) |
| SSO inclination at 700 km | Textbook ≈ 98.2° | 98.188°, labelled LEO + POLAR + SSO |
| GEO radius | 42164.17 km | ±0.05 km |
| Class boundaries | Unit tests | LEO ceiling strict, polar band edges, graveyard excluded from GEO |

Backend integration (12 tests): ingestion → database → classification → propagation → API,
duplicate and conflicting-epoch handling, CelesTrak adapter error paths (HTTP 403/500,
non-TLE body, unknown group) and the 2-hour refresh guard, all offline with a mocked transport.

## What is *not* validated yet

- Live CelesTrak download was not exercised from the development sandbox (no network
  access there). The adapter is covered by mocked-transport tests; the first real run
  should be checked on your machine.
- PostgreSQL: schema is portable (SQLAlchemy), but the test suite runs on SQLite.
  Run `docker compose up` once to confirm on Postgres.
- Frame conversion uses the documented UT1≈UTC / no-polar-motion approximation.
