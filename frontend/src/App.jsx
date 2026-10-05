import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth.jsx";
import { Shell } from "./components/Shell.jsx";
import { Login } from "./pages/Login.jsx";
import { Dashboard } from "./pages/Dashboard.jsx";
import { PeoplePage } from "./pages/People.jsx";
import { Areas } from "./pages/Areas.jsx";
import { SpeakerMap } from "./pages/SpeakerMap.jsx";
import { Speakers } from "./pages/Speakers.jsx";
import { AudioLibrary } from "./pages/Audio.jsx";
import { Announcements } from "./pages/Announcements.jsx";
import { Reports } from "./pages/Reports.jsx";
import { DeviceLogs } from "./pages/DeviceLogs.jsx";
import { Broadcast } from "./pages/Broadcast.jsx";

const RemoteShell = lazy(() => import("./pages/RemoteShell.jsx").then((module) => ({ default: module.RemoteShell })));

function Guard({ roles, children }) {
  const { user } = useAuth();
  if (!roles.includes(user.role)) {
    return (
      <section className="page">
        <div className="panel empty">
          <strong>This section is for another role</strong>
          <p>Your account can use the pages listed in the sidebar.</p>
        </div>
      </section>
    );
  }
  return children;
}

export default function App() {
  const { ready, user } = useAuth();
  if (!ready) return <div className="boot">Opening GramSetu…</div>;

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route element={user ? <Shell /> : <Navigate to="/login" replace />}>
        <Route index element={<Dashboard />} />
        <Route path="admins" element={<Guard roles={["SUPERADMIN"]}><PeoplePage mode="admins" /></Guard>} />
        <Route path="areas" element={<Guard roles={["SUPERADMIN", "ADMIN"]}><Areas /></Guard>} />
        <Route path="users" element={<Guard roles={["SUPERADMIN", "ADMIN"]}><PeoplePage mode="users" /></Guard>} />
        <Route path="speakers" element={<Speakers />} />
        <Route path="map" element={<SpeakerMap />} />
        <Route path="audio" element={<AudioLibrary />} />
        <Route path="announcements" element={<Announcements />} />
        <Route path="live" element={<Navigate to="/speakers" replace />} />
        <Route path="schedules" element={<Navigate to="/announcements" replace />} />
        <Route path="reports" element={<Reports />} />
        <Route path="broadcast" element={<Broadcast />} />
        <Route path="device-logs" element={<Guard roles={["SUPERADMIN", "ADMIN"]}><DeviceLogs /></Guard>} />
        <Route path="remote-shell" element={<Guard roles={["SUPERADMIN", "ADMIN"]}><Suspense fallback={<div className="boot">Loading terminal…</div>}><RemoteShell /></Suspense></Guard>} />
      </Route>
      <Route path="*" element={<Navigate to={user ? "/" : "/login"} replace />} />
    </Routes>
  );
}
