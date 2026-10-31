"""Test helpers: real accounts in the test database and real sign-in through the API."""

from __future__ import annotations

from sqlalchemy import select

from app.auth import roles as R
from app.auth.security import hash_password
from app.auth.service import login_limiter, mail_limiter
from app.core.db import SessionLocal
from app.models import Organization, User

PASSWORD = "Test-Passw0rd-42"
_HASH: str | None = None


def org(name: str, kind: str = "member") -> int:
    with SessionLocal() as s:
        o = s.scalar(select(Organization).where(Organization.name == name))
        if o is None:
            slug = name.lower().replace(" ", "-")
            o = Organization(name=name, slug=slug, kind=kind)
            s.add(o)
            s.commit()
        return o.id


def ensure_user(email: str, role: str, org_name: str = "Test Agency", **kw) -> int:
    global _HASH
    if _HASH is None:
        _HASH = hash_password(PASSWORD)
    org_id = org("Public users", "public") if role == R.PUBLIC else org(org_name, "platform" if role == R.SUPER_ADMIN else "member")
    with SessionLocal() as s:
        u = s.scalar(select(User).where(User.email == email))
        if u is None:
            u = User(email=email, full_name=kw.pop("full_name", "Test User"), role=role, organization_id=org_id,
                     password_hash=kw.pop("password_hash", _HASH), email_verified=kw.pop("email_verified", True), **kw)
            s.add(u)
            s.commit()
        return u.id


def login(client, email: str, portal: str, password: str = PASSWORD):
    login_limiter.reset()
    mail_limiter.reset()
    return client.post(f"/api/v1/auth/login/{portal}", json={"email": email, "password": password})


def as_role(client, role: str, email: str | None = None, org_name: str = "Test Agency"):
    email = email or f"{role}@test.local"
    ensure_user(email, role, org_name)
    r = login(client, email, R.ROLES[role]["portal"])
    assert r.status_code == 200, r.text
    return client
