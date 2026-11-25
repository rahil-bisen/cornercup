import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { api, cafePath } from "../lib/api.js";
import { clockTime, money } from "../lib/money.js";
import PaymentPanel from "../components/PaymentPanel.jsx";

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

function paymentSummary(order) {
  if (order.paymentStatus === "confirmed") return { label: "Paid", tone: "paid" };
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
    const timer = setInterval(run, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
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
      <main className="page-narrow">
        <div className="state-card">
          <p className="muted">Finding your order…</p>
        </div>
      </main>
    );
  }

  const cancelled = order.status === "cancelled";
  const pickup = !order.tableId;
  const steps = stepsFor(pickup);
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
        <p className="eyebrow">{pickup ? `Pickup #${order.queueNo}` : order.tableLabel}</p>
        <h1>{cancelled ? "Order cancelled" : "Order confirmed"}</h1>
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
          {order.paymentStatus === "confirmed" && "Payment received — thank you!"}
          {order.paymentStatus !== "confirmed" &&
            (order.paymentStatus === "counter" || order.paymentMethod === "counter"
              ? "Pay at the counter — card, cash or UPI."
              : "Pay above to settle this order.")}
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
