"""Authentication, portals, sessions and role-based access control, end to end through the API."""

from __future__ import annotations

import os
import re
import tempfile

if "ORBITGUARD_DATABASE_URL" not in os.environ:
    os.environ["ORBITGUARD_DATABASE_URL"] = f"sqlite:///{tempfile.NamedTemporaryFile(suffix='.db', delete=False).name}"

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app.auth.security import hash_password, password_problems, verify_password  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.core.db import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import EmailOutbox, User, UserSession  # noqa: E402
from authutil import PASSWORD, as_role, ensure_user, login  # noqa: E402

API = "/api/v1"
ISS = (
    "ISS (ZARYA)\n"
    "1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927\n"
    "2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537\n"
)


def C() -> TestClient:
    return TestClient(app)


def admin() -> TestClient:
    return as_role(C(), "super_admin", "root@test.local", "Platform Org")


def _last_mail_token(to: str) -> str:
    with SessionLocal() as s:
        m = s.scalars(select(EmailOutbox).where(EmailOutbox.to_email == to).order_by(EmailOutbox.id.desc())).first()
    return re.search(r"token=([A-Za-z0-9_\-]+)", m.body).group(1)


# ------------------------------------------------------------- primitives
def test_scrypt_hashes_are_salted_and_verify():
    h1, h2 = hash_password("Correct-Horse-9"), hash_password("Correct-Horse-9")
    assert h1 != h2 and h1.startswith("scrypt$16384$8$1$")
    assert verify_password("Correct-Horse-9", h1) and not verify_password("correct-horse-9", h1)
    assert verify_password("x", "garbage") is False


def test_password_policy():
    assert password_problems("short1A!")
    assert password_problems("alllowercaseletters")  # one character class
    assert password_problems("Password123!") == ["not a commonly used password"]  # deny-list
    assert any("e-mail" in p for p in password_problems("Kaavya-2026-xx", email="kaavya@vit.ac.in"))
    assert password_problems("Tr1cky-Satellite") == []


# ---------------------------------------------------- unauthenticated access
def test_every_data_endpoint_requires_sign_in():
    c = C()
    assert c.get(f"{API}/health").status_code == 200  # liveness stays public
    for method, path in [
        ("get", "/objects"), ("get", "/stats"), ("get", "/positions"), ("get", "/objects/25544"),
        ("get", "/conjunctions"), ("get", "/conjunctions/runs"), ("get", "/ingestion/runs"),
        ("get", "/validation/files"), ("get", "/objects/search"), ("get", "/admin/users"),
        ("post", "/orbits/classify"), ("post", "/ingestion/upload"), ("post", "/proximity/screen"),
        ("post", "/proximity/predict"), ("post", "/tracking/compare"), ("get", "/fleet"),
    ]:
        r = getattr(c, method)(API + path, **({"json": {}} if method == "post" else {}))
        assert r.status_code == 401, (path, r.status_code)


# ------------------------------------------------------------------ portals
def test_portal_rejects_other_roles_and_sets_no_cookie():
    ensure_user("sci@test.local", "scientist")
    c = C()
    r = login(c, "sci@test.local", "admin")
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "wrong_portal" and r.json()["detail"]["portal"] == "science"
    assert settings.session_cookie not in c.cookies
    assert c.get(f"{API}/auth/me").status_code == 401
    r = login(c, "sci@test.local", "science")
    assert r.status_code == 200 and r.json()["user"]["role"] == "scientist"
    assert r.json()["user"]["dashboard"] == "/science"
    assert c.get(f"{API}/auth/me").json()["email"] == "sci@test.local"


def test_unknown_portal_and_generic_errors():
    c = C()
    assert login(c, "x@test.local", "root").status_code == 404
    ensure_user("gen@test.local", "operator")
    a = login(c, "nobody@test.local", "operator").json()["detail"]
    b = login(c, "gen@test.local", "operator", "Wrong-Passw0rd!").json()["detail"]
    assert a == b == {"code": "invalid_credentials", "message": "Invalid e-mail or password"}


def test_session_cookie_is_httponly_and_token_stored_hashed():
    ensure_user("cookie@test.local", "operator")
    c = C()
    r = login(c, "cookie@test.local", "operator")
    sc = r.headers["set-cookie"]
    assert "httponly" in sc.lower() and "samesite=lax" in sc.lower()
    token = c.cookies[settings.session_cookie]
    with SessionLocal() as s:
        hashes = s.scalars(select(UserSession.token_hash)).all()
    assert token not in hashes and len(token) >= 40


def test_lockout_after_repeated_failures_and_admin_unlock():
    uid = ensure_user("lock@test.local", "scientist")
    c = C()
    for _ in range(settings.max_failed_logins):
        assert login(c, "lock@test.local", "science", "Wrong-Passw0rd!").status_code == 401
    r = login(c, "lock@test.local", "science")  # correct password, still locked
    assert r.status_code == 423 and r.json()["detail"]["code"] == "locked"
    a = admin()
    assert a.post(f"{API}/admin/users/{uid}/unlock").status_code == 200
    assert login(c, "lock@test.local", "science").status_code == 200


def test_login_rate_limit_per_address():
    from app.auth.service import login_limiter

    c = C()
    login_limiter.reset()
    codes = [c.post(f"{API}/auth/login/public", json={"email": "rl@test.local", "password": "x"}).status_code for _ in range(login_limiter.limit + 2)]
    assert codes[-1] == 429
    login_limiter.reset()


# --------------------------------------------------------------------- RBAC
def test_public_user_is_read_only():
    c = as_role(C(), "public")
    assert c.get(f"{API}/objects").status_code == 200
    assert c.get(f"{API}/stats").status_code == 200
    for method, path, body in [
        ("get", "/conjunctions", None), ("get", "/conjunctions/runs", None), ("get", "/validation/files", None),
        ("post", "/ingestion/upload", {"label": "x", "text": ISS}), ("get", "/ingestion/activity", None),
        ("post", "/proximity/predict", {"norad_ids": [25544]}), ("get", "/admin/users", None), ("get", "/fleet", None),
        ("put", "/admin/roles/public/permissions", {"permissions": []}),
    ]:
        r = getattr(c, method)(API + path, **({"json": body} if body is not None else {}))
        assert r.status_code == 403, (path, r.status_code, r.text)


def test_scientist_and_manager_boundaries():
    sci = as_role(C(), "scientist")
    assert sci.get(f"{API}/validation/files").status_code == 200
    assert sci.post(f"{API}/admin/users", json={"email": "z@test.local", "full_name": "Zed", "role": "public"}).status_code == 403
    assert sci.post(f"{API}/ingestion/upload", json={"label": "x", "text": ISS}).status_code == 403
    mm = as_role(C(), "mission_manager")
    assert mm.post(f"{API}/validation/kelvins/import").status_code == 403  # read-only on validation
    assert mm.get(f"{API}/admin/users").status_code == 403
    assert mm.get(f"{API}/fleet").status_code == 200


def test_org_admin_is_confined_to_own_org_and_roles():
    a = admin()
    other = a.post(f"{API}/admin/organizations", json={"name": "Other Agency"}).json()
    a.post(f"{API}/admin/users", json={"email": "otherop@test.local", "full_name": "Other Op", "role": "operator", "organization_id": other["id"], "initial_password": "Kestrel-Passw0rd-1"})
    oa = as_role(C(), "org_admin", "oa@test.local", "Test Agency")
    users = oa.get(f"{API}/admin/users").json()["items"]
    assert users and all(u["organization"]["name"] == "Test Agency" for u in users)
    # cannot create privileged roles or users elsewhere
    assert oa.post(f"{API}/admin/users", json={"email": "sa2@test.local", "full_name": "Sneaky", "role": "super_admin"}).status_code == 403
    assert oa.post(f"{API}/admin/users", json={"email": "o2@test.local", "full_name": "Elsewhere", "role": "operator", "organization_id": other["id"]}).status_code == 403
    other_id = next(u["id"] for u in a.get(f"{API}/admin/users", params={"q": "otherop"}).json()["items"])
    assert oa.patch(f"{API}/admin/users/{other_id}", json={"is_active": False}).status_code == 404
    assert oa.put(f"{API}/admin/roles/operator/permissions", json={"permissions": []}).status_code == 403
    r = oa.post(f"{API}/admin/users", json={"email": "newsci@test.local", "full_name": "New Scientist", "role": "scientist"})
    assert r.status_code == 201 and r.json()["organization"]["name"] == "Test Agency"


def test_operator_limited_to_assigned_satellites():
    a = admin()
    assert a.post(f"{API}/ingestion/upload", json={"label": "iss-auth-test", "text": ISS, "object_kind": "payload"}).status_code == 200
    op_id = ensure_user("op1@test.local", "operator", "Fleet Org")
    op = C()
    assert login(op, "op1@test.local", "operator").status_code == 200
    body = {"primary_norad_id": 25544, "start": "2008-09-21T00:00:00Z", "horizon_h": 1, "step_s": 60, "threshold_km": 10, "hbr_m": 20}
    r = op.post(f"{API}/conjunctions/screen", json=body)
    assert r.status_code == 403 and "assigned" in r.text
    mm_email = "mm-fleet@test.local"
    mm = as_role(C(), "mission_manager", mm_email, "Fleet Org")
    assert mm.post(f"{API}/fleet/assignments", json={"user_id": op_id, "norad_id": 25544}).status_code == 400  # not in fleet yet
    assert mm.post(f"{API}/fleet/satellites", json={"norad_id": 25544}).status_code == 201
    assert mm.post(f"{API}/fleet/assignments", json={"user_id": op_id, "norad_id": 25544}).status_code == 201
    assert op.post(f"{API}/conjunctions/screen", json=body).status_code == 202
    me = op.get(f"{API}/auth/me").json()
    assert [x["norad_id"] for x in me["assigned_satellites"]] == [25544]
    fleet = op.get(f"{API}/fleet").json()
    assert [x["norad_id"] for x in fleet["satellites"]] == [25544] and fleet["operators"] == []
    runs = op.get(f"{API}/conjunctions/runs").json()
    assert runs and all(r["primary_norad_id"] == 25544 for r in runs)


# ------------------------------------------------------------- registration
def test_public_registration_with_email_verification():
    c = C()
    from app.auth.service import mail_limiter

    mail_limiter.reset()
    r = c.post(f"{API}/auth/register", json={"email": "Visitor@Example.org", "full_name": "Ada Visitor", "password": "Orbit-Watcher-77"})
    assert r.status_code == 202
    assert login(c, "visitor@example.org", "public", "Orbit-Watcher-77").json()["detail"]["code"] == "email_not_verified"
    dup = c.post(f"{API}/auth/register", json={"email": "visitor@example.org", "full_name": "Ada Visitor", "password": "Orbit-Watcher-77"})
    assert dup.status_code == 202 and dup.json()["message"] == r.json()["message"]  # no account enumeration
    with SessionLocal() as s:
        u = s.scalar(select(User).where(User.email == "visitor@example.org"))
        assert u.role == "public" and u.organization.kind == "public"
        msgs = s.scalars(select(EmailOutbox).where(EmailOutbox.to_email == "visitor@example.org").order_by(EmailOutbox.id)).all()
    tok = re.search(r"token=([A-Za-z0-9_\-]+)", msgs[0].body).group(1)
    assert c.post(f"{API}/auth/verify-email", json={"token": tok}).status_code == 200
    assert c.post(f"{API}/auth/verify-email", json={"token": tok}).status_code == 400  # single use
    assert login(c, "visitor@example.org", "public", "Orbit-Watcher-77").status_code == 200
    weak = c.post(f"{API}/auth/register", json={"email": "w@example.org", "full_name": "Weak", "password": "password"})
    assert weak.status_code == 422 and weak.json()["detail"]["code"] == "weak_password"


# --------------------------------------------------------- password lifecycle
def test_forgot_and_reset_password_revokes_sessions():
    ensure_user("reset@test.local", "scientist")
    old = C()
    assert login(old, "reset@test.local", "science").status_code == 200
    c = C()
    r1 = c.post(f"{API}/auth/forgot-password", json={"email": "reset@test.local"})
    r2 = c.post(f"{API}/auth/forgot-password", json={"email": "nobody-here@test.local"})
    assert r1.status_code == r2.status_code == 202 and r1.json() == r2.json()
    tok = _last_mail_token("reset@test.local")
    info = c.get(f"{API}/auth/token-info", params={"token": tok}).json()
    assert info["valid"] and info["purpose"] == "reset" and info["portal"] == "science" and "@" in info["email_hint"]
    assert c.post(f"{API}/auth/reset-password", json={"token": tok, "new_password": "weak"}).status_code == 422
    assert c.post(f"{API}/auth/reset-password", json={"token": tok, "new_password": "Brand-New-Pass-9"}).status_code == 200
    assert c.post(f"{API}/auth/reset-password", json={"token": tok, "new_password": "Another-New-Pass-9"}).status_code == 400
    assert old.get(f"{API}/auth/me").status_code == 401  # signed out everywhere
    assert login(c, "reset@test.local", "science").status_code == 401
    assert login(c, "reset@test.local", "science", "Brand-New-Pass-9").status_code == 200


def test_change_password_keeps_current_session_only():
    ensure_user("chg@test.local", "operator")
    a, b = C(), C()
    login(a, "chg@test.local", "operator")
    login(b, "chg@test.local", "operator")
    assert a.post(f"{API}/auth/change-password", json={"current_password": "nope", "new_password": "Changed-Pass-11"}).status_code == 400
    r = a.post(f"{API}/auth/change-password", json={"current_password": PASSWORD, "new_password": "Changed-Pass-11"})
    assert r.status_code == 200 and r.json()["other_sessions_revoked"] >= 1
    assert a.get(f"{API}/auth/me").status_code == 200
    assert b.get(f"{API}/auth/me").status_code == 401


def test_admin_created_user_must_change_initial_password():
    a = admin()
    r = a.post(f"{API}/admin/users", json={"email": "fresh@test.local", "full_name": "Fresh Engineer", "role": "mission_manager",
                                           "organization_id": _org_id("Test Agency"),
                                           "initial_password": "Initial-Pass-12"})
    assert r.status_code == 201, r.text
    c = C()
    assert login(c, "fresh@test.local", "mission", "Initial-Pass-12").status_code == 200
    assert c.get(f"{API}/auth/me").json()["must_change_password"] is True
    assert c.get(f"{API}/objects").status_code == 403  # blocked until changed
    assert c.post(f"{API}/auth/change-password", json={"current_password": "Initial-Pass-12", "new_password": "My-Own-Pass-34"}).status_code == 200
    assert c.get(f"{API}/objects").status_code == 200


def test_invitation_link_sets_password():
    a = admin()
    r = a.post(f"{API}/admin/users", json={"email": "invitee@test.local", "full_name": "Invited Analyst", "role": "scientist", "organization_id": _org_id("Test Agency")})
    assert r.status_code == 201 and r.json()["email_verified"] is False
    tok = _last_mail_token("invitee@test.local")
    c = C()
    assert c.get(f"{API}/auth/token-info", params={"token": tok}).json()["purpose"] == "invite"
    assert c.post(f"{API}/auth/reset-password", json={"token": tok, "new_password": "Signal-Pass-56"}).status_code == 200
    assert login(c, "invitee@test.local", "science", "Signal-Pass-56").status_code == 200


def _org_id(name: str) -> int:
    from authutil import org

    return org(name)


# ----------------------------------------------------------------- sessions
def test_logout_invalidates_token_server_side():
    ensure_user("out@test.local", "scientist")
    c = C()
    login(c, "out@test.local", "science")
    token = c.cookies[settings.session_cookie]
    assert c.post(f"{API}/auth/logout").status_code == 200
    other = C()
    assert other.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_role_change_ends_old_sessions():
    uid = ensure_user("promote@test.local", "operator")
    c = C()
    login(c, "promote@test.local", "operator")
    a = admin()
    assert a.patch(f"{API}/admin/users/{uid}", json={"role": "scientist"}).status_code == 200
    assert c.get(f"{API}/auth/me").status_code == 401
    assert login(c, "promote@test.local", "operator").json()["detail"]["code"] == "wrong_portal"
    assert login(c, "promote@test.local", "science").status_code == 200


def test_deactivated_user_cannot_sign_in():
    uid = ensure_user("gone@test.local", "scientist")
    c = C()
    login(c, "gone@test.local", "science")
    a = admin()
    a.patch(f"{API}/admin/users/{uid}", json={"is_active": False})
    assert c.get(f"{API}/auth/me").status_code == 401
    assert login(c, "gone@test.local", "science").json()["detail"]["code"] == "disabled"


def test_list_and_revoke_own_sessions():
    ensure_user("multi@test.local", "scientist")
    a, b = C(), C()
    login(a, "multi@test.local", "science")
    login(b, "multi@test.local", "science")
    sessions = a.get(f"{API}/auth/sessions").json()
    assert sum(1 for x in sessions if x["current"]) == 1
    other = next(x for x in sessions if not x["current"] and x["active"])
    assert a.delete(f"{API}/auth/sessions/{other['id']}").status_code == 200
    assert b.get(f"{API}/auth/me").status_code == 401


# --------------------------------------------------------- admin guardrails
def test_cross_origin_state_change_is_refused():
    c = admin()
    r = c.post(f"{API}/auth/logout", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert c.get(f"{API}/auth/me").status_code == 200  # still signed in
    assert c.post(f"{API}/auth/sessions/revoke-others", headers={"Origin": "http://localhost:5173"}).status_code == 200


def test_permission_matrix_is_enforced_and_editable_by_super_admin_only():
    a = admin()
    pub = as_role(C(), "public", "pub2@test.local")
    m = {r["role"]: r for r in a.get(f"{API}/admin/roles").json()["roles"]}
    original = m["public"]["permissions"]
    assert a.put(f"{API}/admin/roles/public/permissions", json={"permissions": ["orbits:compute"]}).status_code == 200
    assert pub.get(f"{API}/objects").status_code == 403
    assert a.put(f"{API}/admin/roles/public/permissions", json={"permissions": original}).status_code == 200
    assert pub.get(f"{API}/objects").status_code == 200
    assert a.put(f"{API}/admin/roles/public/permissions", json={"permissions": ["users:manage_all"]}).status_code == 400
    assert a.put(f"{API}/admin/roles/super_admin/permissions", json={"permissions": []}).status_code == 400


def test_last_super_admin_is_protected():
    a = admin()
    me = a.get(f"{API}/auth/me").json()
    assert a.patch(f"{API}/admin/users/{me['id']}", json={"role": "scientist"}).status_code == 400
    assert a.patch(f"{API}/admin/users/{me['id']}", json={"is_active": False}).status_code == 400


def test_security_events_are_recorded():
    a = admin()
    kinds = {e["kind"] for e in a.get(f"{API}/admin/security-events", params={"limit": 500}).json()}
    assert {"auth.login", "auth.login_failed", "auth.portal_mismatch", "auth.locked", "admin.user_created"} <= kinds
    ov = a.get(f"{API}/admin/overview").json()
    assert ov["scope"] == "platform" and ov["users_total"] >= 5


def test_outbox_redacts_tokens_and_is_super_admin_only():
    a = admin()
    a.post(f"{API}/auth/forgot-password", json={"email": "root@test.local"})
    mails = a.get(f"{API}/admin/outbox").json()
    assert mails and all("token=" not in m["body"] or "token=[redacted]" in m["body"] for m in mails)
    oa = as_role(C(), "org_admin", "oa@test.local", "Test Agency")
    assert oa.get(f"{API}/admin/outbox").status_code == 403
