import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth.jsx";
import { ROLE_LABEL } from "../format.js";
import { Mark } from "./ui.jsx";

const NAV = [
  { to: "/", label: "Dashboard", group: "Overview", end: true },
  { to: "/admins", label: "Admins", group: "Masters", roles: ["SUPERADMIN"] },
  { to: "/areas", label: "Areas", group: "Masters", roles: ["SUPERADMIN", "ADMIN"] },
  { to: "/users", label: "Users", group: "Masters", roles: ["SUPERADMIN", "ADMIN"] },
  { to: "/speakers", label: "Speakers", group: "Field" },
  { to: "/map", label: "Map", group: "Field" },
  { to: "/broadcast", label: "Live broadcast", group: "Field" },
  { to: "/audio", label: "Audio library", group: "Field" },
  { to: "/announcements", label: "Announcements", group: "Field" },
  { to: "/reports", label: "Play reports", group: "Field" },
  { to: "/device-logs", label: "Device logs", group: "Diagnostics", roles: ["SUPERADMIN", "ADMIN"] },
  { to: "/remote-shell", label: "Remote shell", group: "Diagnostics", roles: ["SUPERADMIN", "ADMIN"] },
];

export function Shell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const items = NAV.filter((item) => !item.roles || item.roles.includes(user.role));
  const groups = [...new Set(items.map((item) => item.group))];

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    document.body.classList.toggle("nav-open", navOpen);
    return () => document.body.classList.remove("nav-open");
  }, [navOpen]);

  return (
    <div className={`app-shell${navOpen ? " nav-open" : ""}`}>
      <button
        className="nav-backdrop"
        type="button"
        aria-label="Close menu"
        tabIndex={navOpen ? 0 : -1}
        onClick={() => setNavOpen(false)}
      />
      <aside className="sidebar" id="app-sidebar">
        <div className="sidebar-top">
          <div className="brand">
            <Mark />
            <div>
              <strong>GramSetu</strong>
              <span>Village announcements</span>
            </div>
          </div>
          <button
            className="btn ghost small nav-close"
            type="button"
            aria-label="Close menu"
            onClick={() => setNavOpen(false)}
          >
            Close
          </button>
        </div>
        <nav>
          {groups.map((group) => (
            <div key={group} className="nav-group">
              <p>{group}</p>
              {items
                .filter((item) => item.group === group)
                .map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.end} className="nav-link">
                    {item.label}
                  </NavLink>
                ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <strong>{user.name}</strong>
          <span>{ROLE_LABEL[user.role]}{user.area ? ` · ${user.area.name}` : ""}</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="btn ghost small nav-toggle"
              type="button"
              aria-expanded={navOpen}
              aria-controls="app-sidebar"
              onClick={() => setNavOpen((open) => !open)}
            >
              Menu
            </button>
            <p>{user.area ? `${user.area.name} area` : "All areas"}</p>
          </div>
          <button
            className="btn ghost small"
            type="button"
            onClick={() => {
              logout();
              navigate("/login");
            }}
          >
            Sign out
          </button>
        </header>
        <main>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
