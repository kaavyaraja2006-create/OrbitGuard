"""Outgoing e-mail. Every message is recorded in ``email_outbox``.

With ``ORBITGUARD_SMTP_HOST`` set, mail is sent over SMTP (STARTTLS by default).
Without it (development), the message is stored with status ``not-sent`` and
printed to the backend console so links can be followed locally. It is never
returned by an API to the person it was addressed to.
"""

from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage

from sqlalchemy.orm import Session

from ..core.config import settings
from ..models import EmailOutbox

log = logging.getLogger("orbitguard.mail")


def send_mail(s: Session, to: str, subject: str, body: str) -> EmailOutbox:
    row = EmailOutbox(to_email=to, subject=subject, body=body)
    s.add(row)
    if not settings.smtp_host:
        row.status = "not-sent"
        row.error = "SMTP not configured (development mode): message printed to the server console"
        print(f"\n===== ORBITGUARD e-mail (dev, not sent) =====\nTo: {to}\nSubject: {subject}\n\n{body}\n=============================================\n", flush=True)
        return row
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = settings.smtp_from, to, subject
    msg.set_content(body)
    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20) as smtp:
            if settings.smtp_starttls:
                smtp.starttls()
            if settings.smtp_user:
                smtp.login(settings.smtp_user, settings.smtp_password or "")
            smtp.send_message(msg)
        row.status = "sent"
    except Exception as exc:  # network / auth failures are recorded, not hidden
        row.status = "failed"
        row.error = str(exc)[:500]
        log.warning("SMTP send to %s failed: %s", to, exc)
    return row
