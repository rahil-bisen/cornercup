// Stage 9A: which payment rail a checkout declares.
//
// The bug this covers: the cart POST always carried paymentMethod "razorpay", so a counter café with no
// gateway was recorded as an online-payment order and its guest was shown a payment panel that could
// only fail. The rail now comes from the café's own config, and the server's allowlist ("counter" or
// "razorpay") is never widened: these tests assert the exact value that goes on the wire.

import test from "node:test";
import assert from "node:assert/strict";
import {
  PAYMENT_COUNTER,
  PAYMENT_RAZORPAY,
  checkoutPaymentMethod,
  gatewayEnabled,
} from "../src/lib/payments.js";

const noGateway = { provider: "none", gateway: false, keyId: null };
const liveGateway = { provider: "razorpay", gateway: true, keyId: "rzp_test_key" };

// What the staging café actually returns: counter service, no Razorpay keys on the deployment.
const counterCafe = { cafe: { name: "Corner Cup" }, service: { mode: "counter" }, payments: noGateway };
// Table service, no gateway: the same rule must apply, because the rail is not a property of the mode.
const tableCafe = { cafe: { name: "Corner Cup" }, service: { mode: "tables" }, payments: noGateway };
// Pay-and-collect: a counter café that does take money online keeps the Razorpay rail.
const counterCafeWithGateway = {
  cafe: { name: "Corner Cup" },
  service: { mode: "counter" },
  payments: liveGateway,
};

test("a counter café with no gateway submits 'counter'", () => {
  assert.equal(checkoutPaymentMethod(counterCafe), PAYMENT_COUNTER);
  assert.equal(gatewayEnabled(counterCafe), false);
});

test("a table café with no gateway also submits 'counter'", () => {
  assert.equal(checkoutPaymentMethod(tableCafe), PAYMENT_COUNTER);
});

test("a café with a live gateway keeps the Razorpay rail", () => {
  assert.equal(checkoutPaymentMethod(counterCafeWithGateway), PAYMENT_RAZORPAY);
  assert.equal(gatewayEnabled(counterCafeWithGateway), true);
  assert.equal(
    checkoutPaymentMethod({ service: { mode: "tables" }, payments: liveGateway }),
    PAYMENT_RAZORPAY,
    "table service with a gateway is unchanged"
  );
});

test("missing or malformed configuration fails safe to 'counter'", () => {
  const malformed = [
    null,
    undefined,
    {},
    { payments: null },
    { payments: "" },
    { payments: [] },
    { payments: {} },
    // A gateway flag with no razorpay provider is not a gateway.
    { payments: { gateway: true } },
    { payments: { gateway: true, provider: "none" } },
    { payments: { gateway: true, provider: "stripe", keyId: "pk_x" } },
    // A provider name alone, with the gateway switched off, is not a gateway.
    { payments: { provider: "razorpay", gateway: false } },
    { payments: { provider: "razorpay" } },
    // Strings that look like the right values are not the right values.
    { payments: { provider: "razorpay", gateway: "true" } },
    { payments: { provider: "razorpay ", gateway: true } },
  ];
  for (const config of malformed) {
    assert.equal(gatewayEnabled(config), false, `gateway for ${JSON.stringify(config)}`);
    assert.equal(checkoutPaymentMethod(config), PAYMENT_COUNTER, `method for ${JSON.stringify(config)}`);
  }
});

test("the selector never returns a value outside the server's allowlist", () => {
  const junk = [
    null,
    1,
    "counter",
    { payments: { provider: "razorpay", gateway: true } },
    { payments: { provider: "razorpay", gateway: true, keyId: "k" }, service: { mode: "counter" } },
    { payments: { provider: 42, gateway: true } },
    { payments: Object.create(null) },
  ];
  for (const config of junk) {
    const method = checkoutPaymentMethod(config);
    assert.ok(
      method === PAYMENT_COUNTER || method === PAYMENT_RAZORPAY,
      `unexpected method ${String(method)}`
    );
  }
});

test("no accidental fallback: neither a counter café nor an unknown café ever selects Razorpay", () => {
  // The original bug in one assertion: counter service without a gateway must not produce "razorpay".
  assert.notEqual(checkoutPaymentMethod(counterCafe), PAYMENT_RAZORPAY);
  assert.notEqual(checkoutPaymentMethod(counterCafe.service && {}), PAYMENT_RAZORPAY);
  // And the reverse, so a guard that always answered "counter" would fail the gateway test above
  // rather than passing both by accident.
  assert.equal(checkoutPaymentMethod(counterCafeWithGateway), PAYMENT_RAZORPAY);
});
