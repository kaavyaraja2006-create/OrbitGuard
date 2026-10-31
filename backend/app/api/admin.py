"""Administration: organisations, departments, users, role permissions, fleet, security events.

Scope rules (enforced here, not in the UI):
* Super Administrator (``users:manage_all``): everything, every organisation.
* Organization Administrator (``users:manage_org``): users and departments of
  their own organisation only, and only the roles in ``ORG_ASSIGNABLE_ROLES``.
* Fleet (``fleet:manage``): satellites of one's own organisation and their
  assignment to operators of that organisation.
"""

from __future__ import annotations

import re
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import roles as R
from ..auth.deps import Principal, current_principal, require
from ..auth.mailer import send_mail
from ..auth.security import hash_password, normalize_email, password_problems, valid_email
from ..auth.service import audit, issue_token, now, permission_store, revoke_all
from ..core.config import settings
from ..core.db import get_session
from ..models import (
    AuditLog,
    Department,
    EmailOutbox,
    OrgSatellite,
    Organization,
    SatelliteAssignment,
    SpaceObject,
    User,
    UserSession,
)
from ..services.timeutil import as_utc
from .auth import user_dict

router = APIRouter(prefix="/admin", tags=["administration"])
fleet_router = APIRouter(prefix="/fleet", tags=["fleet"])


def _admin(p: Principal = Depends(current_principal)) -> Principal:
    if p.user.must_change_password:
        raise HTTPException(403, "Password change required before using the platform")
    if not (p.can("users:manage_all") or p.can("users:manage_org")):
        raise HTTPException(403, "Administrator access required")
    return p


def _is_super(p: Principal) -> bool:
    return p.can("users:manage_all")


def _check_org_scope(p: Principal, org_id: int) -> None:
    if not _is_super(p) and org_id != p.user.organization_id:
        raise HTTPException(403, "You can only manage your own organisation")


def _org_dict(s: Session, o: Organization) -> dict:
    n_users = s.scalar(select(func.count(User.id)).where(User.organization_id == o.id)) or 0
    n_sats = s.scalar(select(func.count(OrgSatellite.id)).where(OrgSatellite.organization_id == o.id)) or 0
    depts = s.scalars(select(Department).where(Department.organization_id == o.id).order_by(Department.name)).all()
    return {
        "id": o.id, "name": o.name, "slug": o.slug, "kind": o.kind, "country": o.country, "is_active": o.is_active,
        "created_at": as_utc(o.created_at).isoformat(), "users": n_users, "fleet_size": n_sats,
        "departments": [{"id": d.id, "name": d.name} for d in depts],
    }


# ----------------------------------------------------------------- overview
@router.get("/overview")
def overview(p: Principal = Depends(_admin), s: Session = Depends(get_session)):
    uq = select(User.role, func.count(User.id)).group_by(User.role)
    if not _is_super(p):
        uq = uq.where(User.organization_id == p.user.organization_id)
    by_role = {r: 0 for r in R.ROLES}
    by_role.update(dict(s.execute(uq).all()))
    t = now()
    sq = select(func.count(UserSession.id)).join(User, User.id == UserSession.user_id).where(UserSession.revoked_at.is_(None), UserSession.expires_at > t)
    lq = select(func.count(User.id)).where(User.locked_until > t)
    if not _is_super(p):
        sq = sq.where(User.organization_id == p.user.organization_id)
        lq = lq.where(User.organization_id == p.user.organization_id)
    events = _security_events(s, p, limit=500, since_hours=24)
    return {
        "scope": "platform" if _is_super(p) else "organization",
        "organization": _org_dict(s, s.get(Organization, p.user.organization_id)),
        "organizations": s.scalar(select(func.count(Organization.id))) if _is_super(p) else 1,
        "users_by_role": by_role,
        "users_total": sum(by_role.values()),
        "active_sessions": s.scalar(sq) or 0,
        "locked_accounts": s.scalar(lq) or 0,
        "failed_logins_24h": sum(1 for e in events if e["kind"] == "auth.login_failed"),
        "logins_24h": sum(1 for e in events if e["kind"] == "auth.login"),
    }


# ---------------------------------------------------------- roles & permissions
@router.get("/roles")
def roles_matrix(p: Principal = Depends(_admin), s: Session = Depends(get_session)):
    m = permission_store.get(s)
    return {
        "roles": [{"role": k, **v, "permissions": sorted(m.get(k, set()))} for k, v in R.ROLES.items()],
        "permissions": [{"id": k, "description": v, "locked_to_super_admin": k in R.LOCKED_TO_SUPER_ADMIN} for k, v in R.PERMISSIONS.items()],
        "editable": p.can("permissions:manage"),
        "org_assignable_roles": list(R.ORG_ASSIGNABLE_ROLES),
    }


class RolePermissionsUpdate(BaseModel):
    permissions: list[str]


@router.put("/roles/{role}/permissions")
def set_role_permissions(role: str, req: RolePermissionsUpdate, p: Principal = Depends(require("permissions:manage")), s: Session = Depends(get_session)):
    before = permission_store.for_role(s, role) if role in R.ROLES else set()
    try:
        permission_store.set_role(s, role, set(req.permissions))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    after = set(req.permissions)
    audit(s, "admin.permissions", f"Permissions of {R.ROLES[role]['label']} changed", actor=p.user, role=role,
          added=sorted(after - before), removed=sorted(before - after))
    s.commit()
    permission_store.invalidate()
    return {"role": role, "permissions": sorted(permission_store.for_role(s, role))}


# ---------------------------------------------------------------- organisations
@router.get("/organizations")
def list_orgs(p: Principal = Depends(_admin), s: Session = Depends(get_session)):
    q = select(Organization).order_by(Organization.kind, Organization.name)
    if not _is_super(p):
        q = q.where(Organization.id == p.user.organization_id)
    return [_org_dict(s, o) for o in s.scalars(q).all()]


class OrgCreate(BaseModel):
    name: str = Field(min_length=2, max_length=128)
    country: str | None = Field(None, max_length=64)


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60] or "org"


@router.post("/organizations", status_code=201)
def create_org(req: OrgCreate, p: Principal = Depends(require("users:manage_all")), s: Session = Depends(get_session)):
    name = req.name.strip()
    slug = _slug(name)
    if s.scalar(select(Organization).where(or_(Organization.name == name, Organization.slug == slug))):
        raise HTTPException(409, "An organisation with that name already exists")
    o = Organization(name=name, slug=slug, kind="member", country=(req.country or None))
    s.add(o)
    s.flush()
    audit(s, "admin.org_created", f"Organisation '{name}' created", actor=p.user, organization_id=o.id)
    s.commit()
    return _org_dict(s, o)


class OrgUpdate(BaseModel):
    name: str | None = Field(None, min_length=2, max_length=128)
    country: str | None = Field(None, max_length=64)
    is_active: bool | None = None


@router.patch("/organizations/{org_id}")
def update_org(org_id: int, req: OrgUpdate, p: Principal = Depends(require("users:manage_all")), s: Session = Depends(get_session)):
    o = s.get(Organization, org_id)
    if o is None:
        raise HTTPException(404, "Organisation not found")
    if req.is_active is False and o.id == p.user.organization_id:
        raise HTTPException(400, "You can't suspend your own organisation")
    changes = {}
    if req.name is not None and req.name.strip() != o.name:
        o.name = req.name.strip()
        changes["name"] = o.name
    if req.country is not None:
        o.country = req.country or None
        changes["country"] = o.country
    if req.is_active is not None and req.is_active != o.is_active:
        o.is_active = req.is_active
        changes["is_active"] = o.is_active
    audit(s, "admin.org_updated", f"Organisation '{o.name}' updated", actor=p.user, organization_id=o.id, changes=changes)
    s.commit()
    return _org_dict(s, o)


class DeptCreate(BaseModel):
    name: str = Field(min_length=2, max_length=128)


@router.post("/organizations/{org_id}/departments", status_code=201)
def create_dept(org_id: int, req: DeptCreate, p: Principal = Depends(_admin), s: Session = Depends(get_session)):
    _check_org_scope(p, org_id)
    if s.get(Organization, org_id) is None:
        raise HTTPException(404, "Organisation not found")
    name = req.name.strip()
    if s.scalar(select(Department).where(Department.organization_id == org_id, Department.name == name)):
        raise HTTPException(409, "Department already exists")
    d = Department(organization_id=org_id, name=name)
    s.add(d)
    s.flush()
    audit(s, "admin.dept_created", f"Department '{name}' created", actor=p.user, organization_id=org_id)
    s.commit()
    return {"id": d.id, "name": d.name}


@router.delete("/departments/{dept_id}")
def delete_dept(dept_id: int, p: Principal = Depends(_admin), s: Session = Depends(get_session)):
    d = s.get(Department, dept_id)
    if d is None:
        raise HTTPException(404, "Department not found")
    _check_org_scope(p, d.organization_id)
    for u in s.scalars(select(User).where(User.department_id == d.id)).all():
        u.department_id = None
    audit(s, "admin.dept_deleted", f"Department '{d.name}' deleted", actor=p.user, organization_id=d.organization_id)
    s.delete(d)
    s.commit()
    return {"ok": True}


# -------------------------------------------------------------------- users
def _scoped_user(s: Session, p: Principal, user_id: int) -> User:
    u = s.get(User, user_id)
    if u is None:
        raise HTTPException(404, "User not found")
    if not _is_super(p):
        if u.organization_id != p.user.organization_id:
            raise HTTPException(404, "User not found")  # don't reveal other organisations' users
        if u.role not in R.ORG_ASSIGNABLE_ROLES and u.id != p.user.id:
            raise HTTPException(403, "Organization Administrators can't manage this account")
    return u


def _validate_role_org(s: Session, p: Principal, role: str, org_id: int, dept_id: int | None, check_role: bool = True) -> Organization:
    if role not in R.ROLES:
        raise HTTPException(400, f"Unknown role {role}")
    org = s.get(Organization, org_id)
    if org is None:
        raise HTTPException(400, "Organisation not found")
    if not _is_super(p):
        if org_id != p.user.organization_id:
            raise HTTPException(403, "You can only manage your own organisation")
        if check_role and role not in R.ORG_ASSIGNABLE_ROLES:
            raise HTTPException(403, f"Organization Administrators can assign only: {', '.join(R.ROLES[r]['label'] for r in R.ORG_ASSIGNABLE_ROLES)}")
    if (role == R.PUBLIC) != (org.kind == "public"):
        raise HTTPException(400, "Public users belong to the 'Public users' organisation, and only public users do")
    if dept_id is not None:
        d = s.get(Department, dept_id)
        if d is None or d.organization_id != org_id:
            raise HTTPException(400, "Department doesn't belong to that organisation")
    return org


@router.get("/users")
def list_users(
    q: str | None = None,
    role: str | None = None,
    organization_id: int | None = None,
    status: str | None = Query(None, pattern="^(active|inactive|locked|unverified)$"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    p: Principal = Depends(_admin),
    s: Session = Depends(get_session),
):
    stmt = select(User)
    if not _is_super(p):
        stmt = stmt.where(User.organization_id == p.user.organization_id)
    elif organization_id is not None:
        stmt = stmt.where(User.organization_id == organization_id)
    if role:
        stmt = stmt.where(User.role == role)
    if q:
        like = f"%{q.strip().lower()}%"
        stmt = stmt.where(or_(func.lower(User.email).like(like), func.lower(User.full_name).like(like)))
    if status == "active":
        stmt = stmt.where(User.is_active.is_(True))
    elif status == "inactive":
        stmt = stmt.where(User.is_active.is_(False))
    elif status == "locked":
        stmt = stmt.where(User.locked_until > now())
    elif status == "unverified":
        stmt = stmt.where(User.email_verified.is_(False))
    total = s.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = s.scalars(stmt.order_by(User.created_at.desc()).offset(offset).limit(limit)).all()
    active = dict(
        s.execute(
            select(UserSession.user_id, func.count(UserSession.id))
            .where(UserSession.user_id.in_([u.id for u in rows] or [-1]), UserSession.revoked_at.is_(None), UserSession.expires_at > now())
            .group_by(UserSession.user_id)
        ).all()
    )
    items = []
    for u in rows:
        d = user_dict(s, u)
        d["active_sessions"] = active.get(u.id, 0)
        d["manageable"] = _is_super(p) or u.role in R.ORG_ASSIGNABLE_ROLES
        items.append(d)
    return {"total": total, "offset": offset, "limit": limit, "items": items}


class UserCreate(BaseModel):
    email: str = Field(max_length=254)
    full_name: str = Field(min_length=2, max_length=128)
    role: str
    organization_id: int | None = None
    department_id: int | None = None
    job_title: str | None = Field(None, max_length=128)
    # Either give an initial password (the user must change it at first sign-in)
    # or leave it empty to e-mail an invitation link.
    initial_password: str | None = Field(None, max_length=256)


@router.post("/users", status_code=201)
def create_user(req: UserCreate, p: Principal = Depends(_admin), s: Session = Depends(get_session)):
    email = normalize_email(req.email)
    if not valid_email(email):
        raise HTTPException(422, "Enter a valid e-mail address")
    org_id = req.organization_id if req.organization_id is not None else p.user.organization_id
    _validate_role_org(s, p, req.role, org_id, req.department_id)
    if s.scalar(select(User.id).where(User.email == email)):
        raise HTTPException(409, "An account with that e-mail already exists")
    name = req.full_name.strip()
    if req.initial_password:
        problems = password_problems(req.initial_password, email=email, name=name)
        if problems:
            raise HTTPException(422, {"code": "weak_password", "message": "Initial password needs " + "; ".join(problems), "problems": problems})
        pw_hash, must_change = hash_password(req.initial_password), True
    else:
        import secrets

        pw_hash, must_change = hash_password(secrets.token_urlsafe(32)), False  # unusable until the invite is accepted
    u = User(
        email=email, full_name=name, role=req.role, organization_id=org_id, department_id=req.department_id,
        job_title=(req.job_title or None), password_hash=pw_hash, must_change_password=must_change,
        email_verified=bool(req.initial_password), created_by_id=p.user.id,
    )
    s.add(u)
    s.flush()
    info = R.ROLES[req.role]
    if req.initial_password:
        send_mail(
            s, email, "Your ORBITGUARD account",
            f"Hello {name},\n\nAn ORBITGUARD account was created for you as {info['label']} by {p.user.full_name}.\n"
            f"Sign in at {settings.public_url}/login/{info['portal']} with the initial password your administrator gives you. "
            "You'll be asked to choose your own password at first sign-in.",
        )
    else:
        tok = issue_token(s, u, "invite", timedelta(hours=settings.invite_token_hours))
        send_mail(
            s, email, "You're invited to ORBITGUARD",
            f"Hello {name},\n\n{p.user.full_name} invited you to ORBITGUARD as {info['label']}.\n\n"
            f"Choose your password here:\n{settings.public_url}/reset-password?token={tok}\n\n"
            f"The link is valid for {int(settings.invite_token_hours)} hours. Afterwards, sign in at {settings.public_url}/login/{info['portal']}",
        )
    audit(s, "admin.user_created", f"{info['label']} account created for {email}", actor=p.user, user_id=u.id, organization_id=org_id,
          invited=not bool(req.initial_password))
    s.commit()
    return user_dict(s, u)


class UserUpdate(BaseModel):
    full_name: str | None = Field(None, min_length=2, max_length=128)
    job_title: str | None = Field(None, max_length=128)
    role: str | None = None
    organization_id: int | None = None
    department_id: int | None = None
    clear_department: bool = False
    is_active: bool | None = None


@router.patch("/users/{user_id}")
def update_user(user_id: int, req: UserUpdate, p: Principal = Depends(_admin), s: Session = Depends(get_session)):
    u = _scoped_user(s, p, user_id)
    self_edit = u.id == p.user.id
    role = req.role or u.role
    org_id = req.organization_id if req.organization_id is not None else u.organization_id
    dept_id = None if req.clear_department else (req.department_id if req.department_id is not None else u.department_id)
    if dept_id is not None and org_id != u.organization_id and req.department_id is None:
        dept_id = None  # moving organisation drops the old department
    if self_edit and (role != u.role or org_id != u.organization_id or req.is_active is False):
        raise HTTPException(400, "You can't change your own role, organisation or deactivate yourself")
    if role != u.role or org_id != u.organization_id or dept_id != u.department_id:
        _validate_role_org(s, p, role, org_id, dept_id, check_role=role != u.role)
    # never leave the platform without an active Super Administrator
    if u.role == R.SUPER_ADMIN and (role != R.SUPER_ADMIN or req.is_active is False):
        others = s.scalar(select(func.count(User.id)).where(User.role == R.SUPER_ADMIN, User.is_active.is_(True), User.id != u.id)) or 0
        if others == 0:
            raise HTTPException(400, "This is the last active Super Administrator")
    changes: dict = {}
    if req.full_name is not None and req.full_name.strip() != u.full_name:
        u.full_name = changes["full_name"] = req.full_name.strip()
    if req.job_title is not None and (req.job_title or None) != u.job_title:
        u.job_title = changes["job_title"] = req.job_title or None
    revoke_reason = None
    if role != u.role:
        changes["role"] = {"from": u.role, "to": role}
        u.role = role
        revoke_reason = "role-changed"
        # assignments only make sense for operators
        if role != R.OPERATOR:
            s.query(SatelliteAssignment).filter(SatelliteAssignment.user_id == u.id).delete()
    if org_id != u.organization_id:
        changes["organization_id"] = {"from": u.organization_id, "to": org_id}
        u.organization_id = org_id
        revoke_reason = "organization-changed"
        s.query(SatelliteAssignment).filter(SatelliteAssignment.user_id == u.id).delete()
    if dept_id != u.department_id:
        changes["department_id"] = {"from": u.department_id, "to": dept_id}
        u.department_id = dept_id
    if req.is_active is not None and req.is_active != u.is_active:
        u.is_active = changes["is_active"] = req.is_active
        if not req.is_active:
            revoke_reason = "deactivated"
    n = revoke_all(s, u.id, revoke_reason) if revoke_reason else 0
    if changes:
        audit(s, "admin.user_updated", f"Account {u.email} updated" + (f"; {n} session(s) revoked" if n else ""), actor=p.user, user_id=u.id, changes=changes)
    s.commit()
    return user_dict(s, u)


@router.post("/users/{user_id}/unlock")
def unlock_user(user_id: int, p: Principal = Depends(_admin), s: Session = Depends(get_session)):
    u = _scoped_user(s, p, user_id)
    u.locked_until, u.failed_logins = None, 0
    audit(s, "admin.user_unlocked", f"Account {u.email} unlocked", actor=p.user, user_id=u.id)
    s.commit()
    return user_dict(s, u)


@router.post("/users/{user_id}/send-reset", status_code=202)
def admin_send_reset(user_id: int, p: Principal = Depends(_admin), s: Session = Depends(get_session)):
    u = _scoped_user(s, p, user_id)
    purpose = "reset" if u.email_verified else "invite"
    ttl = timedelta(minutes=settings.reset_token_minutes) if purpose == "reset" else timedelta(hours=settings.invite_token_hours)
    tok = issue_token(s, u, purpose, ttl)
    send_mail(
        s, u.email, "ORBITGUARD: set your password",
        f"Hello {u.full_name},\n\nAn administrator ({p.user.full_name}) sent you a link to set your ORBITGUARD password:\n\n"
        f"{settings.public_url}/reset-password?token={tok}\n\nThe link can be used once.",
    )
    audit(s, "admin.reset_sent", f"Password link sent to {u.email}", actor=p.user, user_id=u.id)
    s.commit()
    return {"message": f"A password link was e-mailed to {u.email}"}


@router.post("/users/{user_id}/revoke-sessions")
def admin_revoke_sessions(user_id: int, p: Principal = Depends(_admin), s: Session = Depends(get_session)):
    u = _scoped_user(s, p, user_id)
    n = revoke_all(s, u.id, "revoked-by-admin", except_id=p.session.id if u.id == p.user.id else None)
    audit(s, "admin.sessions_revoked", f"{n} session(s) of {u.email} revoked", actor=p.user, user_id=u.id)
    s.commit()
    return {"revoked": n}


@router.get("/users/{user_id}/sessions")
def admin_user_sessions(user_id: int, p: Principal = Depends(_admin), s: Session = Depends(get_session)):
    u = _scoped_user(s, p, user_id)
    rows = s.scalars(select(UserSession).where(UserSession.user_id == u.id).order_by(UserSession.created_at.desc()).limit(20)).all()
    t = now()
    return [
        {"id": r.id, "portal": r.portal, "created_at": as_utc(r.created_at).isoformat(), "last_seen_at": as_utc(r.last_seen_at).isoformat(),
         "ip": r.ip, "user_agent": r.user_agent, "active": r.revoked_at is None and as_utc(r.expires_at) > t, "revoked_reason": r.revoked_reason}
        for r in rows
    ]


# ----------------------------------------------------------- security events
def _security_events(s: Session, p: Principal, limit: int, since_hours: float | None = None) -> list[dict]:
    q = select(AuditLog).where(or_(AuditLog.kind.like("auth.%"), AuditLog.kind.like("admin.%"))).order_by(AuditLog.at.desc())
    if since_hours:
        q = q.where(AuditLog.at >= now() - timedelta(hours=since_hours))
    rows = s.scalars(q.limit(limit * (1 if _is_super(p) else 5))).all()
    org_users: set[int] | None = None
    if not _is_super(p):
        org_users = set(s.scalars(select(User.id).where(User.organization_id == p.user.organization_id)).all())
    out = []
    for r in rows:
        d = r.details or {}
        if org_users is not None and d.get("user_id") not in org_users and d.get("actor_user_id") not in org_users:
            continue
        out.append({"id": r.id, "at": as_utc(r.at).isoformat(), "kind": r.kind, "message": r.message, "details": d})
        if len(out) >= limit:
            break
    return out


@router.get("/security-events")
def security_events(limit: int = Query(100, ge=1, le=500), p: Principal = Depends(_admin), s: Session = Depends(get_session)):
    return _security_events(s, p, limit)


@router.get("/outbox")
def outbox(limit: int = Query(50, ge=1, le=200), p: Principal = Depends(require("email:read_outbox")), s: Session = Depends(get_session)):
    rows = s.scalars(select(EmailOutbox).order_by(EmailOutbox.created_at.desc()).limit(limit)).all()
    # Links carry single-use secrets meant only for the recipient; an administrator
    # reading the log must not be able to use them to take over an account.
    redact = lambda body: re.sub(r"token=[A-Za-z0-9_\-]+", "token=[redacted]", body)  # noqa: E731
    return [
        {"id": r.id, "to": r.to_email, "subject": r.subject, "body": redact(r.body), "status": r.status, "error": r.error, "created_at": as_utc(r.created_at).isoformat()}
        for r in rows
    ]


# ===================================================================== fleet
def _fleet_org(p: Principal, org_id: int | None) -> int:
    if org_id is None or org_id == p.user.organization_id:
        return p.user.organization_id
    if not p.can("users:manage_all"):
        raise HTTPException(403, "You can only see your own organisation's fleet")
    return org_id


@fleet_router.get("")
def get_fleet(organization_id: int | None = None, p: Principal = Depends(require("fleet:read")), s: Session = Depends(get_session)):
    org_id = _fleet_org(p, organization_id)
    sats = s.scalars(select(OrgSatellite).where(OrgSatellite.organization_id == org_id).order_by(OrgSatellite.norad_id)).all()
    ids = [x.norad_id for x in sats]
    objs = {o.norad_id: o for o in s.scalars(select(SpaceObject).where(SpaceObject.norad_id.in_(ids or [-1]))).all()}
    org_user_ids = select(User.id).where(User.organization_id == org_id)
    assigns = s.execute(
        select(SatelliteAssignment, User).join(User, User.id == SatelliteAssignment.user_id).where(SatelliteAssignment.user_id.in_(org_user_ids))
    ).all()
    by_sat: dict[int, list] = {}
    for a, u in assigns:
        by_sat.setdefault(a.norad_id, []).append({"assignment_id": a.id, "user_id": u.id, "full_name": u.full_name, "email": u.email})
    operators = s.scalars(select(User).where(User.organization_id == org_id, User.role == R.OPERATOR, User.is_active.is_(True)).order_by(User.full_name)).all()
    restrict = p.role == R.OPERATOR  # operators see their own assignments only
    mine = {a.norad_id for a, u in assigns if u.id == p.user.id}
    return {
        "organization_id": org_id,
        "satellites": [
            {
                "norad_id": x.norad_id,
                "name": objs[x.norad_id].name if x.norad_id in objs else None,
                "object_type": objs[x.norad_id].object_type if x.norad_id in objs else "UNKNOWN",
                "in_catalog": x.norad_id in objs,
                "added_at": as_utc(x.added_at).isoformat(),
                "assigned_to": by_sat.get(x.norad_id, []),
            }
            for x in sats
            if not restrict or x.norad_id in mine
        ],
        "operators": [] if restrict else [{"id": u.id, "full_name": u.full_name, "email": u.email} for u in operators],
        "can_manage": p.can("fleet:manage"),
    }


class FleetAdd(BaseModel):
    norad_id: int = Field(gt=0)
    organization_id: int | None = None


@fleet_router.post("/satellites", status_code=201)
def add_fleet_sat(req: FleetAdd, p: Principal = Depends(require("fleet:manage")), s: Session = Depends(get_session)):
    org_id = _fleet_org(p, req.organization_id)
    if s.get(SpaceObject, req.norad_id) is None:
        raise HTTPException(404, f"NORAD {req.norad_id} is not in the catalogue. Ingest it on Data Sources first.")
    if s.scalar(select(OrgSatellite).where(OrgSatellite.organization_id == org_id, OrgSatellite.norad_id == req.norad_id)):
        raise HTTPException(409, "Already in the fleet")
    s.add(OrgSatellite(organization_id=org_id, norad_id=req.norad_id, added_by_id=p.user.id))
    audit(s, "admin.fleet_added", f"NORAD {req.norad_id} added to fleet", actor=p.user, organization_id=org_id, norad_id=req.norad_id)
    s.commit()
    return {"ok": True}


@fleet_router.delete("/satellites/{norad_id}")
def remove_fleet_sat(norad_id: int, organization_id: int | None = None, p: Principal = Depends(require("fleet:manage")), s: Session = Depends(get_session)):
    org_id = _fleet_org(p, organization_id)
    row = s.scalar(select(OrgSatellite).where(OrgSatellite.organization_id == org_id, OrgSatellite.norad_id == norad_id))
    if row is None:
        raise HTTPException(404, "Not in the fleet")
    org_users = select(User.id).where(User.organization_id == org_id)
    s.query(SatelliteAssignment).filter(SatelliteAssignment.norad_id == norad_id, SatelliteAssignment.user_id.in_(org_users)).delete(synchronize_session=False)
    s.delete(row)
    audit(s, "admin.fleet_removed", f"NORAD {norad_id} removed from fleet", actor=p.user, organization_id=org_id, norad_id=norad_id)
    s.commit()
    return {"ok": True}


class AssignRequest(BaseModel):
    user_id: int
    norad_id: int


@fleet_router.post("/assignments", status_code=201)
def assign(req: AssignRequest, p: Principal = Depends(require("fleet:manage")), s: Session = Depends(get_session)):
    u = s.get(User, req.user_id)
    if u is None or (u.organization_id != p.user.organization_id and not p.can("users:manage_all")):
        raise HTTPException(404, "User not found")
    if u.role != R.OPERATOR:
        raise HTTPException(400, "Satellites are assigned to Satellite Operators / Engineers")
    if not s.scalar(select(OrgSatellite).where(OrgSatellite.organization_id == u.organization_id, OrgSatellite.norad_id == req.norad_id)):
        raise HTTPException(400, "Add the satellite to the organisation's fleet first")
    if s.scalar(select(SatelliteAssignment).where(SatelliteAssignment.user_id == u.id, SatelliteAssignment.norad_id == req.norad_id)):
        raise HTTPException(409, "Already assigned")
    a = SatelliteAssignment(user_id=u.id, norad_id=req.norad_id, assigned_by_id=p.user.id)
    s.add(a)
    s.flush()
    audit(s, "admin.assigned", f"NORAD {req.norad_id} assigned to {u.email}", actor=p.user, user_id=u.id, norad_id=req.norad_id)
    s.commit()
    return {"id": a.id}


@fleet_router.delete("/assignments/{assignment_id}")
def unassign(assignment_id: int, p: Principal = Depends(require("fleet:manage")), s: Session = Depends(get_session)):
    a = s.get(SatelliteAssignment, assignment_id)
    u = s.get(User, a.user_id) if a else None
    if a is None or u is None or (u.organization_id != p.user.organization_id and not p.can("users:manage_all")):
        raise HTTPException(404, "Assignment not found")
    audit(s, "admin.unassigned", f"NORAD {a.norad_id} unassigned from {u.email}", actor=p.user, user_id=u.id, norad_id=a.norad_id)
    s.delete(a)
    s.commit()
    return {"ok": True}
