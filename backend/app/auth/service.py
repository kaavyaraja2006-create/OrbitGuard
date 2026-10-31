"""Authentication and authorisation logic (framework-independent parts)."""

from __future__ import annotations

import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..core.config import settings
from ..models import AuditLog, AuthToken, Organization, RolePermission, SatelliteAssignment, User, UserSession
from ..services.timeutil import as_utc
from . import roles as R
from .security import new_token, token_hash


def now() -> datetime:
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------ audit
def audit(s: Session, kind: str, message: str, actor: User | None = None, **details) -> None:
    d = {k: v for k, v in details.items() if v is not None}
    if actor is not None:
        d.setdefault("actor_user_id", actor.id)
        d.setdefault("actor_email", actor.email)
        d.setdefault("actor_role", actor.role)
    s.add(AuditLog(kind=kind, message=message, details=d or None))


# ------------------------------------------------------------ permissions
class PermissionStore:
    """Role -> permissions, cached in memory and invalidated on edit."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._map: dict[str, set[str]] | None = None

    def seed(self, s: Session) -> None:
        """First start: default matrix. Upgrades: grant only permissions this database has never seen,
        so an administrator's edits to existing permissions are never overwritten."""
        from ..models import PermissionCatalog

        known = set(s.scalars(select(PermissionCatalog.permission)).all())
        fresh_db = s.scalar(select(RolePermission.id).limit(1)) is None
        if not known and not fresh_db:
            known = set(R.LEGACY_PERMISSIONS_V1)  # database from before the catalogue existed
            for p in sorted(known):
                s.add(PermissionCatalog(permission=p))
        new = set(R.PERMISSIONS) - known
        for role, perms in R.DEFAULT_ROLE_PERMISSIONS.items():
            if role == R.SUPER_ADMIN:
                continue  # implicit: always everything
            for p in sorted(perms & new):
                s.add(RolePermission(role=role, permission=p))
        for p in sorted(new):
            s.add(PermissionCatalog(permission=p))
        s.commit()
        self.invalidate()

    def invalidate(self) -> None:
        with self._lock:
            self._map = None

    def get(self, s: Session) -> dict[str, set[str]]:
        with self._lock:
            if self._map is None:
                m: dict[str, set[str]] = {r: set() for r in R.ROLES}
                for role, perm in s.execute(select(RolePermission.role, RolePermission.permission)).all():
                    if role in m and perm in R.PERMISSIONS and perm not in R.LOCKED_TO_SUPER_ADMIN:
                        m[role].add(perm)
                m[R.SUPER_ADMIN] = set(R.PERMISSIONS)
                self._map = m
            return self._map

    def for_role(self, s: Session, role: str) -> set[str]:
        return set(self.get(s).get(role, set()))

    def set_role(self, s: Session, role: str, perms: set[str]) -> None:
        if role == R.SUPER_ADMIN:
            raise ValueError("The Super Administrator always holds every permission")
        if role not in R.ROLES:
            raise ValueError(f"Unknown role {role}")
        bad = perms - set(R.PERMISSIONS)
        if bad:
            raise ValueError(f"Unknown permissions: {sorted(bad)}")
        locked = perms & R.LOCKED_TO_SUPER_ADMIN
        if locked:
            raise ValueError(f"Reserved for the Super Administrator: {sorted(locked)}")
        s.query(RolePermission).filter(RolePermission.role == role).delete()
        for p in sorted(perms):
            s.add(RolePermission(role=role, permission=p))
        s.flush()
        self.invalidate()


permission_store = PermissionStore()


# ----------------------------------------------------------- rate limiting
class RateLimiter:
    """Sliding-window limiter per key (client IP + action). In-process."""

    def __init__(self, limit: int, window_s: float) -> None:
        self.limit, self.window = limit, window_s
        self._hits: dict[str, deque] = {}
        self._lock = threading.Lock()

    def hit(self, key: str) -> bool:
        t = time.monotonic()
        with self._lock:
            q = self._hits.setdefault(key, deque())
            while q and t - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(t)
            return True

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


login_limiter = RateLimiter(limit=30, window_s=600)
mail_limiter = RateLimiter(limit=10, window_s=600)  # forgot-password / register / resend per IP


# --------------------------------------------------------------- sessions
def create_session(s: Session, user: User, portal: str, remember: bool, ip: str | None, ua: str | None) -> tuple[str, UserSession]:
    token, h = new_token()
    ttl = timedelta(days=settings.session_remember_days) if remember else timedelta(hours=settings.session_hours)
    sess = UserSession(
        user_id=user.id, token_hash=h, portal=portal, expires_at=now() + ttl, ip=(ip or "")[:64] or None, user_agent=(ua or "")[:256] or None
    )
    s.add(sess)
    s.flush()
    return token, sess


def resolve_session(s: Session, token: str | None) -> tuple[UserSession, User] | None:
    if not token:
        return None
    sess = s.scalar(select(UserSession).where(UserSession.token_hash == token_hash(token)))
    if sess is None or sess.revoked_at is not None:
        return None
    t = now()
    if as_utc(sess.expires_at) <= t:
        revoke(s, sess, "expired")
        s.commit()
        return None
    if as_utc(sess.last_seen_at) + timedelta(minutes=settings.session_idle_minutes) <= t:
        revoke(s, sess, "idle-timeout")
        s.commit()
        return None
    user = s.get(User, sess.user_id)
    if user is None or not user.is_active:
        return None
    org = s.get(Organization, user.organization_id)
    if org is None or not org.is_active:
        return None
    # The session must belong to the portal of the user's *current* role. If a
    # Super Admin changes someone's role, their old sessions stop working.
    if R.ROLES.get(user.role, {}).get("portal") != sess.portal:
        revoke(s, sess, "role-changed")
        s.commit()
        return None
    if (t - as_utc(sess.last_seen_at)).total_seconds() > 60:
        sess.last_seen_at = t
        s.commit()
    return sess, user


def revoke(s: Session, sess: UserSession, reason: str) -> None:
    if sess.revoked_at is None:
        sess.revoked_at = now()
        sess.revoked_reason = reason


def revoke_all(s: Session, user_id: int, reason: str, except_id: int | None = None) -> int:
    q = update(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
    if except_id is not None:
        q = q.where(UserSession.id != except_id)
    res = s.execute(q.values(revoked_at=now(), revoked_reason=reason))
    return res.rowcount or 0


# ------------------------------------------------------------ one-time tokens
def issue_token(s: Session, user: User, purpose: str, ttl: timedelta) -> str:
    # Only the newest token of a purpose is valid.
    s.execute(
        update(AuthToken)
        .where(AuthToken.user_id == user.id, AuthToken.purpose == purpose, AuthToken.used_at.is_(None))
        .values(used_at=now())
    )
    tok, h = new_token()
    s.add(AuthToken(user_id=user.id, purpose=purpose, token_hash=h, expires_at=now() + ttl))
    s.flush()
    return tok


def consume_token(s: Session, token: str, purposes: tuple[str, ...]) -> AuthToken | None:
    row = s.scalar(select(AuthToken).where(AuthToken.token_hash == token_hash(token)))
    if row is None or row.purpose not in purposes or row.used_at is not None or as_utc(row.expires_at) <= now():
        return None
    row.used_at = now()
    return row


# ------------------------------------------------------------ satellite scope
def assigned_norad_ids(s: Session, user: User) -> set[int]:
    return set(s.scalars(select(SatelliteAssignment.norad_id).where(SatelliteAssignment.user_id == user.id)).all())


def ensure_system_orgs(s: Session) -> None:
    """The public organisation self-registered users belong to."""
    if s.scalar(select(Organization).where(Organization.slug == "public")) is None:
        s.add(Organization(name="Public users", slug="public", kind="public"))
        s.commit()
