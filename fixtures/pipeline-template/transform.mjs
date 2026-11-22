// Warehouse transformations for the synthetic Orders / Payments / Shipping pipeline.
// Money is BigInt minor units end to end. No floating point arithmetic on amounts.

const DECIMAL = /^-?\d+(\.\d{1,2})?$/;
const INTEGER = /^-?\d+$/;

/** "12.34" or 12.34 dollars -> 1234n. A value already in cents is NOT detected here. */
export function dollarsToCents(value) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !DECIMAL.test(text)) throw new Error(`not a dollar amount: ${JSON.stringify(value)}`);
  const negative = text.startsWith("-");
  const [whole, frac = ""] = text.replace("-", "").split(".");
  const cents = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
  return negative ? -cents : cents;
}

/** Integer minor units -> BigInt, rejecting anything fractional. */
export function minorUnits(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && INTEGER.test(value)) return BigInt(value);
  throw new Error(`not integer minor units: ${JSON.stringify(value)}`);
}

export const CASTS = {
  string(v) {
    if (typeof v !== "string" || v === "") throw new Error(`expected non-empty string, got ${JSON.stringify(v)}`);
    return v;
  },
  optional_string(v) {
    if (v === null || v === undefined) return null;
    if (typeof v !== "string") throw new Error(`expected string or null, got ${JSON.stringify(v)}`);
    return v;
  },
  integer(v) {
    if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error(`expected integer, got ${JSON.stringify(v)}`);
    return v;
  },
  dollars_to_cents: dollarsToCents,
  minor_units: minorUnits,
};

export const REFUND_CONVENTIONS = ["negative_amount", "positive_amount_with_kind"];

export function validateMapping(mapping) {
  const problems = [];
  if (!mapping || typeof mapping.fields !== "object") return ["mapping has no fields"];
  for (const [target, spec] of Object.entries(mapping.fields)) {
    if (!("const" in spec) && typeof spec.from !== "string") problems.push(`${target}: needs "from" or "const"`);
    if (!("const" in spec) && !CASTS[spec.as]) problems.push(`${target}: unknown cast "${spec.as}"`);
  }
  for (const key of mapping.keys ?? []) if (!mapping.fields[key]) problems.push(`key "${key}" is not a mapped field`);
  if (!mapping.keys?.length) problems.push("mapping has no keys");
  if (mapping.refund_convention && !REFUND_CONVENTIONS.includes(mapping.refund_convention))
    problems.push(`unknown refund_convention "${mapping.refund_convention}"`);
  return problems;
}

/** Apply a source mapping. Rows that cannot be normalized are rejected, never guessed. */
export function stage(rows, mapping) {
  const problems = validateMapping(mapping);
  if (problems.length) throw new Error(`invalid ${mapping?.source} mapping: ${problems.join("; ")}`);
  const out = [];
  const rejected = [];
  const duplicates = [];
  const seen = new Set();
  rows.forEach((row, index) => {
    const canonical = {};
    try {
      for (const [target, spec] of Object.entries(mapping.fields)) {
        if ("const" in spec) {
          canonical[target] = spec.const;
          continue;
        }
        if (!(spec.from in row) && spec.as !== "optional_string") throw new Error(`source field "${spec.from}" is missing`);
        canonical[target] = CASTS[spec.as](row[spec.from]);
      }
    } catch (err) {
      rejected.push({ index, reason: `${err.message}` });
      return;
    }
    const key = mapping.keys.map((k) => String(canonical[k])).join("|");
    if (seen.has(key)) {
      duplicates.push(key);
      return;
    }
    seen.add(key);
    out.push(canonical);
  });
  return { rows: out, rejected, duplicates };
}

export function paymentFacts(stagedPayments, mapping) {
  const flip = mapping.refund_convention === "positive_amount_with_kind";
  return stagedPayments.map((p) => ({
    ...p,
    amount_cents: flip && p.kind === "refund" ? -p.amount_cents : p.amount_cents,
  }));
}

/** Payments are many-to-one with orders: aggregate to order grain BEFORE joining. */
export function paymentsByOrder(facts) {
  const byOrder = new Map();
  for (const p of facts) {
    const agg = byOrder.get(p.order_id) ?? { paid_cents: 0n, payments: 0 };
    agg.paid_cents += p.amount_cents;
    agg.payments += 1;
    byOrder.set(p.order_id, agg);
  }
  return byOrder;
}

/** Shipments are many-to-one with orders: one fulfillment row per order. */
export function fulfillmentFacts(stagedShipments) {
  const byOrder = new Map();
  for (const s of stagedShipments) {
    const agg = byOrder.get(s.order_id) ?? { order_id: s.order_id, shipments: 0, delivered_all: true };
    agg.shipments += 1;
    if (s.status !== "delivered") agg.delivered_all = false;
    byOrder.set(s.order_id, agg);
  }
  return byOrder;
}

export function orderFacts(stagedOrders, payByOrder, fulfillment) {
  return stagedOrders.map((o) => {
    const pay = payByOrder.get(o.order_id) ?? { paid_cents: 0n, payments: 0 };
    const ful = fulfillment.get(o.order_id);
    return {
      order_id: o.order_id,
      currency: o.currency,
      order_total_cents: o.order_total_cents,
      unit_price_cents: o.order_total_cents / BigInt(o.quantity),
      paid_cents: pay.paid_cents,
      payments: pay.payments,
      shipments: ful?.shipments ?? 0,
      shipped: Boolean(ful),
      delivered: Boolean(ful?.delivered_all),
    };
  });
}

function add(map, key, value) {
  map[key] = (map[key] ?? 0n) + value;
}

export function financeDashboard(facts) {
  const m = {};
  for (const p of facts) {
    add(m, `net_revenue_cents.${p.currency}`, p.amount_cents);
    add(m, `gross_payments_cents.${p.currency}`, p.kind === "refund" ? 0n : p.amount_cents);
    add(m, `refunds_cents.${p.currency}`, p.kind === "refund" ? -p.amount_cents : 0n);
    add(m, `payment_count.${p.currency}`, 1n);
  }
  return m;
}

export function revenueDashboard(orders) {
  const m = {};
  for (const o of orders) {
    add(m, `booked_cents.${o.currency}`, o.order_total_cents);
    add(m, `collected_cents.${o.currency}`, o.paid_cents);
    add(m, `outstanding_cents.${o.currency}`, o.order_total_cents - o.paid_cents);
    add(m, `orders.${o.currency}`, 1n);
  }
  return m;
}

export function operationsDashboard(orders) {
  const m = { orders: 0n, orders_shipped: 0n, orders_delivered: 0n, orders_unshipped: 0n };
  for (const o of orders) {
    m.orders += 1n;
    if (o.shipped) m.orders_shipped += 1n;
    else m.orders_unshipped += 1n;
    if (o.delivered) m.orders_delivered += 1n;
  }
  return m;
}

export function runPipeline(input, mappings) {
  let step = "staging";
  try {
    const orders = stage(input.orders, mappings.orders);
    const payments = stage(input.payments, mappings.payments);
    const shipments = stage(input.shipping, mappings.shipping);

    step = "payment_facts";
    const payFacts = paymentFacts(payments.rows, mappings.payments);
    const payByOrder = paymentsByOrder(payFacts);
    step = "fulfillment_facts";
    const fulfillment = fulfillmentFacts(shipments.rows);
    step = "order_facts";
    const ordFacts = orderFacts(orders.rows, payByOrder, fulfillment);

    step = "integrity";
    const orderIds = new Set(orders.rows.map((o) => o.order_id));
    const orphans = (rows, key) => rows.filter((r) => !orderIds.has(r.order_id)).map((r) => r[key]);
    const sumBy = (rows, field) => {
      const m = {};
      for (const r of rows) add(m, r.currency, r[field]);
      return m;
    };

    step = "dashboards";
    return {
      staging: {
        orders: { rows: orders.rows.length, rejected: orders.rejected, duplicates: orders.duplicates },
        payments: { rows: payments.rows.length, rejected: payments.rejected, duplicates: payments.duplicates },
        shipping: { rows: shipments.rows.length, rejected: shipments.rejected, duplicates: shipments.duplicates },
      },
      payment_facts: payFacts,
      order_facts: ordFacts,
      foreign_keys: {
        payments_without_order: orphans(payFacts, "payment_id"),
        shipments_without_order: orphans(shipments.rows, "shipment_id"),
      },
      grain: {
        orders: orders.rows.length,
        order_facts: ordFacts.length,
        paid_by_order_facts: sumBy(ordFacts, "paid_cents"),
        paid_by_payment_facts: sumBy(payFacts.filter((p) => orderIds.has(p.order_id)), "amount_cents"),
      },
      dashboards: {
        finance: financeDashboard(payFacts),
        revenue: revenueDashboard(ordFacts),
        operations: operationsDashboard(ordFacts),
      },
    };
  } catch (err) {
    err.step = err.step ?? step;
    throw err;
  }
}
