import { lazy, Suspense, useEffect } from "react";
import type { ComponentType } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AppSidebar } from "./components/AppSidebar";
import { TopNavigation } from "./components/TopNavigation";
import { ALL_ITEMS } from "./nav";
import { NotFound, PlannedModule } from "./pages/Misc";
import { PortalHub } from "./pages/auth/PortalHub";
import { PortalLogin } from "./pages/auth/PortalLogin";
import { Register } from "./pages/auth/Register";
import { ForgotPassword } from "./pages/auth/ForgotPassword";
import { ResetPassword } from "./pages/auth/ResetPassword";
import { VerifyEmail } from "./pages/auth/VerifyEmail";
import { ChangePasswordRequired } from "./pages/auth/ChangePasswordRequired";
import { FullScreenLoading, RequireAuth, RequirePerm, RequireRole } from "./components/guards";
import { LoadingState } from "./components/ui";
import { PageTransition } from "./components/fx/PageTransition";
import { UNAUTHORIZED_EVENT } from "./services/api";
import { useAuth } from "./stores/auth";
import { useApp } from "./stores/app";

// Pages load on demand: the 3D views (Cesium, three.js) only download when opened.
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
const Landing = page(() => import("./pages/Landing"), "Landing");
const MissionOverview = page(() => import("./pages/MissionOverview"), "MissionOverview");
const SpaceEnvironment = page(() => import("./pages/SpaceEnvironment"), "SpaceEnvironment");
const OrbitIntelligence = page(() => import("./pages/OrbitIntelligence"), "OrbitIntelligence");
const SatelliteTracking = page(() => import("./pages/CatalogPages"), "SatelliteTracking");
const DebrisMonitoring = page(() => import("./pages/CatalogPages"), "DebrisMonitoring");
const DataSources = page(() => import("./pages/DataSources"), "DataSources");
const ReportsAudit = page(() => import("./pages/Misc"), "ReportsAudit");
const CollisionAssessment = page(() => import("./pages/CollisionAssessment"), "CollisionAssessment");
const ThreatMonitoring = page(() => import("./pages/ThreatMonitoring"), "ThreatMonitoring");
const Validation = page(() => import("./pages/Validation"), "Validation");
const Account = page(() => import("./pages/Account"), "Account");
const DigitalTwin = page(() => import("./pages/DigitalTwin"), "DigitalTwin");
const ManeuverOptimization = page(() => import("./pages/ManeuverOptimization"), "ManeuverOptimization");
const SimulationLab = page(() => import("./pages/SimulationLab"), "SimulationLab");
const ScenarioVisualizer = page(() => import("./pages/ScenarioVisualizer"), "ScenarioVisualizer");
const TransferLab = page(() => import("./pages/TransferLab"), "TransferLab");
const ResearchAnalytics = page(() => import("./pages/ResearchAnalytics"), "ResearchAnalytics");
const SuperAdminDashboard = page(() => import("./pages/dashboards/AdminDashboards"), "SuperAdminDashboard");
const OrgAdminDashboard = page(() => import("./pages/dashboards/AdminDashboards"), "OrgAdminDashboard");
const MissionDashboard = page(() => import("./pages/dashboards/RoleDashboards"), "MissionDashboard");
const OperatorDashboard = page(() => import("./pages/dashboards/RoleDashboards"), "OperatorDashboard");
const PublicDashboard = page(() => import("./pages/dashboards/RoleDashboards"), "PublicDashboard");
const ScienceDashboard = page(() => import("./pages/dashboards/RoleDashboards"), "ScienceDashboard");

const P = ({ perm, children }: { perm: string; children: React.ReactNode }) => <RequirePerm perm={perm}>{children}</RequirePerm>;

const FULL_BLEED = ["/environment", "/simulation", "/scenario"];

function Shell() {
  const loc = useLocation();
  const fullBleed = FULL_BLEED.includes(loc.pathname);
  const closeNav = useApp((s) => s.setMobileNav);
  useEffect(() => closeNav(false), [loc.pathname, closeNav]);
  return (
    <div className="flex h-full">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopNavigation />
        <main className={`min-h-0 flex-1 ${fullBleed ? "overflow-hidden p-3 sm:p-5" : "overflow-y-auto p-4 sm:p-6"}`}>
          <Suspense fallback={<LoadingState label="Loading module" />}>
          <PageTransition key={loc.pathname} className={fullBleed ? "h-full" : "mx-auto max-w-[1680px]"}>
          <Routes location={loc}>
            <Route path="/" element={<P perm="catalog:read"><MissionOverview /></P>} />
            <Route path="/environment" element={<P perm="catalog:read"><SpaceEnvironment /></P>} />
            <Route path="/orbits" element={<P perm="catalog:read"><OrbitIntelligence /></P>} />
            <Route path="/tracking" element={<P perm="catalog:read"><SatelliteTracking /></P>} />
            <Route path="/debris" element={<P perm="catalog:read"><DebrisMonitoring /></P>} />
            <Route path="/data" element={<P perm="data:read"><DataSources /></P>} />
            <Route path="/audit" element={<P perm="audit:read"><ReportsAudit /></P>} />
            <Route path="/collision" element={<P perm="conjunction:read"><CollisionAssessment /></P>} />
            <Route path="/threats" element={<P perm="conjunction:read"><ThreatMonitoring /></P>} />
            <Route path="/validation" element={<P perm="validation:read"><Validation /></P>} />
            <Route path="/digital-twin" element={<P perm="twin:read"><DigitalTwin /></P>} />
            <Route path="/maneuvers" element={<P perm="twin:read"><ManeuverOptimization /></P>} />
            <Route path="/simulation" element={<P perm="twin:read"><SimulationLab /></P>} />
            <Route path="/scenario" element={<P perm="twin:read"><ScenarioVisualizer /></P>} />
            <Route path="/transfers" element={<P perm="orbits:compute"><TransferLab /></P>} />
            <Route path="/research" element={<P perm="research:read"><ResearchAnalytics /></P>} />
            {/* role dashboards: one per hierarchy */}
            <Route path="/admin" element={<RequireRole roles={["super_admin"]}><SuperAdminDashboard /></RequireRole>} />
            <Route path="/org" element={<RequireRole roles={["org_admin"]}><OrgAdminDashboard /></RequireRole>} />
            <Route path="/mission" element={<RequireRole roles={["mission_manager"]}><MissionDashboard /></RequireRole>} />
            <Route path="/science" element={<RequireRole roles={["scientist"]}><ScienceDashboard /></RequireRole>} />
            <Route path="/operator" element={<RequireRole roles={["operator"]}><OperatorDashboard /></RequireRole>} />
            <Route path="/public" element={<RequireRole roles={["public"]}><PublicDashboard /></RequireRole>} />
            <Route path="/account" element={<Account />} />
            {ALL_ITEMS.filter((i) => !i.built).map((i) => (
              <Route key={i.path} path={i.path} element={<PlannedModule />} />
            ))}
            <Route path="*" element={<NotFound />} />
          </Routes>
          </PageTransition>
          </Suspense>
        </main>
      </div>
    </div>
  );
}

/** Signed-in users who open a sign-in page go to their dashboard instead. */
function GuestOnly({ children }: { children: React.ReactNode }) {
  const { status, me } = useAuth();
  if (status === "loading") return <FullScreenLoading />;
  if (status === "authenticated" && me) return <Navigate to={me.must_change_password ? "/change-password" : me.dashboard} replace />;
  return <>{children}</>;
}

function SessionWatcher() {
  const clear = useAuth((s) => s.clear);
  const refresh = useAuth((s) => s.refresh);
  const nav = useNavigate();
  const loc = useLocation();
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    // Any 401 means the server ended the session (expiry, idle timeout, revoked, role changed).
    const onUnauthorized = () => {
      const portal = useAuth.getState().me?.portal;
      clear();
      nav(portal ? `/login/${portal}?next=${encodeURIComponent(loc.pathname)}` : "/login", { replace: true });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [clear, nav, loc.pathname]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionWatcher />
      <Routes>
        <Route path="/welcome" element={<Suspense fallback={<FullScreenLoading label="Loading" />}><Landing /></Suspense>} />
        <Route path="/login" element={<GuestOnly><PortalHub /></GuestOnly>} />
        <Route path="/login/:portal" element={<GuestOnly><PortalLogin /></GuestOnly>} />
        <Route path="/register" element={<GuestOnly><Register /></GuestOnly>} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/change-password" element={<RequireAuth><ChangePasswordRequired /></RequireAuth>} />
        <Route path="/*" element={<RequireAuth><Shell /></RequireAuth>} />
      </Routes>
    </BrowserRouter>
  );
}
