import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth.jsx";
import { Mark } from "../components/ui.jsx";

const DEMOS = [
  ["Super admin", "superadmin@gramsetu.local", "Super@123"],
  ["Admin", "admin@gramsetu.local", "Admin@123"],
  ["Maker", "rampur.maker@gramsetu.local", "Maker@123"],
  ["Checker", "rampur.checker@gramsetu.local", "Check@123"],
];

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(email.trim(), password);
      navigate("/");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <section className="login-copy">
        <div className="brand light">
          <Mark />
          <div>
            <strong>GramSetu</strong>
            <span>ग्राम सेतु</span>
          </div>
        </div>
        <h1>Announcements for villages a network can still reach.</h1>
        <p>
          A maker records the message. A checker approves it. Speakers installed
          in the village play only what was approved.
        </p>
        <ol className="steps">
          <li>Admin sets up areas, speakers, and maker/checker users.</li>
          <li>Maker uploads audio; the app stores a 16 kHz mono WAV in S3.</li>
          <li>Checker approves or sends it back.</li>
          <li>Each speaker polls and plays the queued audio.</li>
        </ol>
      </section>
      <section className="login-card">
        <h2>Sign in</h2>
        <p>Use the role that matches the work you are doing.</p>
        <form onSubmit={submit}>
          {error ? <div className="banner">{error}</div> : null}
          <label className="field">
            <span>Email</span>
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="username" required />
          </label>
          <label className="field">
            <span>Password</span>
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required />
          </label>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <div className="demo-list">
          <p>Demo accounts</p>
          {DEMOS.map(([label, demoEmail, demoPassword]) => (
            <button
              key={demoEmail}
              type="button"
              className="demo-chip"
              onClick={() => {
                setEmail(demoEmail);
                setPassword(demoPassword);
              }}
            >
              <strong>{label}</strong>
              <span>{demoEmail}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
