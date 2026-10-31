"""Account administration from the server's command line.

There are no built-in accounts. The first Super Administrator is created here,
by whoever has shell access to the server:

    python -m app.cli create-superadmin --email you@example.org --name "Your Name"

Other commands:
    python -m app.cli create-user --email ... --name ... --role scientist --org "ISRO"
    python -m app.cli reset-password --email ...
    python -m app.cli list-users
    python -m app.cli seed-demo          # one demo organisation with one account per role

Passwords are read with a hidden prompt (or from stdin with --password-stdin).
"""

from __future__ import annotations

import argparse
import getpass
import re
import sys

from sqlalchemy import select

from .auth import roles as R
from .auth.security import hash_password, normalize_email, password_problems, valid_email
from .auth.service import audit, ensure_system_orgs, now, permission_store, revoke_all
from .core.db import Base, SessionLocal, engine
from .models import OrgSatellite, Organization, SatelliteAssignment, SpaceObject, User


def _read_password(args, email: str, name: str) -> str:
    if args.password_stdin:
        pw = sys.stdin.readline().rstrip("\n")
    else:
        pw = getpass.getpass("Password: ")
        if getpass.getpass("Repeat password: ") != pw:
            sys.exit("Passwords don't match")
    problems = password_problems(pw, email=email, name=name)
    if problems:
        sys.exit("Password needs " + "; ".join(problems))
    return pw


def _org(s, name: str, kind: str = "member") -> Organization:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60]
    o = s.scalar(select(Organization).where((Organization.slug == slug) | (Organization.name == name)))
    if o is None:
        o = Organization(name=name, slug=slug, kind=kind)
        s.add(o)
        s.flush()
        print(f"Created organisation '{name}'")
    return o


def _new_user(s, email: str, name: str, role: str, org: Organization, pw: str, title: str | None = None) -> User:
    if s.scalar(select(User).where(User.email == email)):
        sys.exit(f"An account for {email} already exists")
    u = User(email=email, full_name=name, role=role, organization_id=org.id, password_hash=hash_password(pw),
             email_verified=True, job_title=title)
    s.add(u)
    s.flush()
    audit(s, "admin.user_created", f"{R.ROLES[role]['label']} account created for {email} from the command line", user_id=u.id, via="cli")
    return u


def cmd_create_superadmin(args) -> None:
    email = normalize_email(args.email)
    if not valid_email(email):
        sys.exit("Invalid e-mail")
    with SessionLocal() as s:
        org = _org(s, args.org, kind="platform")
        if org.kind != "platform":
            org.kind = "platform"
        pw = _read_password(args, email, args.name)
        _new_user(s, email, args.name, R.SUPER_ADMIN, org, pw, "Platform administrator")
        s.commit()
    print(f"Super Administrator {email} created. Sign in at /login/admin")


def cmd_create_user(args) -> None:
    email = normalize_email(args.email)
    if args.role not in R.ROLES:
        sys.exit(f"role must be one of {list(R.ROLES)}")
    if not valid_email(email):
        sys.exit("Invalid e-mail")
    with SessionLocal() as s:
        ensure_system_orgs(s)
        org = s.scalar(select(Organization).where(Organization.slug == "public")) if args.role == R.PUBLIC else _org(s, args.org or sys.exit("--org is required"))
        pw = _read_password(args, email, args.name)
        _new_user(s, email, args.name, args.role, org, pw, args.title)
        s.commit()
    print(f"{R.ROLES[args.role]['label']} {email} created. Sign in at /login/{R.ROLES[args.role]['portal']}")


def cmd_reset_password(args) -> None:
    email = normalize_email(args.email)
    with SessionLocal() as s:
        u = s.scalar(select(User).where(User.email == email))
        if u is None:
            sys.exit("No such account")
        pw = _read_password(args, email, u.full_name)
        u.password_hash = hash_password(pw)
        u.password_changed_at = now()
        u.failed_logins, u.locked_until, u.must_change_password = 0, None, False
        n = revoke_all(s, u.id, "password-reset")
        audit(s, "auth.password_reset", f"Password for {email} reset from the command line; {n} session(s) revoked", user_id=u.id, via="cli")
        s.commit()
    print("Password updated; existing sessions were signed out.")


def cmd_list_users(args) -> None:
    with SessionLocal() as s:
        for u in s.scalars(select(User).order_by(User.role, User.email)).all():
            org = s.get(Organization, u.organization_id)
            flags = ",".join(f for f, on in (("inactive", not u.is_active), ("unverified", not u.email_verified), ("must-change", u.must_change_password)) if on)
            print(f"{u.id:>4}  {R.ROLES[u.role]['label']:<30} {u.email:<40} {org.name if org else '?':<28} {flags}")


DEMO = [
    (R.ORG_ADMIN, "orgadmin", "Asha Raman", "Organisation administrator"),
    (R.MISSION_MANAGER, "mission", "Daniel Ortiz", "Mission operations manager"),
    (R.SCIENTIST, "science", "Mei Lin", "Research analyst"),
    (R.OPERATOR, "operator", "Karthik Iyer", "Flight dynamics engineer"),
]


def cmd_seed_demo(args) -> None:
    """Creates a clearly-labelled demo organisation with one account per role (password chosen by you)."""
    domain = args.domain
    with SessionLocal() as s:
        ensure_system_orgs(s)
        org = _org(s, "Demo Space Agency (DEMO)")
        print("One password for all demo accounts.")
        pw = _read_password(args, "", "")
        made = []
        for role, local, name, title in DEMO:
            made.append(_new_user(s, f"{local}@{domain}", name, role, org, pw, title))
        pub = s.scalar(select(Organization).where(Organization.slug == "public"))
        made.append(_new_user(s, f"public@{domain}", "Public Visitor", R.PUBLIC, pub, pw))
        # Give the fleet real catalogue objects if they've been ingested.
        famous = [25544, 20580, 48274, 43013, 39084, 41866]  # ISS, Hubble, Tiangong, NOAA-20, Landsat 8, GOES-16
        present = [n for n in famous if s.get(SpaceObject, n) is not None]
        operator = made[3]
        for n in present:
            s.add(OrgSatellite(organization_id=org.id, norad_id=n))
        s.flush()
        for n in present[:2]:
            s.add(SatelliteAssignment(user_id=operator.id, norad_id=n))
        s.commit()
    print("Demo accounts created:")
    for u in made:
        print(f"  {R.ROLES[u.role]['label']:<30} {u.email:<32} /login/{R.ROLES[u.role]['portal']}")
    print(f"Fleet: {present or 'none yet (ingest CelesTrak data, then add satellites on the Organisation page)'}")


def main(argv: list[str] | None = None) -> None:
    Base.metadata.create_all(engine)
    with SessionLocal() as s:
        permission_store.seed(s)
        ensure_system_orgs(s)
    ap = argparse.ArgumentParser(prog="python -m app.cli", description="ORBITGUARD account administration")
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("create-superadmin", help="Create a Super Administrator")
    a.add_argument("--email", required=True)
    a.add_argument("--name", required=True)
    a.add_argument("--org", default="ORBITGUARD Platform", help="Platform organisation name")
    a.set_defaults(fn=cmd_create_superadmin)

    b = sub.add_parser("create-user", help="Create a user with any role")
    b.add_argument("--email", required=True)
    b.add_argument("--name", required=True)
    b.add_argument("--role", required=True, choices=list(R.ROLES))
    b.add_argument("--org", help="Organisation name (created if missing). Ignored for public users")
    b.add_argument("--title")
    b.set_defaults(fn=cmd_create_user)

    c = sub.add_parser("reset-password", help="Set a new password for an account")
    c.add_argument("--email", required=True)
    c.set_defaults(fn=cmd_reset_password)

    d = sub.add_parser("list-users", help="List accounts")
    d.set_defaults(fn=cmd_list_users)

    e = sub.add_parser("seed-demo", help="Create a demo organisation with one account per role")
    e.add_argument("--domain", default="demo.orbitguard.local")
    e.set_defaults(fn=cmd_seed_demo)

    for p in (a, b, c, e):
        p.add_argument("--password-stdin", action="store_true", help="Read the password from standard input")
    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
