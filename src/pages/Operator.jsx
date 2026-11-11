import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";

// The console behind OPERATOR_PASSWORD. It is the only screen that sees every tenant at once, so it
// never trusts the café slug in the address bar: the server checks the operator session itself.
export default function Operator() {
  const [session, setSession] = useState("checking");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api("/api/operator/session")
      .then(() => {
        if (alive) setSession("in");
      })
      .catch(() => {
        if (alive) setSession("out");
      });
    return () => {
      alive = false;
    };
  }, []);

  const signIn = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/operator/login", { method: "POST", body: JSON.stringify({ password }) });
      setPassword("");
      setSession("in");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    try {
      await api("/api/operator/logout", { method: "POST" });
    } catch {
      /* the screen clearing is what matters */
    }
    setSession("out");
  };

  if (session === "checking") {
    return (
      <main className="login-wrap">
        <p className="muted small">Checking your session…</p>
      </main>
    );
  }

  if (session === "out") {
    return (
      <main className="login-wrap">
        <form className="login-card" onSubmit={signIn}>
          <span className="brand-mark" aria-hidden="true">
            ☕
          </span>
          <h1>Operator console</h1>
          <p className="muted small">Sign in to add a café to this deployment.</p>
          <label className="field">
            <span>Operator password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••"
              autoFocus
            />
          </label>
          {error && <p className="alert">{error}</p>}
          <button type="submit" className="btn primary" disabled={busy || password.length === 0}>
            {busy ? "Checking…" : "Sign in"}
          </button>
          <Link className="muted small center" to="/">
            Back to the café list
          </Link>
        </form>
      </main>
    );
  }

  return <OperatorShell onSignOut={signOut} />;
}

function OperatorShell({ onSignOut }) {
  const [cafes, setCafes] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    slug: "",
    password: "",
    serviceMode: "tables",
    tables: 8,
  });

  const load = useCallback(async () => {
    try {
      const payload = await api("/api/operator/cafes");
      setCafes(payload.cafes || []);
      setError("");
    } catch (err) {
      if (err.status === 401) onSignOut();
      else setError(err.message);
    }
  }, [onSignOut]);

  useEffect(() => {
    load();
  }, [load]);

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const create = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = await api("/api/operator/cafes", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          slug: form.slug || undefined,
          password: form.password,
          serviceMode: form.serviceMode,
          tables: Number(form.tables),
        }),
      });
      setNotice(`${payload.cafe.name} is ready at ${payload.cafe.url}`);
      setForm({ name: "", slug: "", password: "", serviceMode: "tables", tables: 8 });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="admin">
      <header className="admin-top">
        <div className="admin-brand">
          <span className="brand-mark small" aria-hidden="true">
            ☕
          </span>
          <div>
            <strong>Operator console</strong>
            <p className="muted small">{cafes ? `${cafes.length} cafés on this deployment` : "Loading…"}</p>
          </div>
        </div>
        <div className="admin-top-actions">
          <Link className="btn ghost small-btn" to="/">
            Café list
          </Link>
          <button type="button" className="btn ghost small-btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <div className="admin-body">
        <section>
          <div className="board-head-row">
            <h1>Cafés</h1>
            <p className="muted small">Each café has its own menu, orders and owner password</p>
          </div>

          {error && <p className="alert">{error}</p>}
          {notice && <p className="muted small">{notice}</p>}
          {!cafes && <p className="muted">Loading cafés…</p>}

          <div className="table-grid">
            {(cafes || []).map((cafe) => (
              <Link key={cafe.slug} className="table-chip" to={`/c/${cafe.slug}`}>
                <span>{cafe.name}</span>
                <small>
                  /c/{cafe.slug} · {cafe.menuCount} items · {cafe.openCount} open
                </small>
              </Link>
            ))}
          </div>

          <form className="add-form" onSubmit={create}>
            <h2>Add a café</h2>
            <div className="add-grid">
              <label className="field">
                <span>Name</span>
                <input
                  required
                  maxLength={60}
                  value={form.name}
                  onChange={(event) => update("name", event.target.value)}
                  placeholder="Corner Cup Café"
                />
              </label>
              <label className="field">
                <span>Web address</span>
                <input
                  maxLength={40}
                  value={form.slug}
                  onChange={(event) => update("slug", event.target.value)}
                  placeholder="corner-cup"
                />
              </label>
              <label className="field">
                <span>Owner password</span>
                <input
                  required
                  type="password"
                  autoComplete="new-password"
                  minLength={6}
                  value={form.password}
                  onChange={(event) => update("password", event.target.value)}
                  placeholder="At least 6 characters"
                />
              </label>
            </div>

            <div className="add-grid">
              <label className="field">
                <span>Service style</span>
                <select
                  value={form.serviceMode}
                  onChange={(event) => update("serviceMode", event.target.value)}
                >
                  <option value="tables">Table service — guests scan a table QR</option>
                  <option value="counter">Counter — pickup numbers, no tables</option>
                </select>
              </label>
              <label className="field">
                <span>Tables to start with</span>
                <input
                  type="number"
                  min="0"
                  max="40"
                  value={form.tables}
                  onChange={(event) => update("tables", event.target.value)}
                  disabled={form.serviceMode === "counter"}
                />
              </label>
            </div>

            <button type="submit" className="btn primary" disabled={saving}>
              {saving ? "Creating…" : "Create café"}
            </button>
            <p className="muted small">
              A new café starts with the standard sample menu, so the guest site works the moment it
              exists. The owner can edit the menu and the password from their own owner board.
            </p>
          </form>
        </section>
      </div>
    </div>
  );
}
