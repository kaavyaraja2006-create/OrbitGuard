# Authentication, portals and role-based access control

## Roles and portals

| Role | Portal (sign-in URL) | Dashboard | Created by |
|---|---|---|---|
| Super Administrator | `/login/admin` | `/admin` | command line (`python -m app.cli create-superadmin`) or another Super Admin |
| Organization Administrator | `/login/org-admin` | `/org` | Super Admin |
| Mission Operations Manager | `/login/mission` | `/mission` | Super Admin or Org Admin |
| Scientist / Research Analyst | `/login/science` | `/science` | Super Admin or Org Admin |
| Satellite Operator / Engineer | `/login/operator` | `/operator` | Super Admin or Org Admin |
| Public User | `/login/public` | `/public` | self-registration (e-mail verified) |

Each portal posts to its own endpoint, `POST /api/v1/auth/login/{portal}`. The server
checks that the account's role belongs to that portal. A correct password typed into the
wrong portal is refused with `403 wrong_portal` and **no session is created**.

## What is enforced on the server

| Control | Implementation |
|---|---|
| Password storage | scrypt (RFC 7914, N=2^14, r=8, p=1, 16-byte salt) from Python's standard library; parameters stored per hash and upgraded on login |
| Password policy | ≥ 10 characters, 3 of 4 character classes, deny-list, must not contain the e-mail name or the user's name |
| Sessions | 256-bit random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` with `ORBITGUARD_COOKIE_SECURE=1`). Only its SHA-256 is stored. 12 h lifetime (14 days with "keep me signed in"), 120 min idle timeout |
| Revocation | logout, "sign out other sessions", password change/reset, role or organisation change, deactivation, organisation suspension |
| Brute force | account lock after 5 failures for 15 min; 30 sign-in attempts per 10 min per IP; constant-time comparison and a dummy hash for unknown accounts |
| Enumeration | identical responses for unknown e-mail on sign-in, registration and forgot-password |
| CSRF | SameSite cookie, plus state-changing requests with a foreign `Origin` header are refused |
| RBAC | every API route declares a permission (`require("catalog:read")`, …); the role→permission matrix is stored in `role_permissions` and editable by the Super Admin. `users:manage_all`, `permissions:manage`, `email:read_outbox` can never be granted to another role |
| Scoping | Org Admins see and manage only their own organisation and only Mission Manager / Scientist / Operator roles. Operators can screen and view conjunctions only for satellites assigned to them |
| Forced change | accounts created with a temporary password can call nothing but `/auth/*` until they change it |
| Reset / invitation | single-use 256-bit tokens (stored hashed), 30 min (reset) / 72 h (invite); only the newest token is valid; tokens are redacted in the admin e-mail log |
| Audit | sign-ins, failures, lockouts, portal mismatches, account, permission, fleet and assignment changes → `audit_logs` (`auth.*`, `admin.*`) |
| Safety rails | the last active Super Admin can't be demoted or deactivated; nobody can change their own role or deactivate themselves |

The frontend hides what a role can't use and guards routes, but it is never the thing that
decides: changing the URL or calling the API directly produces `401`/`403` from the server.

## Default permission matrix

| Permission | Super | Org Admin | Mission Mgr | Scientist | Operator | Public |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| catalog:read, orbits:compute, proximity:current | ● | ● | ● | ● | ● | ● |
| proximity:predict | ● | ● | ● | ● | ● | |
| data:read | ● | ● | ● | ● | ● | |
| data:ingest, audit:read | ● | ● | ● | | | |
| conjunction:read, conjunction:screen, risk:assess | ● | ● | ● | ● | ● (assigned only) | |
| conjunction:all_objects | ● | ● | ● | ● | | |
| validation:read | ● | | ● | ● | | |
| validation:run | ● | | | ● | | |
| fleet:read | ● | ● | ● | | ● | |
| fleet:manage | ● | ● | ● | | | |
| users:manage_org | ● | ● | | | | |
| users:manage_all, permissions:manage, email:read_outbox | ● | | | | | |

## E-mail

Set `ORBITGUARD_SMTP_HOST`, `ORBITGUARD_SMTP_PORT`, `ORBITGUARD_SMTP_USER`,
`ORBITGUARD_SMTP_PASSWORD`, `ORBITGUARD_SMTP_FROM` to send real mail. Without SMTP
(development) the message is stored with status `not-sent` and printed in the backend
terminal, which is where you copy verification and reset links from.

## Production settings

```
ORBITGUARD_COOKIE_SECURE=1                 # HTTPS only
ORBITGUARD_PUBLIC_URL=https://your.host    # used in e-mailed links
ORBITGUARD_CORS_ORIGINS=https://your.host
ORBITGUARD_REQUIRE_EMAIL_VERIFICATION=1
ORBITGUARD_ALLOW_PUBLIC_REGISTRATION=1     # 0 to close self-registration
```

Known limits: rate limiting is in-process (use the reverse proxy's limiter when running
several workers); no multi-factor authentication yet (TOTP is the natural next step).
