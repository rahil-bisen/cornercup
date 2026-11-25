import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { loadSiteConfig } from "../lib/config.js";
import { loadRazorpay } from "../lib/razorpay.js";
import { money } from "../lib/money.js";

// This build takes money through Razorpay only — no UPI ID is shown to guests, so nothing can be
// transferred to a handle the café is not watching. Paying at the counter stays as the offline option.
export default function PaymentPanel({ order, onUpdated, trackToken }) {
  const [config, setConfig] = useState(null);
  const [busy, setBusy] = useState("");
  const [awaiting, setAwaiting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    loadSiteConfig()
      .then((value) => {
        if (alive) setConfig(value);
      })
      .catch((err) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  const provider = (config && config.payments && config.payments.provider) || "none";
  const gateway = provider === "razorpay";

  const startCheckout = async () => {
    setBusy("checkout");
    setError("");
    try {
      const { payment } = await api(`/api/orders/${order.id}/payment/razorpay`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const Razorpay = await loadRazorpay();

      const checkout = new Razorpay({
        key: payment.keyId,
        order_id: payment.razorpayOrderId,
        amount: payment.amount,
        currency: payment.currency,
        name: payment.name,
        description: payment.description,
        theme: { color: "#231713" },
        handler: async (response) => {
          setBusy("");
          setAwaiting(true);
          try {
            const result = await api(`/api/orders/${order.id}/payment/razorpay/verify`, {
              method: "POST",
              body: JSON.stringify({
                razorpay_order_id: response && response.razorpay_order_id,
                razorpay_payment_id: response && response.razorpay_payment_id,
                razorpay_signature: response && response.razorpay_signature,
              }),
            });
            if (!result || result.paymentStatus !== "confirmed") {
              setError("Razorpay is still clearing this payment — the order will update on its own.");
            }
          } catch (err) {
            // A webhook can still land later, so this is a delay notice, not a failure.
            setError(err.message);
          } finally {
            setAwaiting(false);
            onUpdated();
          }
        },
        modal: {
          ondismiss: () => setBusy(""),
        },
      });

      checkout.on("payment.failed", (response) => {
        setError((response && response.error && response.error.description) || "That payment didn't go through.");
        setBusy("");
      });

      checkout.open();
    } catch (err) {
      setError(err.message);
      setBusy("");
    }
  };

  const payAtCounter = async () => {
    setBusy("counter");
    setError("");
    try {
      await api(`/api/orders/${order.id}/payment`, {
        method: "POST",
        headers: { "x-order-token": trackToken || "" },
        body: JSON.stringify({ status: "counter" }),
      });
      onUpdated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  if (!config) {
    return (
      <section className="pay-card">
        <p className="muted small">{error || "Preparing payment…"}</p>
      </section>
    );
  }

  return (
    <section className="pay-card">
      <header className="pay-head">
        <p className="eyebrow">Pay now</p>
        <p className="pay-amount">{money(order.totalCents)}</p>
        <p className="muted small">
          {config.cafe.name} · {order.tableLabel}
        </p>
      </header>

      {gateway ? (
        <div className="gateway">
          {awaiting ? (
            <div className="checkout-status">
              <p className="muted small">Checking with Razorpay…</p>
              <button type="button" className="link-btn" onClick={() => onUpdated()}>
                Refresh status
              </button>
            </div>
          ) : (
            <button type="button" className="btn primary" onClick={startCheckout} disabled={Boolean(busy)}>
              {busy === "checkout" ? "Opening checkout…" : `Pay ${money(order.totalCents)}`}
            </button>
          )}

          <p className="muted small center">
            UPI, cards, netbanking and wallets · the order confirms itself once the payment clears.
          </p>

          <button type="button" className="link-btn center-self" onClick={payAtCounter} disabled={Boolean(busy)}>
            {busy === "counter" ? "Saving…" : "I'll pay at the counter instead"}
          </button>
        </div>
      ) : (
        <div className="gateway">
          <p className="pay-hint">
            Online payment isn&apos;t switched on for this café yet, so pay at the counter when you leave.
          </p>
          <button type="button" className="btn primary" onClick={payAtCounter} disabled={Boolean(busy)}>
            {busy === "counter" ? "Saving…" : "I'll pay at the counter"}
          </button>
        </div>
      )}

      {error && <p className="alert">{error}</p>}

      <p className="muted small center">
        Order #{order.id} is already with the kitchen — paying now just settles the bill.
      </p>
    </section>
  );
}
