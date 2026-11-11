import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { api } from "../lib/api.js";

// The bare domain keeps behaving like the original single-café site: it resolves the primary café
// and hands the visitor to that café's own scan → menu → order flow. The operator console stays
// separate at /operator, so nothing here exposes the other tenants.
export default function DefaultCafe() {
  const [slug, setSlug] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api("/api/cafe")
      .then((payload) => {
        if (alive) setSlug(payload.slug);
      })
      .catch((err) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (slug) return <Navigate to={`/c/${encodeURIComponent(slug)}`} replace />;

  return (
    <main className="login-wrap">
      {error ? (
        <p className="muted small">
          {error} <Link to="/operator">Open the operator console</Link>
        </p>
      ) : (
        <p className="muted small">Opening the menu…</p>
      )}
    </main>
  );
}
