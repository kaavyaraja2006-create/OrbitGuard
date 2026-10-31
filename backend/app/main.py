from __future__ import annotations

from datetime import datetime, timezone

from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

import orbitguard_engine

from .api import admin, auth, conjunctions, ingestion, mission, objects, orbits, proximity, public, validation
from .auth.deps import require
from .auth.service import ensure_system_orgs, permission_store
from .services.mission import seed_propulsion_presets
from .core.config import settings
from .core.db import Base, SessionLocal, engine

UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}


def _origin_allowed(request: Request) -> bool:
    """CSRF defence in depth (cookies are already SameSite=Lax).

    Browsers always send Origin on cross-origin and on same-origin POSTs.
    A state-changing request from a page on another origin is refused.
    Non-browser clients (scripts, tests) send no Origin and carry no ambient cookies.
    """
    origin = request.headers.get("origin")
    if not origin:
        return True
    if origin in settings.cors_origins:
        return True
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    return urlsplit(origin).netloc == host

API_VERSION = "v1"


def create_app() -> FastAPI:
    # Phase 1: create tables directly. Alembic migrations are introduced
    # once the schema stabilises (Phase 3 checklist item).
    Base.metadata.create_all(engine)
    with SessionLocal() as s:
        permission_store.seed(s)
        ensure_system_orgs(s)
        seed_propulsion_presets(s)

    app = FastAPI(
        title="ORBITGUARD API",
        version="0.1.0",
        description="Orbital intelligence and collision-avoidance research platform. "
        "All results are computed; simulated data is always labelled.",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=True,
    )

    @app.middleware("http")
    async def security(request: Request, call_next):
        if request.method in UNSAFE and not _origin_allowed(request):
            return JSONResponse({"detail": "Cross-origin request refused"}, status_code=403)
        resp = await call_next(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "same-origin")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        if request.url.path.startswith("/api/") and "/auth/" in request.url.path:
            resp.headers["Cache-Control"] = "no-store"
        return resp

    prefix = f"/api/{API_VERSION}"
    app.include_router(auth.router, prefix=prefix)
    app.include_router(public.router, prefix=prefix)
    app.include_router(admin.router, prefix=prefix)
    app.include_router(admin.fleet_router, prefix=prefix)
    # proximity first: it owns /objects/search, which must match before /objects/{norad_id}
    app.include_router(proximity.router, prefix=prefix)
    app.include_router(objects.router, prefix=prefix, dependencies=[Depends(require("catalog:read"))])
    app.include_router(orbits.router, prefix=prefix, dependencies=[Depends(require("orbits:compute"))])
    app.include_router(mission.router, prefix=prefix)
    app.include_router(ingestion.router, prefix=prefix)
    app.include_router(conjunctions.router, prefix=prefix)
    app.include_router(validation.router, prefix=prefix)

    @app.get(f"{prefix}/health", tags=["system"])
    def health():
        db_ok = True
        try:
            with engine.connect() as c:
                c.execute(text("SELECT 1"))
        except Exception:
            db_ok = False
        return {
            "status": "ok" if db_ok else "degraded",
            "database": "ok" if db_ok else "unreachable",
            "database_backend": engine.url.get_backend_name(),
            "engine_version": orbitguard_engine.__version__,
            "server_time": datetime.now(timezone.utc).isoformat(),
        }

    return app


app = create_app()
