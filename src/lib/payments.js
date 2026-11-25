// Which payment rail a checkout declares.
//
// The server accepts exactly two values — "counter" (pay at the counter) and "razorpay" (pay online) —
// and maps anything else to "razorpay". That allowlist is deliberately strict, so the browser must send
// the right one instead of relying on a default: a café with no gateway used to send "razorpay" and the
// guest was then shown a payment panel that could only answer 503.
//
// The decision comes from the café's own configuration (`GET /api/cafes/<slug>/config`):
//
//   payments: { provider: "razorpay" | "none", gateway: boolean, keyId: string | null }
//
// Only a café that reports BOTH a razorpay provider and a live gateway gets the online rail. Everything
// else — no config yet, a malformed payload, keys missing on the deployment — fails safe to "counter",
// which never promises a payment the deployment cannot take. Service mode is not consulted: a counter
// café with a live gateway still collects online (pay, then pick up), and that flow must keep working.
export const PAYMENT_COUNTER = "counter";
export const PAYMENT_RAZORPAY = "razorpay";

const ALLOWED = [PAYMENT_COUNTER, PAYMENT_RAZORPAY];

// True only for the exact shape the server publishes with a live gateway. Anything else is "not
// configured", including a truthy gateway with a non-razorpay provider.
export function gatewayEnabled(config) {
  const payments = config && typeof config === "object" ? config.payments : null;
  if (!payments || typeof payments !== "object") return false;
  return payments.provider === "razorpay" && payments.gateway === true;
}

// The value the checkout POST must carry. Never returns anything outside the server's allowlist.
export function checkoutPaymentMethod(config) {
  const method = gatewayEnabled(config) ? PAYMENT_RAZORPAY : PAYMENT_COUNTER;
  return ALLOWED.includes(method) ? method : PAYMENT_COUNTER;
}
