import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { api, cafePath } from "../lib/api.js";
import { clockTime, money } from "../lib/money.js";
import PaymentPanel from "../components/PaymentPanel.jsx";

// A guest watching their ticket polls less often than staff need to: fifteen seconds is well inside
// the time it takes to make a coffee, and each poll is a read the limiter answers without a D1
// write. Hidden pages stop polling entirely.
const ORDER_POLL_MS = 15 * 1000;

// Pickup orders are collected, table orders are delivered, so the wording follows the order kind.
function stepsFor(pickup) {
  return [
    { key: "new", title: "Order received", detail: "The kitchen has your ticket." },
    {
      key: "preparing",
      title: "Being made",
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
  if (order.status === "preparing") return "Being made";
  if (order.status === "ready") return pickup ? "Ready to collect" : "Your order is ready";
  if (order.status === "served") return pickup ? "Collected" : "Served";
  return "Order confirmed";
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
        {/* The queue number (or the table) is the one thing a guest reads across a room, so it is the
            largest text on the page — not a 10px eyebrow above a generic heading. */}
        <p className="eyebrow">{pickup ? "Pickup number" : "Table"}</p>
        <p className="queue-number">{pickup ? order.queueNo : order.tableLabel}</p>
        <h1>{heading}</h1>
        <p className="muted">
          Order <strong>#{order.id}</strong> · placed {clockTime(order.createdAt)}
        </p>
      </header>

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

          <ol className="timeline">
            {steps.map((step, index) => {
              const state = index < currentIndex ? "done" : index === currentIndex ? "active" : "todo";
              return (
                <li key={step.key} className={`timeline-step ${state}`}>
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
              <span className="receipt-emoji" aria-hidden="true">
                {item.emoji}
              </span>
              <span className="receipt-name">
                {item.qty}× {item.name}
              </span>
              <span>{money(item.priceCents * item.qty)}</span>
            </li>
          ))}
        </ul>
        {order.note && (
          <p className="receipt-note">
            <span className="muted small">Note for the kitchen</span>
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
