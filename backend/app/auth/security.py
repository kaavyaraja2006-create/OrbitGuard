"""Password hashing, token generation and password policy (standard library only).

scrypt (RFC 7914) from ``hashlib``: memory-hard like Argon2/bcrypt but needs no
compiled third-party package, which matters on machines whose application-
control policy blocks freshly downloaded DLLs.

Stored format:  ``scrypt$<n>$<r>$<p>$<salt b64>$<hash b64>``
Parameters are stored per hash, so they can be raised later and old hashes
upgraded transparently on the next successful login (``needs_rehash``).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets

SCRYPT_N = 2**14  # CPU/memory cost (16 MiB with r=8)
SCRYPT_R = 8
SCRYPT_P = 1
DKLEN = 32
SALT_BYTES = 16
MAXMEM = 64 * 1024 * 1024

MIN_LENGTH = 10
MAX_LENGTH = 128

# Small deny-list of the most common passwords that pass the character rules.
_COMMON = {
    "password1!", "password123", "password123!", "p@ssw0rd123", "qwerty12345", "welcome123!",
    "admin12345", "administrator1", "letmein123!", "iloveyou123", "changeme123", "orbitguard1",
    "orbitguard123", "satellite123",
}


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def _derive(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=DKLEN, maxmem=MAXMEM)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(SALT_BYTES)
    dk = _derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64(salt)}${_b64(dk)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt_b64, hash_b64 = stored.split("$")
        if algo != "scrypt":
            return False
        expected = base64.b64decode(hash_b64)
        dk = _derive(password, base64.b64decode(salt_b64), int(n), int(r), int(p))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk, expected)


def needs_rehash(stored: str) -> bool:
    try:
        _, n, r, p, *_ = stored.split("$")
        return (int(n), int(r), int(p)) != (SCRYPT_N, SCRYPT_R, SCRYPT_P)
    except ValueError:
        return True


# A valid hash of a random password: used to spend the same time on unknown
# e-mail addresses as on known ones (no user enumeration by timing).
DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


def new_token() -> tuple[str, str]:
    """(token for the client, SHA-256 hex stored in the database)."""
    tok = secrets.token_urlsafe(32)
    return tok, token_hash(tok)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def password_problems(password: str, *, email: str | None = None, name: str | None = None) -> list[str]:
    """Return human-readable policy violations (empty list = acceptable)."""
    problems = []
    if len(password) < MIN_LENGTH:
        problems.append(f"at least {MIN_LENGTH} characters")
    if len(password) > MAX_LENGTH:
        problems.append(f"at most {MAX_LENGTH} characters")
    classes = sum(bool(re.search(rx, password)) for rx in (r"[a-z]", r"[A-Z]", r"\d", r"[^A-Za-z0-9]"))
    if classes < 3:
        problems.append("at least three of: lower-case, upper-case, digit, symbol")
    low = password.lower()
    if low in _COMMON:
        problems.append("not a commonly used password")
    if email:
        local = email.split("@")[0].lower()
        if len(local) >= 4 and local in low:
            problems.append("must not contain your e-mail name")
    if name:
        for part in re.split(r"\s+", name.lower()):
            if len(part) >= 4 and part in low:
                problems.append("must not contain your name")
                break
    return problems


EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")


def normalize_email(email: str) -> str:
    return email.strip().lower()


def valid_email(email: str) -> bool:
    return bool(EMAIL_RE.match(email)) and len(email) <= 254
