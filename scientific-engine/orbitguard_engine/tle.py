"""Two-Line Element (TLE) parsing with integrity checks.

TLEs are *mean* elements for the SGP4 theory. This module only parses and
validates them; it never treats them as osculating Keplerian elements.
Use :mod:`orbitguard_engine.propagation` to get physical states.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone


class TLEError(ValueError):
    """Raised when a TLE fails structural or checksum validation."""


def tle_checksum(line: str) -> int:
    """Modulo-10 checksum over columns 1-68 (digits count as value, '-' as 1)."""
    total = 0
    for ch in line[:68]:
        if ch.isdigit():
            total += int(ch)
        elif ch == "-":
            total += 1
    return total % 10


def _parse_alpha5(field_: str) -> int:
    """Catalog numbers above 99999 use the 'Alpha-5' scheme (e.g. 'A0001')."""
    field_ = field_.strip()
    if field_ and field_[0].isalpha():
        letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"  # I and O are skipped
        return (letters.index(field_[0].upper()) + 10) * 10000 + int(field_[1:])
    return int(field_)


def _tle_epoch(epoch_field: str) -> datetime:
    yy = int(epoch_field[:2])
    year = 2000 + yy if yy < 57 else 1900 + yy  # NORAD convention
    day_of_year = float(epoch_field[2:])
    return datetime(year, 1, 1, tzinfo=timezone.utc) + timedelta(days=day_of_year - 1.0)


def _implied_decimal(field_: str) -> float:
    """Parse TLE fields like ' 28098-4' meaning 0.28098e-4."""
    s = field_.strip()
    if not s or s in ("00000-0", "00000+0", "-00000-0", "+00000-0"):
        return 0.0
    sign = -1.0 if s[0] == "-" else 1.0
    s = s.lstrip("+-")
    mantissa, exp = s[:-2], s[-2:]
    return sign * float("0." + mantissa) * 10 ** int(exp)


@dataclass(frozen=True)
class TLE:
    name: str | None
    line1: str
    line2: str
    norad_id: int
    classification: str
    intl_designator: str
    epoch: datetime
    inclination_deg: float
    raan_deg: float
    eccentricity: float
    arg_perigee_deg: float
    mean_anomaly_deg: float
    mean_motion_rev_day: float
    bstar: float
    rev_number: int
    warnings: list[str] = field(default_factory=list)

    @property
    def age_days(self) -> float:
        """Age of the element set relative to now (UTC)."""
        return (datetime.now(timezone.utc) - self.epoch).total_seconds() / 86400.0


def parse_tle(line1: str, line2: str, name: str | None = None, *, strict: bool = True) -> TLE:
    """Parse one TLE. With ``strict`` the checksums must match."""
    l1 = line1.rstrip("\r\n")
    l2 = line2.rstrip("\r\n")
    if len(l1) < 69 or len(l2) < 69:
        raise TLEError(f"TLE lines must be at least 69 characters (got {len(l1)}, {len(l2)})")
    if l1[0] != "1" or l2[0] != "2":
        raise TLEError("Line 1 must start with '1' and line 2 with '2'")

    warnings: list[str] = []
    for idx, ln in ((1, l1), (2, l2)):
        expected = tle_checksum(ln)
        actual = ln[68]
        if not actual.isdigit() or int(actual) != expected:
            msg = f"Line {idx} checksum mismatch (expected {expected}, found '{actual}')"
            if strict:
                raise TLEError(msg)
            warnings.append(msg)

    n1 = _parse_alpha5(l1[2:7])
    n2 = _parse_alpha5(l2[2:7])
    if n1 != n2:
        raise TLEError(f"Catalog number differs between lines ({n1} vs {n2})")

    ecc = float("0." + l2[26:33].strip())
    if not 0.0 <= ecc < 1.0:
        raise TLEError(f"Eccentricity out of range: {ecc}")

    try:
        rev = int(l2[63:68].strip() or 0)
    except ValueError:
        rev = 0

    return TLE(
        name=(name.strip() if name else None) or None,
        line1=l1[:69],
        line2=l2[:69],
        norad_id=n1,
        classification=l1[7],
        intl_designator=l1[9:17].strip(),
        epoch=_tle_epoch(l1[18:32]),
        inclination_deg=float(l2[8:16]),
        raan_deg=float(l2[17:25]),
        eccentricity=ecc,
        arg_perigee_deg=float(l2[34:42]),
        mean_anomaly_deg=float(l2[43:51]),
        mean_motion_rev_day=float(l2[52:63]),
        bstar=_implied_decimal(l1[53:61]),
        rev_number=rev,
        warnings=warnings,
    )


@dataclass
class ParseReport:
    tles: list[TLE]
    rejected: list[tuple[int, str]]  # (line number, reason)


def parse_tle_text(text: str, *, strict: bool = True) -> ParseReport:
    """Parse 2-line or 3-line (named) TLE text. Comment lines starting with '#' are ignored.

    Invalid entries are reported, never silently dropped.
    """
    lines = [ln.rstrip() for ln in text.splitlines()]
    out: list[TLE] = []
    rejected: list[tuple[int, str]] = []
    i = 0
    pending_name: str | None = None
    while i < len(lines):
        ln = lines[i]
        if not ln.strip() or ln.lstrip().startswith("#"):
            i += 1
            continue
        if ln.startswith("1 ") and i + 1 < len(lines) and lines[i + 1].startswith("2 "):
            try:
                out.append(parse_tle(ln, lines[i + 1], pending_name, strict=strict))
            except TLEError as exc:
                rejected.append((i + 1, str(exc)))
            pending_name = None
            i += 2
            continue
        if ln.startswith("1 ") or ln.startswith("2 "):
            rejected.append((i + 1, "Orphan TLE line without its pair"))
            pending_name = None
            i += 1
            continue
        # A name line (3LE format); CelesTrak sometimes prefixes '0 '.
        pending_name = ln[2:].strip() if ln.startswith("0 ") else ln.strip()
        i += 1
    return ParseReport(tles=out, rejected=rejected)
