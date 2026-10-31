"""Generate a clearly-labelled SYNTHETIC TLE scenario for offline testing.

Every object is named "SYNTH-..." so it can never be mistaken for real data.
Contents:
  * SYNTH-PRIMARY (630 km) and SYNTH-CROSSER (632 km, different plane). Their
    periods differ, so they reach the shared node together only once, at
    `--tca-hours` after epoch: an engineered conjunction with a miss distance
    of about the 2 km altitude offset (plus SGP4 J2 drift and TLE rounding).
  * N random LEO objects (uniform in altitude 400-1200 km, inclination 0-100 deg).

Usage:
  python examples/synthetic_scenario.py > synthetic.tle
  python examples/synthetic_scenario.py --epoch 2026-10-30T12:00:00Z --tca-hours 3 --n 300
Then upload the file on the Data Sources page (label it "SYNTHETIC ...").
"""

from __future__ import annotations

import argparse
import math
from datetime import datetime, timezone

import numpy as np
from sgp4.exporter import export_tle

from scipy.optimize import minimize

from orbitguard_engine.conjunction import satrec_from_elements
from orbitguard_engine.frames import datetime_to_jd

MU = 398600.8
RE = 6378.135


def tle(sat, satnum: int, name: str) -> str:
    sat.intldesg, sat.classification = "99999A", "U"
    l1, l2 = export_tle(sat)
    return f"{name}\n{l1}\n{l2}\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epoch", default=None, help="UTC ISO time (default: now, rounded to the minute)")
    ap.add_argument("--tca-hours", type=float, default=3.0)
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    epoch = (
        datetime.fromisoformat(args.epoch.replace("Z", "+00:00"))
        if args.epoch
        else datetime.now(timezone.utc).replace(second=0, microsecond=0)
    )
    t = args.tca_hours * 3600.0

    def m_at_node(a_km: float) -> float:
        return (-math.degrees(math.sqrt(MU / a_km**3)) * t) % 360.0

    a1, a2 = RE + 630.0, RE + 632.0
    primary = satrec_from_elements(epoch, a1, 1e-4, 53.0, 40.0, 0.0, m_at_node(a1), satnum=95001)
    jd, fr = datetime_to_jd(epoch)
    _, rp, _ = primary.sgp4(jd, fr + t / 86400.0)

    # Kepler phasing ignores the different J2 node/phase drift of the two planes,
    # so solve for the crosser's RAAN and mean anomaly with SGP4 itself.
    def miss(x):
        sat = satrec_from_elements(epoch, a2, 1e-4, 97.9, x[0], 0.0, x[1], satnum=95002)
        _, rc, _ = sat.sgp4(jd, fr + t / 86400.0)
        return float(np.linalg.norm(np.subtract(rc, rp)))

    best = minimize(miss, x0=[40.0, m_at_node(a2)], method="Nelder-Mead", options={"xatol": 1e-7, "fatol": 1e-6, "maxiter": 4000})
    crosser = satrec_from_elements(epoch, a2, 1e-4, 97.9, best.x[0] % 360, 0.0, best.x[1] % 360, satnum=95002)
    out = [tle(primary, 95001, "SYNTH-PRIMARY"), tle(crosser, 95002, "SYNTH-CROSSER")]
    rng = np.random.default_rng(args.seed)
    for k in range(args.n):
        alt = rng.uniform(400, 1200)
        sat = satrec_from_elements(
            epoch,
            RE + alt,
            rng.uniform(1e-4, 0.01),
            rng.uniform(0, 100),
            rng.uniform(0, 360),
            rng.uniform(0, 360),
            rng.uniform(0, 360),
            satnum=95100 + k,
        )
        out.append(tle(sat, 95100 + k, f"SYNTH-DEB {k:03d}"))
    print("".join(out), end="")


if __name__ == "__main__":
    main()
