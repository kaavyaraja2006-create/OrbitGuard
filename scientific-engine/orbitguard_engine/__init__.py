"""ORBITGUARD scientific engine.

Independent of the web API: every module can be imported and run on its own.
"""

from .classification import ClassificationConfig, classify_orbit
from .elements import coe_to_rv, derived_parameters, rv_to_coe
from .propagation import mean_elements, propagate, propagate_many, propagate_track, satrec_from_tle
from .tle import TLE, TLEError, parse_tle, parse_tle_text

__version__ = "0.1.0"

__all__ = [
    "TLE",
    "TLEError",
    "parse_tle",
    "parse_tle_text",
    "rv_to_coe",
    "coe_to_rv",
    "derived_parameters",
    "classify_orbit",
    "ClassificationConfig",
    "satrec_from_tle",
    "mean_elements",
    "propagate",
    "propagate_many",
    "propagate_track",
]
