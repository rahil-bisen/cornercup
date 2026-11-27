import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, cafePath } from "../lib/api.js";
import { cafeName, isCafeNotFound, useSiteConfigState } from "../lib/config.js";
import { gatewayEnabled } from "../lib/payments.js";
import CafeNotFound from "../components/CafeNotFound.jsx";
import SiteFooter from "../components/SiteFooter.jsx";

// The first screen a guest sees after scanning a table QR code, so it is built mobile-first:
// one thumb-reachable primary action, large table targets, and copy that fits a 360px phone.
export default function Landing() {
  const [tables, setTables] = useState([]);
  const [loadingTables, setLoadingTables] = useState(true);
  // Bumped by "Try again", so the table list is fetched again together with the café config.
  const [tablesAttempt, setTablesAttempt] = useState(0);
  const { config, error: configError, retry: retryConfig } = useSiteConfigState();
  const cafe = cafeName(config);
  // Counter-service cafés have no tables to scan, so the page sells pickup instead of table service.
  const counterService = Boolean(config && config.service && config.service.mode === "counter");
  // Only promise UPI/cards/wallets when this café can actually take an online payment.
  const online = gatewayEnabled(config);

  useEffect(() => {
    let alive = true;
    setLoadingTables(true);
    api("/api/tables")
      .then((data) => {
        if (alive) setTables(data.tables || []);
      })
      .catch(() => {
        if (alive) setTables([]);
      })
      .finally(() => {
        if (alive) setLoadingTables(false);
      });
    return () => {
      alive = false;
    };
  }, [tablesAttempt]);

  // Until the café's settings arrive we don't know its name, service style or payment options, so we
  // show a neutral placeholder instead of guessing ("Café", "Dine-in") and then flipping.
  if (!config) {
    if (isCafeNotFound(configError)) return <CafeNotFound />;
    if (configError) {
      return (
        <main className="page-narrow">
          <div className="state-card" role="alert">
            <span className="state-emoji" aria-hidden="true">
              🫥
            </span>
            <h1>We couldn&apos;t open this café</h1>
            <p className="muted">{configError.message}</p>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                retryConfig();
                setTablesAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
          </div>
        </main>
      );
    }
    return (
      <main className="page-narrow">
        <div className="state-card" aria-busy="true">
          <span className="state-emoji" aria-hidden="true">
            ☕
          </span>
          <p className="muted">Loading…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="landing">
      <header className="landing-bar">
        <span className="brand-mark small" aria-hidden="true">
          ☕
        </span>
        <p className="landing-bar-name">{cafe}</p>
        <span className="landing-bar-mode">{counterService ? "Pickup" : "Dine-in"}</span>
      </header>

      <section className="landing-hero">
        <p className="eyebrow">{counterService ? "Order ahead" : "Order from your table"}</p>
        <h1>{counterService ? "Skip the queue" : "Order without the wait"}</h1>
        <p className="landing-lede">
          {counterService
            ? online
              ? `Browse the live menu at ${cafe}, pay from your phone and collect at the counter when your number is called.`
              : `Browse the live menu at ${cafe}, order from your phone, then pay and collect at the counter when your number is called.`
            : `Browse the live menu at ${cafe} and send your order straight to the kitchen — no app, no waiting to catch someone's eye.`}
        </p>
      </section>

      {counterService ? (
        <section className="landing-action">
          <Link className="btn primary landing-cta" to={cafePath("/menu")}>
            Start an order
            <span aria-hidden="true">→</span>
          </Link>
          <p className="landing-note">
            {online ? "UPI, cards and wallets accepted · paying at the counter is fine too" : "Pay at the counter when you collect"}
          </p>
        </section>
      ) : (
        <section className="landing-card">
          <h2>Which table are you at?</h2>
          <p className="muted small">
            Tap your table to start. Or scan the QR code on the table — it opens the menu for you.
          </p>
          {loadingTables ? (
            <div className="table-grid" aria-busy="true" aria-label="Loading tables">
              {[0, 1, 2, 3, 4, 5].map((key) => (
                <span key={key} className="table-chip table-chip-skeleton" aria-hidden="true" />
              ))}
            </div>
          ) : (
            <div className="table-grid">
              {tables.map((table) => (
                <Link key={table.id} className="table-chip" to={cafePath(`/t/${table.id}`)}>
                  <span>{table.label}</span>
                  <small>{table.seats} seats</small>
                </Link>
              ))}
            </div>
          )}
          {!loadingTables && tables.length === 0 && (
            <p className="muted small">
              Table numbers aren&apos;t listed right now. Ask a staff member, or tap the button below.
            </p>
          )}
          {!loadingTables && tables.length === 0 && (
            <Link className="btn ghost" to={cafePath("/menu")}>
              Open the menu
            </Link>
          )}
        </section>
      )}

      <section className="landing-card">
        <h2>How it works</h2>
        <ol className="steps">
          <li>
            <span className="step-num" aria-hidden="true">
              1
            </span>
            <div>
              <strong>{counterService ? "Scan the code at the counter" : "Scan the QR code"}</strong>
              <p className="muted small">
                {counterService
                  ? "One code for the whole café opens the live menu."
                  : "Every table has its own code, so we always know where you're sitting."}
              </p>
            </div>
          </li>
          <li>
            <span className="step-num" aria-hidden="true">
              2
            </span>
            <div>
              <strong>Pick your food and drinks</strong>
              <p className="muted small">Live menu with today&apos;s sold-out items marked automatically.</p>
            </div>
          </li>
          <li>
            <span className="step-num" aria-hidden="true">
              3
            </span>
            <div>
              <strong>{counterService ? "Pay and collect" : "Send it to the kitchen"}</strong>
              <p className="muted small">
                {counterService
                  ? online
                    ? "Pay securely by UPI, card or wallet. We'll call your pickup number when it's ready."
                    : "Pay at the counter. We'll call your pickup number when it's ready."
                  : online
                    ? "Pay securely at your table — UPI, card or wallet, no app to install."
                    : "Your order goes straight to the kitchen — pay at the counter, no app to install."}
              </p>
            </div>
          </li>
        </ol>
      </section>

      <SiteFooter />
    </main>
  );
}
