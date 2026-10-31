"""FastAPI dependencies: who is calling, and are they allowed to?

Usage on a route::

    @router.get("/thing")
    def thing(p: Principal = Depends(require("catalog:read"))): ...

Access is decided here, on the server, for every request. The frontend only
hides what the user can't use; it is never the thing that enforces it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..core.config import settings
from ..core.db import get_session
from ..models import User, UserSession
from . import roles as R
from .service import assigned_norad_ids, permission_store, resolve_session


@dataclass
class Principal:
    user: User
    session: UserSession
    permissions: set[str] = field(default_factory=set)

    @property
    def role(self) -> str:
        return self.user.role

    def can(self, perm: str) -> bool:
        return perm in self.permissions


def request_token(request: Request) -> str | None:
    tok = request.cookies.get(settings.session_cookie)
    if tok:
        return tok
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    return None


def optional_principal(request: Request, s: Session = Depends(get_session)) -> Principal | None:
    res = resolve_session(s, request_token(request))
    if res is None:
        return None
    sess, user = res
    return Principal(user=user, session=sess, permissions=permission_store.for_role(s, user.role))


def current_principal(p: Principal | None = Depends(optional_principal)) -> Principal:
    """Authenticated, but a pending forced password change is allowed (used by /auth/*)."""
    if p is None:
        raise HTTPException(401, "Not signed in or session expired", headers={"WWW-Authenticate": "Session"})
    return p


def require(*perms: str):
    unknown = [p for p in perms if p not in R.PERMISSIONS]
    if unknown:
        raise RuntimeError(f"Unknown permission(s) {unknown}")

    def dep(p: Principal = Depends(current_principal)) -> Principal:
        if p.user.must_change_password:
            raise HTTPException(403, "Password change required before using the platform")
        missing = [x for x in perms if not p.can(x)]
        if missing:
            raise HTTPException(403, f"Your role ({R.ROLES[p.role]['label']}) does not have permission: {', '.join(missing)}")
        return p

    dep.__name__ = "require_" + "_".join(x.replace(":", "_") for x in perms)
    return dep


def require_role(*roles: str):
    def dep(p: Principal = Depends(current_principal)) -> Principal:
        if p.user.must_change_password:
            raise HTTPException(403, "Password change required before using the platform")
        if p.role not in roles:
            raise HTTPException(403, "This area belongs to a different role")
        return p

    return dep


def satellite_scope(p: Principal, s: Session) -> set[int] | None:
    """None = may act on any catalogue object; otherwise the allowed NORAD ids."""
    if p.can("conjunction:all_objects"):
        return None
    return assigned_norad_ids(s, p.user)
