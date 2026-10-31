# External validation: ESA Kelvins and CelesTrak SOCRATES

Both datasets are read from the local data folder (`data/raw`, or `ORBITGUARD_DATA_DIR`).
They are never uploaded or redistributed. Each import records the file paths, sizes and
SHA-256 hashes for provenance.

## 1. ESA Kelvins Collision Avoidance dataset → collision probability

**Source:** Uriot, Izzo, Martinez-Heras, Letizia, Siminski, Merz, *Collision Avoidance Challenge
dataset*, ESA, Zenodo, doi:10.5281/zenodo.4463683, CC BY 4.0. Real CDMs received by ESA from
2015 to 2019, 103 features per CDM.

**Files used:** `train_data.zip` (contains `train_data.csv`), `test_data.csv`, and
`test_data_private.csv` (its risk column is called `true_risk`).

**Units (confirmed on the files):** distances and sigmas in metres, velocities in m/s,
correlations as coefficients, `risk` = log₁₀ Pc (floored at −30).

### Reconstruction

- The relative position and velocity are in the **target** RTN frame. Each object's covariance
  is in its **own** RTN frame.
- The chaser covariance is rotated into the target frame. Chaser axes are built from
  R = target radial, v_chaser = (0, √(μ/a_t), 0) + v_rel (near-circular target, e ≈ 0.004 on the
  sample rows).
- Then C = C_t + R_cᵀ C_c R_c, projected onto the encounter plane, and Pc follows from the
  Phase-4 integral.

**Check on two real rows (event 0, mission 19):**

| Row | ESA Mahalanobis | Ours, no rotation | Ours, rotated | Inferred HBR |
|---|---|---|---|---|
| test_data.csv | 52.08 | 457.35 | **51.92** | 3.06 m |
| test_data_private.csv | 361.27 | 470.28 | **359.95** | 3.18 m |

Skipping the frame rotation is wrong by about 9×. With it, the two quantities agree within
0.4 %. Two CDMs of the same event give nearly the same inferred size, and it's metre-scale
as expected for a satellite.

### Method for Pc agreement

ESA's hard-body radius (HBR) isn't in the dataset. For each CDM, ORBITGUARD solves for the
HBR that reproduces ESA's risk (fixed point h ← h·√(Pc_ESA/Pc(h)), with brentq as a fallback).
It then takes the **median per mission** and recomputes Pc for every CDM with that single value.

**Interpretation:** if one HBR per mission reproduces ESA's risk across all of that mission's
CDMs, the covariance reconstruction and Pc model agree with ESA's. The per-mission HBR spread
(IQR/median) and the log₁₀ residual distribution quantify how closely. This is **not** a test
against an independently known HBR. The page and the job summary say so explicitly.

**Reported:** Mahalanobis relative error (median, p95, % within 1 %); |Δ log₁₀ Pc| (median,
p90, % within 0.1 and 0.5 dex), for all CDMs and for high-risk ones (ESA risk ≥ −6); and
inferred HBR per mission (median, IQR).

**Performance:** about 0.4 ms per CDM, so roughly 1–2 minutes for all ~190,000 CDMs plus
database writes.

## 2. CelesTrak SOCRATES → conjunction screening

**Source:** CelesTrak SOCRATES Plus. It screens active payloads against the full public GP
catalog with STK/CAT and SGP4, three runs per day, 7-day window, within 5 km. CSV columns:
`NORAD_CAT_ID_1, OBJECT_NAME_1 [status], DSE_1, NORAD_CAT_ID_2, OBJECT_NAME_2, DSE_2, TCA,
TCA_RANGE (km), TCA_RELATIVE_SPEED (km/s), MAX_PROB, DILUTION (km)`.

**Comparison:** for the N closest events, both objects are looked up in ORBITGUARD's catalog.
ORBITGUARD's TCA is found independently (1 s scan over ±300 s around the SOCRATES TCA, then
Brent to 1 ms). The element-set epochs are compared with SOCRATES' implied epochs (TCA − DSE).
Matches within 60 s are reported as **same element sets**; DSE is printed to 3 decimals, which
is about ±43 s.

- **Same element sets:** differences measure the algorithms (SGP4 implementation, TCA search).
  Expect sub-metre and sub-millisecond agreement.
- **Different element sets:** differences mainly reflect newer or older TLEs, not the algorithm.
  They're reported separately and never mixed into the same-element statistics.
- **Object not in catalog:** ingest the relevant CelesTrak groups (at least "All active
  satellites") on the same day the SOCRATES CSV was downloaded.

`MAX_PROB` (Alfano maximum probability) isn't compared yet. ORBITGUARD's worst-case reference
is restricted to isotropic covariance, which is a different quantity.
