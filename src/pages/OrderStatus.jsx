import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { api, cafePath } from "../lib/api.js";
import { clockTime, money } from "../lib/money.js";
import PaymentPanel from "../components/PaymentPanel.jsx";
import { useCafeTitle } from "../lib/config.js";
import { hasDailyNumber, orderLabel } from "../lib/orderNumber.js";

// A guest watching their ticket polls less often than staff need to: fifteen seconds is well inside
// the time it takes to make a coffee, and each poll is a read the limiter answers without a D1
// write. Hidden pages stop polling entirely.
const ORDER_POLL_MS = 15 * 1000;

// Pickup orders are collected, table orders are delivered, so the wording follows the order kind.
function stepsFor(pickup) {
  return [
    { key: "new", title: "Received", detail: "The kitchen has your ticket." },
    {
      key: "preparing",
      title: "Preparing",
      detail: pickup ? "We'll call your pickup number when it's ready." : "Your food and drinks are on the way.",
    },
    { key: "ready", title: "Ready", detail: pickup ? "Collect it at the counter." : "Coming to your table now." },
    {
      key: "served",
      title: pickup ? "Collected" : "Served",
      detail: pickup ? "Enjoy — see you again soon." : "Enjoy your order.",
    },
  ];
}

// Counter orders carry no table, so their "back to menu" link is the plain menu.
function menuPath(order) {
  return cafePath(order && order.tableId ? `/t/${order.tableId}` : "");
}

// The heading has to describe the ticket as it is now: "Order confirmed" is only true while the order is
// still new, and a served or cancelled order that still claims to be confirmed is simply wrong. The
// wording follows the collection style too — a pickup order is collected, a table order is served.
function headingFor(order, pickup) {
  if (order.status === "cancelled") return "Order cancelled";
  if (order.status === "preparing") return "Being prepared";
  if (order.status === "ready") return pickup ? "Ready to collect" : "Your order is ready";
  if (order.status === "served") return pickup ? "Collected" : "Served";
  return "Thanks — your order is in!";
}

// "Usually ready in about 15 min (around 7:45 PM)": only while the order is still on its way, and only
// when the café has said how long orders usually take. Nothing is estimated from guesswork.
function waitEstimate(order) {
  const minutes = Number(order.typicalWaitMin);
  if (!Number.isInteger(minutes) || minutes <= 0) return null;
  if (order.status !== "new" && order.status !== "preparing") return null;
  const placed = Date.parse(order.createdAt);
  const around = Number.isFinite(placed) ? clockTime(new Date(placed + minutes * 60 * 1000).toISOString()) : "";
  return `Usually ready in about ${minutes} min${around ? ` (around ${around})` : ""}`;
}

// Staff pressing "Payment received" stores payment_status 'counter' together with paid_at. A guest who
// only chose to pay at the counter gets 'counter' with no paid_at and still owes the bill.
function paidAtCounter(order) {
  return order.paymentStatus === "counter" && Boolean(order.paidAt);
}

function paymentSummary(order) {
  if (order.paymentStatus === "confirmed") return { label: "Paid", tone: "paid" };
  if (paidAtCounter(order)) return { label: "Paid at the counter", tone: "paid" };
  if (order.paymentStatus === "counter" || order.paymentMethod === "counter") {
    return { label: "Pay at the counter when you leave", tone: "counter" };
  }
  return { label: "Payment due", tone: "due" };
}

export default function OrderStatus() {
  const { tableId, orderId } = useParams();
  const location = useLocation();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState("");
  // The order carries the café's name, so this page titles its tab without fetching the café config.
  useCafeTitle(order && order.cafeName ? { cafe: { name: order.cafeName } } : null, order ? `Order ${orderLabel(order)}` : "");

  // The token travels in the fragment, so it never reaches a server log. It is what proves this browser
  // placed the order: the id alone is not a credential, and without one this page asks for staff help
  // rather than polling an endpoint that would only ever answer 404.
  const trackToken = useMemo(() => {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    return params.get("t") || "";
  }, [location.hash]);

  const fetchOrder = useCallback(async () => {
    if (!trackToken) throw new Error("This link is missing its tracking code. Scan the QR code again or ask our staff.");
    const payload = await api(`/api/orders/${encodeURIComponent(orderId)}`, {
      headers: { "x-order-token": trackToken },
    });
    return payload.order;
  }, [orderId, trackToken]);

  useEffect(() => {
    let cancelled = false;
    if (!trackToken) return undefined;

    const run = () => {
      fetchOrder()
        .then((next) => {
          if (!cancelled) {
            setOrder(next);
            setError("");
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err.message);
        });
    };

    run();
    let timer = null;
    const start = () => {
      if (timer === null) timer = setInterval(run, ORDER_POLL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        run();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchOrder, trackToken]);

  const refresh = () => {
    fetchOrder()
      .then(setOrder)
      .catch(() => {});
  };

  // A link with no fragment cannot prove anything, and there is no request worth sending. Show the same
  // card rather than waiting forever on a reply that will never come.
  if (error || !trackToken) {
    return (
      <main className="page-narrow">
        <div className="state-card">
          <span className="state-emoji" aria-hidden="true">
            🧾
          </span>
          <h1>Order not found</h1>
          <p className="muted">
            {error || "This link is missing its tracking code. Scan the QR code again, or ask our staff."}
          </p>
          <Link className="btn primary" to={cafePath(tableId ? `/t/${tableId}` : "")}>
            Back to the menu
          </Link>
        </div>
      </main>
    );
  }

  if (!order) {
    return (
      <main className="page-narrow status-page" aria-busy="true">
        <div className="status-skeleton" aria-hidden="true">
          <div className="skeleton-line w-30" />
          <div className="skeleton-line w-60" />
          <div className="skeleton-line w-90" />
        </div>
        <div className="timeline timeline-skeleton" aria-hidden="true">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="timeline-step">
              <span className="timeline-dot skeleton" />
              <div className="skeleton-lines">
                <div className="skeleton-line w-60" />
                <div className="skeleton-line w-90" />
              </div>
            </div>
          ))}
        </div>
        <p className="muted small center">Finding your order…</p>
      </main>
    );
  }

  const cancelled = order.status === "cancelled";
  const pickup = !order.tableId;
  const steps = stepsFor(pickup);
  const heading = headingFor(order, pickup);
  const currentIndex = Math.max(
    0,
    steps.findIndex((step) => step.key === order.status)
  );
  const payment = paymentSummary(order);
  const needsPayment =
    order.paymentStatus === "unpaid" && order.paymentMethod !== "counter" && order.status !== "cancelled";

  return (
    <main className="page-narrow status-page">
      <header className="receipt-head">
        <h1>{heading}</h1>
        <p className="muted">
          {pickup ? "Pickup" : order.tableLabel} · placed {clockTime(order.createdAt)}
        </p>
      </header>

      {/* The number a guest holds up for staff, or reads when it is called, is the largest thing on the
          page. A pickup order is called by its queue number; a table order is found by its code. */}
      <section className="order-ticket" aria-label="Your order number">
        <p className="eyebrow">Your order number</p>
        <p className="order-ticket-number">Order {orderLabel(order)}</p>
        <p className="muted small">
          {pickup && hasDailyNumber(order)
            ? "We'll call this number when it's ready"
            : "Show this to staff if you need help with your order"}
        </p>
      </section>

      {cancelled ? (
        <div className="state-card compact">
          <p>This order was cancelled by the café. Please talk to a staff member if that's a surprise.</p>
          <Link className="btn primary" to={menuPath(order)}>
            Order again
          </Link>
        </div>
      ) : (
        <>
          {needsPayment && <PaymentPanel order={order} onUpdated={refresh} trackToken={trackToken} />}

          {!needsPayment && (
            <p className={`pay-status ${payment.tone}`}>
              <span aria-hidden="true">{payment.tone === "paid" ? "✓" : payment.tone === "pending" ? "⏳" : "₹"}</span>
              {payment.label}
            </p>
          )}

          {waitEstimate(order) && (
            <p className="wait-estimate">
              <span aria-hidden="true">⏱</span> {waitEstimate(order)}
            </p>
          )}

          <ol className="timeline" aria-label="Order progress">
            {steps.map((step, index) => {
              const state = index < currentIndex ? "done" : index === currentIndex ? "active" : "todo";
              return (
                <li key={step.key} className={`timeline-step ${state}`} aria-current={state === "active" ? "step" : undefined}>
                  <span className="timeline-dot" aria-hidden="true">
                    {state === "done" ? "✓" : index + 1}
                  </span>
                  <div>
                    <strong>{step.title}</strong>
                    <p className="muted small">{step.detail}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}

      <section className="receipt">
        <h2>Your order</h2>
        <ul className="receipt-lines">
          {order.items.map((item, index) => (
            <li key={`${item.name}-${index}`}>
              <span className="receipt-name">
                {item.qty}× {item.name}
                {item.note && <span className="receipt-item-note">“{item.note}”</span>}
              </span>
              <span>{money(item.priceCents * item.qty)}</span>
            </li>
          ))}
        </ul>
        {order.note && (
          <p className="receipt-note">
            <span className="muted small">Note for the whole order</span>
            <br />
            {order.note}
          </p>
        )}
        <div className="receipt-total">
          <span>{payment.tone === "paid" ? "Paid" : "Total"}</span>
          <strong>{money(order.totalCents)}</strong>
        </div>
        <p className="muted small center">
          {/* A cancelled order owes nothing, so it never carries a payment instruction. The total above
              stays as the record of what was ordered; only the reassurance line changes. */}
          {cancelled
            ? "This order was cancelled — nothing to pay."
            : order.paymentStatus === "confirmed" || paidAtCounter(order)
              ? "Payment received — thank you!"
              : order.paymentStatus === "counter" || order.paymentMethod === "counter"
                ? "Pay at the counter — card, cash or UPI."
                : "Pay above to settle this order."}
        </p>
      </section>

      <div className="status-actions">
        <Link className="btn ghost" to={menuPath(order)}>
          Add something else
        </Link>
        <span className="live-note">
          <span className="live-dot" aria-hidden="true" /> Updating live
        </span>
      </div>
    </main>
  );
}
