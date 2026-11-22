import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dollarsToCents, minorUnits, stage, validateMapping, runPipeline, paymentFacts } from "./transform.mjs";

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const mappings = { orders: json("./mappings/orders.json"), payments: json("./mappings/payments.json"), shipping: json("./mappings/shipping.json") };

test("dollars convert to cents exactly", () => {
  assert.equal(dollarsToCents(12.34), 1234n);
  assert.equal(dollarsToCents("19.99"), 1999n);
  assert.equal(dollarsToCents(200), 20000n);
  assert.equal(dollarsToCents(-35.05), -3505n);
  assert.equal(dollarsToCents(0.1), 10n);
  assert.throws(() => dollarsToCents("12.345"));
  assert.throws(() => dollarsToCents("$12.34"));
});

test("minor units reject fractions", () => {
  assert.equal(minorUnits(1234), 1234n);
  assert.throws(() => minorUnits(12.34));
});

test("checked-in mappings are valid", () => {
  for (const m of Object.values(mappings)) assert.deepEqual(validateMapping(m), []);
});

test("payments sample normalizes to the expected canonical cents", () => {
  const sample = json("./samples/payments.sample.json");
  const expected = json("./samples/payments.expected.json");
  const staged = stage(sample.rows, mappings.payments);
  assert.deepEqual(staged.rejected, [], "no sample row may be rejected");
  const actual = Object.fromEntries(paymentFacts(staged.rows, mappings.payments).map((p) => [p.payment_id, p.amount_cents.toString()]));
  assert.deepEqual(actual, expected);
});

test("joins preserve totals when an order has several payments and shipments", () => {
  // Join logic is tested with fixed mappings so it does not depend on how the feeds are currently encoded.
  const str = (from) => ({ from, as: "string" });
  const fixed = {
    orders: { source: "orders", keys: ["order_id"], fields: { order_id: str("order_id"), order_total_cents: { from: "order_total", as: "dollars_to_cents" }, currency: str("currency"), quantity: { from: "quantity", as: "integer" } } },
    payments: { source: "payments", keys: ["payment_id"], refund_convention: "negative_amount", fields: { payment_id: str("payment_id"), order_id: str("order_id"), amount_cents: { from: "payment_amount", as: "dollars_to_cents" }, currency: str("currency"), kind: str("kind") } },
    shipping: { source: "shipping", keys: ["shipment_id"], fields: { shipment_id: str("shipment_id"), order_id: str("order_id"), status: str("status") } },
  };
  const out = runPipeline(
    {
      orders: [{ order_id: "O-1", customer_id: "C-1", order_total: 30, currency: "USD", quantity: 1, customer_region: null, ordered_at: "t" }],
      payments: [
        { payment_id: "P-1", order_id: "O-1", payment_amount: 10, currency: "USD", kind: "payment", paid_at: "t" },
        { payment_id: "P-2", order_id: "O-1", payment_amount: 20, currency: "USD", kind: "payment", paid_at: "t" },
      ],
      shipping: [
        { shipment_id: "S-1", order_id: "O-1", carrier: "UPS", status: "delivered", shipped_at: "t" },
        { shipment_id: "S-2", order_id: "O-1", carrier: "UPS", status: "delivered", shipped_at: "t" },
      ],
    },
    fixed,
  );
  assert.equal(out.order_facts.length, 1);
  assert.equal(out.dashboards.revenue["collected_cents.USD"], 3000n);
  assert.equal(out.dashboards.finance["net_revenue_cents.USD"], 3000n);
  assert.equal(out.dashboards.operations.orders_delivered, 1n);
});
