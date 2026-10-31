"""Authentication endpoints: per-portal login, registration, password lifecycle, sessions.

Each role has its own portal (``/auth/login/{portal}``). The server checks that
the account's role belongs to that portal, so a valid password typed into the
wrong portal does not produce a session.
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import roles as R
from ..auth.deps import Principal, current_principal, optional_principal
from ..auth.mailer import send_mail
from ..auth.security import DUMMY_HASH, hash_password, needs_rehash, normalize_email, password_problems, valid_email, verify_password
from ..auth.service import (
    assigned_norad_ids,
    audit,
    consume_token,
    create_session,
    issue_token,
    login_limiter,
    mail_limiter,
    now,
    permission_store,
    revoke,
    revoke_all,
)
from ..core.config import settings
from ..core.db import get_session
from ..models import AuthToken, Department, Organization, SpaceObject, User, UserSession
from ..services.timeutil import as_utc

router = APIRouter(prefix="/auth", tags=["auth"])

GENERIC_LOGIN_ERROR = "Invalid e-mail or password"


def _err(status: int, code: str, message: str, **extra) -> HTTPException:
    return HTTPException(status, {"code": code, "message": message, **extra})


def client_ip(request: Request) -> str:
    if settings.trust_proxy:
        fwd = request.headers.get("x-forwarded-for", "").split(",")[-1].strip()
        if fwd:
            return fwd[:64]
    return request.client.host if request.client else "unknown"


def user_dict(s: Session, u: User, perms: set[str] | None = None) -> dict:
    org = s.get(Organization, u.organization_id)
    dept = s.get(Department, u.department_id) if u.department_id else None
    info = R.ROLES[u.role]
    out = {
        "id": u.id,
        "email": u.email,
        "full_name": u.full_name,
        "job_title": u.job_title,
        "role": u.role,
        "role_label": info["label"],
        "portal": info["portal"],
        "dashboard": info["dashboard"],
        "organization": {"id": org.id, "name": org.name, "kind": org.kind} if org else None,
        "department": {"id": dept.id, "name": dept.name} if dept else None,
        "is_active": u.is_active,
        "email_verified": u.email_verified,
        "must_change_password": u.must_change_password,
        "locked_until": as_utc(u.locked_until).isoformat() if u.locked_until and as_utc(u.locked_until) > now() else None,
        "last_login_at": as_utc(u.last_login_at).isoformat() if u.last_login_at else None,
        "created_at": as_utc(u.created_at).isoformat(),
    }
    if perms is not None:
        out["permissions"] = sorted(perms)
    return out


def _set_cookie(resp: Response, token: str, remember: bool) -> None:
    resp.set_cookie(
        settings.session_cookie,
        token,
        max_age=int(settings.session_remember_days * 86400) if remember else None,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


def _clear_cookie(resp: Response) -> None:
    resp.delete_cookie(settings.session_cookie, path="/", httponly=True, secure=settings.cookie_secure, samesite="lax")


# ------------------------------------------------------------------ portals
@router.get("/portals")
def portals():
    return [
        {
            "portal": v["portal"],
            "role": k,
            "label": v["label"],
            "summary": v["summary"],
            "self_registration": k == R.PUBLIC and settings.allow_public_registration,
        }
        for k, v in R.ROLES.items()
    ]


# -------------------------------------------------------------------- login
class LoginRequest(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=256)
    remember: bool = False


@router.post("/login/{portal}")
def login(portal: str, req: LoginRequest, request: Request, response: Response, s: Session = Depends(get_session)):
    if portal not in R.PORTALS:
        raise HTTPException(404, "Unknown portal")
    ip = client_ip(request)
    if not login_limiter.hit(f"login:{ip}"):
        raise _err(429, "rate_limited", "Too many sign-in attempts from this address. Wait a few minutes and try again.")
    email = normalize_email(req.email)
    user = s.scalar(select(User).where(User.email == email))
    if user is None:
        verify_password(req.password, DUMMY_HASH)  # equal timing for unknown accounts
        audit(s, "auth.login_failed", f"Failed sign-in for unknown account on {portal} portal", email=email, ip=ip, portal=portal)
        s.commit()
        raise _err(401, "invalid_credentials", GENERIC_LOGIN_ERROR)

    if user.locked_until and as_utc(user.locked_until) > now():
        mins = max(1, int((as_utc(user.locked_until) - now()).total_seconds() // 60) + 1)
        raise _err(423, "locked", f"Too many failed attempts. The account is locked for about {mins} more minute(s), or reset your password.")

    if not verify_password(req.password, user.password_hash):
        user.failed_logins += 1
        msg = GENERIC_LOGIN_ERROR
        if user.failed_logins >= settings.max_failed_logins:
            user.locked_until = now() + timedelta(minutes=settings.lockout_minutes)
            user.failed_logins = 0
            audit(s, "auth.locked", f"Account {email} locked after repeated failures", user_id=user.id, ip=ip)
        audit(s, "auth.login_failed", f"Failed sign-in for {email} on {portal} portal", user_id=user.id, ip=ip, portal=portal)
        s.commit()
        raise _err(401, "invalid_credentials", msg)

    # Password is correct from here on.
    user.failed_logins = 0
    user.locked_until = None
    if not user.is_active:
        s.commit()
        raise _err(403, "disabled", "This account has been deactivated. Contact your administrator.")
    org = s.get(Organization, user.organization_id)
    if org is None or not org.is_active:
        s.commit()
        raise _err(403, "org_disabled", "Your organisation's access is suspended. Contact the platform administrator.")
    expected_role = R.PORTALS[portal]
    if user.role != expected_role:
        right = R.ROLES[user.role]
        audit(s, "auth.portal_mismatch", f"{email} ({right['label']}) tried the {R.ROLES[expected_role]['label']} portal", user_id=user.id, ip=ip, portal=portal)
        s.commit()
        raise _err(
            403,
            "wrong_portal",
            f"This account is not authorised for the {R.ROLES[expected_role]['label']} portal. Use the {right['label']} portal.",
            portal=right["portal"],
        )
    if settings.require_email_verification and not user.email_verified:
        s.commit()
        raise _err(403, "email_not_verified", "Verify your e-mail address first. Check your inbox for the link, or request a new one.")

    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(req.password)
    user.last_login_at = now()
    token, sess = create_session(s, user, portal, req.remember, ip, request.headers.get("user-agent"))
    audit(s, "auth.login", f"{email} signed in ({R.ROLES[user.role]['label']} portal)", user_id=user.id, session_id=sess.id, ip=ip)
    s.commit()
    _set_cookie(response, token, req.remember)
    return {"user": user_dict(s, user, permission_store.for_role(s, user.role)), "session_expires_at": as_utc(sess.expires_at).isoformat()}


@router.post("/logout")
def logout(response: Response, p: Principal | None = Depends(optional_principal), s: Session = Depends(get_session)):
    if p is not None:
        sess = s.get(UserSession, p.session.id)
        revoke(s, sess, "logout")
        audit(s, "auth.logout", f"{p.user.email} signed out", user_id=p.user.id, session_id=sess.id)
        s.commit()
    _clear_cookie(response)
    return {"ok": True}


@router.get("/me")
def me(p: Principal = Depends(current_principal), s: Session = Depends(get_session)):
    out = user_dict(s, p.user, p.permissions)
    out["session"] = {
        "id": p.session.id,
        "portal": p.session.portal,
        "created_at": as_utc(p.session.created_at).isoformat(),
        "expires_at": as_utc(p.session.expires_at).isoformat(),
        "idle_timeout_minutes": settings.session_idle_minutes,
    }
    ids = sorted(assigned_norad_ids(s, p.user))
    names = dict(s.execute(select(SpaceObject.norad_id, SpaceObject.name).where(SpaceObject.norad_id.in_(ids or [-1]))).all())
    out["assigned_satellites"] = [{"norad_id": i, "name": names.get(i), "in_catalog": i in names} for i in ids]
    return out


# ------------------------------------------------------------- registration
class RegisterRequest(BaseModel):
    email: str = Field(max_length=254)
    full_name: str = Field(min_length=2, max_length=128)
    password: str = Field(max_length=256)


GENERIC_REGISTER = "If the address can be registered, a verification e-mail is on its way. Follow the link in it to activate the account."


@router.post("/register", status_code=202)
def register(req: RegisterRequest, request: Request, s: Session = Depends(get_session)):
    """Self-registration exists for the Public portal only. Every other role is created by an administrator."""
    if not settings.allow_public_registration:
        raise HTTPException(403, "Public registration is disabled on this installation")
    if not mail_limiter.hit(f"mail:{client_ip(request)}"):
        raise _err(429, "rate_limited", "Too many requests from this address. Try again later.")
    email = normalize_email(req.email)
    if not valid_email(email):
        raise _err(422, "invalid_email", "Enter a valid e-mail address")
    name = req.full_name.strip()
    problems = password_problems(req.password, email=email, name=name)
    if problems:
        raise _err(422, "weak_password", "Password needs " + "; ".join(problems), problems=problems)
    existing = s.scalar(select(User).where(User.email == email))
    if existing is not None:
        # Same response as a new registration, so the form can't be used to discover accounts.
        send_mail(
            s, email, "ORBITGUARD: registration attempt",
            "Someone tried to register a new ORBITGUARD account with this e-mail address, which already has an account.\n\n"
            f"If that was you, sign in instead, or reset your password at {settings.public_url}/forgot-password\n"
            "If it wasn't you, you can ignore this message.",
        )
        s.commit()
        return {"message": GENERIC_REGISTER}
    org = s.scalar(select(Organization).where(Organization.slug == "public"))
    user = User(
        email=email, full_name=name, password_hash=hash_password(req.password), role=R.PUBLIC,
        organization_id=org.id, email_verified=not settings.require_email_verification,
    )
    s.add(user)
    s.flush()
    if settings.require_email_verification:
        tok = issue_token(s, user, "verify", timedelta(hours=48))
        send_mail(
            s, email, "ORBITGUARD: verify your e-mail address",
            f"Hello {name},\n\nConfirm your e-mail address to activate your ORBITGUARD public account:\n\n"
            f"{settings.public_url}/verify-email?token={tok}\n\nThe link is valid for 48 hours.",
        )
    audit(s, "auth.register", f"Public account registered: {email}", user_id=user.id, ip=client_ip(request))
    s.commit()
    return {"message": GENERIC_REGISTER, "verification_required": settings.require_email_verification}


class TokenRequest(BaseModel):
    token: str = Field(min_length=10, max_length=200)


@router.post("/verify-email")
def verify_email(req: TokenRequest, s: Session = Depends(get_session)):
    row = consume_token(s, req.token, ("verify",))
    if row is None:
        raise _err(400, "invalid_token", "This verification link is invalid, already used, or expired. Request a new one.")
    user = s.get(User, row.user_id)
    user.email_verified = True
    audit(s, "auth.email_verified", f"{user.email} verified their e-mail", user_id=user.id)
    s.commit()
    return {"ok": True, "portal": R.ROLES[user.role]["portal"]}


class EmailRequest(BaseModel):
    email: str = Field(max_length=254)


@router.post("/resend-verification", status_code=202)
def resend_verification(req: EmailRequest, request: Request, s: Session = Depends(get_session)):
    if not mail_limiter.hit(f"mail:{client_ip(request)}"):
        raise _err(429, "rate_limited", "Too many requests from this address. Try again later.")
    user = s.scalar(select(User).where(User.email == normalize_email(req.email)))
    if user is not None and user.is_active and not user.email_verified:
        tok = issue_token(s, user, "verify", timedelta(hours=48))
        send_mail(s, user.email, "ORBITGUARD: verify your e-mail address", f"Confirm your e-mail address:\n\n{settings.public_url}/verify-email?token={tok}\n\nValid for 48 hours.")
        s.commit()
    return {"message": "If that account is waiting for verification, a new link has been sent."}


# --------------------------------------------------------- password lifecycle
GENERIC_FORGOT = "If an account exists for that address, a password-reset link has been sent. It is valid for a limited time."


@router.post("/forgot-password", status_code=202)
def forgot_password(req: EmailRequest, request: Request, s: Session = Depends(get_session)):
    ip = client_ip(request)
    if not mail_limiter.hit(f"mail:{ip}"):
        raise _err(429, "rate_limited", "Too many requests from this address. Try again later.")
    user = s.scalar(select(User).where(User.email == normalize_email(req.email)))
    if user is not None and user.is_active:
        tok = issue_token(s, user, "reset", timedelta(minutes=settings.reset_token_minutes))
        send_mail(
            s, user.email, "ORBITGUARD: reset your password",
            f"Hello {user.full_name},\n\nA password reset was requested for your ORBITGUARD account "
            f"({R.ROLES[user.role]['label']}).\n\nSet a new password here:\n{settings.public_url}/reset-password?token={tok}\n\n"
            f"The link is valid for {int(settings.reset_token_minutes)} minutes and can be used once. "
            "If you didn't request this, ignore this e-mail; your password stays the same.",
        )
        audit(s, "auth.reset_requested", f"Password reset requested for {user.email}", user_id=user.id, ip=ip)
        s.commit()
    return {"message": GENERIC_FORGOT}


@router.get("/token-info")
def token_info(token: str, s: Session = Depends(get_session)):
    """Lets the reset / invitation page check a link before showing the form (does not consume it)."""
    from ..auth.security import token_hash

    row = s.scalar(select(AuthToken).where(AuthToken.token_hash == token_hash(token)))
    if row is None or row.used_at is not None or as_utc(row.expires_at) <= now() or row.purpose not in ("reset", "invite"):
        return {"valid": False}
    user = s.get(User, row.user_id)
    local, _, domain = user.email.partition("@")
    return {
        "valid": True,
        "purpose": row.purpose,
        "email_hint": f"{local[:2]}{'*' * max(1, len(local) - 2)}@{domain}",
        "portal": R.ROLES[user.role]["portal"],
        "role_label": R.ROLES[user.role]["label"],
        "expires_at": as_utc(row.expires_at).isoformat(),
    }


class ResetRequest(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    new_password: str = Field(max_length=256)


@router.post("/reset-password")
def reset_password(req: ResetRequest, request: Request, s: Session = Depends(get_session)):
    from ..auth.security import token_hash

    row = s.scalar(select(AuthToken).where(AuthToken.token_hash == token_hash(req.token)))
    if row is None or row.purpose not in ("reset", "invite") or row.used_at is not None or as_utc(row.expires_at) <= now():
        raise _err(400, "invalid_token", "This link is invalid, already used, or expired. Request a new one.")
    user = s.get(User, row.user_id)
    problems = password_problems(req.new_password, email=user.email, name=user.full_name)
    if problems:
        raise _err(422, "weak_password", "Password needs " + "; ".join(problems), problems=problems)
    if verify_password(req.new_password, user.password_hash):
        raise _err(422, "same_password", "Choose a password different from the current one")
    consume_token(s, req.token, ("reset", "invite"))
    user.password_hash = hash_password(req.new_password)
    user.password_changed_at = now()
    user.must_change_password = False
    user.failed_logins = 0
    user.locked_until = None
    if row.purpose == "invite":
        user.email_verified = True  # they received the e-mail
    n = revoke_all(s, user.id, "password-reset")
    audit(s, "auth.password_reset", f"Password {'set from invitation' if row.purpose == 'invite' else 'reset'} for {user.email}; {n} session(s) revoked", user_id=user.id, ip=client_ip(request))
    s.commit()
    return {"ok": True, "portal": R.ROLES[user.role]["portal"]}


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(max_length=256)
    new_password: str = Field(max_length=256)


@router.post("/change-password")
def change_password(req: ChangePasswordRequest, p: Principal = Depends(current_principal), s: Session = Depends(get_session)):
    user = s.get(User, p.user.id)
    if not verify_password(req.current_password, user.password_hash):
        raise _err(400, "wrong_password", "Current password is incorrect")
    problems = password_problems(req.new_password, email=user.email, name=user.full_name)
    if problems:
        raise _err(422, "weak_password", "Password needs " + "; ".join(problems), problems=problems)
    if req.current_password == req.new_password:
        raise _err(422, "same_password", "Choose a password different from the current one")
    user.password_hash = hash_password(req.new_password)
    user.password_changed_at = now()
    user.must_change_password = False
    n = revoke_all(s, user.id, "password-changed", except_id=p.session.id)
    audit(s, "auth.password_changed", f"{user.email} changed their password; {n} other session(s) revoked", user_id=user.id)
    s.commit()
    return {"ok": True, "other_sessions_revoked": n}


# ---------------------------------------------------------------- sessions
@router.get("/sessions")
def my_sessions(p: Principal = Depends(current_principal), s: Session = Depends(get_session)):
    rows = s.scalars(
        select(UserSession).where(UserSession.user_id == p.user.id).order_by(UserSession.created_at.desc()).limit(30)
    ).all()
    t = now()
    return [
        {
            "id": r.id,
            "portal": r.portal,
            "created_at": as_utc(r.created_at).isoformat(),
            "last_seen_at": as_utc(r.last_seen_at).isoformat(),
            "expires_at": as_utc(r.expires_at).isoformat(),
            "ip": r.ip,
            "user_agent": r.user_agent,
            "current": r.id == p.session.id,
            "active": r.revoked_at is None and as_utc(r.expires_at) > t,
            "revoked_reason": r.revoked_reason,
        }
        for r in rows
    ]


@router.delete("/sessions/{session_id}")
def revoke_session(session_id: int, response: Response, p: Principal = Depends(current_principal), s: Session = Depends(get_session)):
    sess = s.get(UserSession, session_id)
    if sess is None or sess.user_id != p.user.id:
        raise HTTPException(404, "Session not found")
    revoke(s, sess, "revoked-by-user")
    audit(s, "auth.session_revoked", f"{p.user.email} revoked session #{session_id}", user_id=p.user.id)
    s.commit()
    if sess.id == p.session.id:
        _clear_cookie(response)
    return {"ok": True}


@router.post("/sessions/revoke-others")
def revoke_others(p: Principal = Depends(current_principal), s: Session = Depends(get_session)):
    n = revoke_all(s, p.user.id, "revoked-by-user", except_id=p.session.id)
    audit(s, "auth.session_revoked", f"{p.user.email} signed out {n} other session(s)", user_id=p.user.id)
    s.commit()
    return {"revoked": n}
