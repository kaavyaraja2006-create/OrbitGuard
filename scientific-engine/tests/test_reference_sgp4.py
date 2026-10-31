"""Validation against Vallado's published SGP4 verification set.

SGP4-VER.TLE and tcppver.out ship with python-sgp4 and are the reference
outputs from Vallado et al., "Revisiting Spacetrack Report #3" (AIAA 2006-6753).
tcppver.out also lists osculating elements for each state (computed with
WGS-72 mu), which lets us validate our own rv_to_coe independently.
"""

from __future__ import annotations

import math
import os

import numpy as np
import pytest
import sgp4

from orbitguard_engine.constants import MU_WGS72
from orbitguard_engine.elements import rv_to_coe
from orbitguard_engine.propagation import propagate_tsince, satrec_from_tle
from orbitguard_engine.tle import TLEError, parse_tle

DATA_DIR = os.path.dirname(sgp4.__file__)


def _load_tles() -> dict[int, tuple[str, str]]:
    out = {}
    with open(os.path.join(DATA_DIR, "SGP4-VER.TLE")) as fh:
        lines = [ln.rstrip("\n") for ln in fh if not ln.startswith("#")]
    for i in range(len(lines) - 1):
        if lines[i].startswith("1 ") and lines[i + 1].startswith("2 "):
            out[int(lines[i][2:7])] = (lines[i][:69], lines[i + 1][:69])
    return out


def _load_reference():
    """Yield (satnum, tsince_min, r, v, elements-or-None)."""
    rows = []
    sat = None
    with open(os.path.join(DATA_DIR, "tcppver.out")) as fh:
        for ln in fh:
            parts = ln.split()
            if not parts:
                continue
            if len(parts) == 2 and parts[1] == "xx":
                sat = int(parts[0])
                continue
            try:
                nums = [float(p) for p in parts[:7]]
            except ValueError:
                continue
            if len(nums) < 7 or sat is None:
                continue
            elems = None
            if len(parts) >= 14:
                try:
                    elems = [float(p) for p in parts[7:14]]
                except ValueError:
                    elems = None
            rows.append((sat, nums[0], np.array(nums[1:4]), np.array(nums[4:7]), elems))
    return rows


TLES = _load_tles()
REFERENCE = _load_reference()


def test_reference_data_loaded():
    assert len(TLES) >= 30
    assert len(REFERENCE) > 500


# Vallado's set includes three synthetic cases (33333-33335) whose elements
# were hand-edited without updating the checksum. A correct validator must
# flag exactly those and accept the rest.
EDITED_CASES = {33333, 33334, 33335}


def test_checksum_validator_flags_exactly_the_edited_cases():
    flagged = set()
    for n, (l1, l2) in TLES.items():
        try:
            assert parse_tle(l1, l2).norad_id == n
        except TLEError:
            flagged.add(n)
    assert flagged == EDITED_CASES


def test_sgp4_matches_vallado_reference_states():
    max_dr = 0.0
    compared = 0
    for sat, tsince, r_ref, v_ref, _ in REFERENCE:
        if sat not in TLES:
            continue
        tle = parse_tle(*TLES[sat], strict=False)
        sv = propagate_tsince(satrec_from_tle(tle), tsince)
        if not sv.ok:
            continue
        dr = float(np.linalg.norm(sv.r_km - r_ref))
        dv = float(np.linalg.norm(sv.v_kms - v_ref))
        max_dr = max(max_dr, dr)
        assert dr < 1e-4, f"sat {sat} t={tsince}: position differs by {dr} km"
        assert dv < 1e-7, f"sat {sat} t={tsince}: velocity differs by {dv} km/s"
        compared += 1
    assert compared > 500
    print(f"compared {compared} states, max |dr| = {max_dr:.3e} km")


def _angle_diff(a: float, b: float) -> float:
    d = (a - b + 180.0) % 360.0 - 180.0
    return abs(d)


def test_rv_to_coe_matches_vallado_osculating_elements():
    compared = 0
    for sat, tsince, r, v, el in REFERENCE:
        if el is None:
            continue
        a_ref, e_ref, i_ref, node_ref, argp_ref, nu_ref, _m = el
        if e_ref < 1e-4 or i_ref < 0.1:  # angles ill-defined; covered elsewhere
            continue
        coe = rv_to_coe(r, v, mu=MU_WGS72)
        # tcppver prints a to 1e-6 km, e to 1e-6, angles to 1e-5 deg
        assert abs(coe.a_km - a_ref) / a_ref < 1e-6, (sat, tsince, coe.a_km, a_ref)
        assert abs(coe.e - e_ref) < 2e-6
        assert _angle_diff(coe.i_deg, i_ref) < 2e-5
        assert _angle_diff(coe.raan_deg, node_ref) < 2e-5
        assert _angle_diff(coe.argp_deg, argp_ref) < 1e-3
        assert _angle_diff(coe.nu_deg, nu_ref) < 1e-3
        compared += 1
    assert compared > 200
    print(f"validated rv_to_coe on {compared} reference states")
