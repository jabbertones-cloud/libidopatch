const STRIPE_ACCOUNT = "acct_1ReSk1KCahDryrU4";
const PRODUCT_ID = "prod_U4o7YNF5Vbt0Dm";
const TIERS = new Map([
  ["price_1TutBZKCahDryrU4trqDhyLV", { packs: 1, amount: 849, patches: 6 }],
  ["price_1TutBaKCahDryrU4ojkWGlii", { packs: 2, amount: 1499, patches: 12 }],
  ["price_1TutBaKCahDryrU4uiwr76LK", { packs: 3, amount: 1999, patches: 18 }],
  ["price_1TutBaKCahDryrU4Y4YxOsvr", { packs: 4, amount: 2499, patches: 24 }],
]);

const enc = new TextEncoder();
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function hex(bytes) { return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, "0")).join(""); }
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0;
}
async function sign(secret, value) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
}
export async function verifyStripeSignature(raw, header, secret, now = Math.floor(Date.now() / 1000)) {
  const parts = String(header || "").split(",").map(v => v.trim());
  const timestamp = Number(parts.find(v => v.startsWith("t="))?.slice(2) || 0);
  const signatures = parts.filter(v => v.startsWith("v1=")).map(v => v.slice(3));
  if (!timestamp || Math.abs(now - timestamp) > 300 || !signatures.length) return false;
  const expected = await sign(secret, `${timestamp}.${raw}`);
  return signatures.some(sig => safeEqual(sig, expected));
}

function shippingDetails(session) {
  return session?.collected_information?.shipping_details || session?.shipping_details || (session?.customer_details?.address ? { name: session.customer_details.name, address: session.customer_details.address } : null);
}

async function stripeGet(env, path) {
  const key = String(env.STRIPE_SECRET_KEY || "").trim();
  if (!key) throw new Error("stripe_secret_not_configured");
  const headers = { Authorization: `Bearer ${key}` };
  const account = String(env.STRIPE_ACCOUNT_ID || STRIPE_ACCOUNT).trim();
  if (account) headers["Stripe-Account"] = account;
  const res = await fetch(`https://api.stripe.com${path}`, { headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`stripe_http_${res.status}`);
  return body;
}

export async function processPaidSession(env, sessionId) {
  const session = await stripeGet(env, `/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items.data.price.product`);
  if (session.payment_status !== "paid") return { ignored: true, reason: "not_paid" };
  const line = session.line_items?.data?.[0];
  const priceId = String(line?.price?.id || "");
  const product = line?.price?.product || {};
  const tier = TIERS.get(priceId);
  if (!tier || String(product?.id || "") !== PRODUCT_ID || Number(line?.price?.unit_amount || 0) !== tier.amount) {
    throw new Error("libidopatch_price_identity_mismatch");
  }
  const shipping = shippingDetails(session);
  const address = shipping?.address || {};
  const email = String(session.customer_details?.email || session.customer_email || "").trim();
  const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : String(session.payment_intent?.id || "");
  if (!email || !paymentIntent || !address.line1 || !address.city || !address.state || !address.postal_code || !address.country) {
    throw new Error("libidopatch_checkout_snapshot_incomplete");
  }
  const quantity = Math.max(1, Number(line.quantity || 1));
  const title = String(product?.name || "CRAVE Patch");
  const sku = String(product?.metadata?.sku || "CRAVE-6");
  const payload = {
    brand: "libidopatch",
    storefront: "libidopatch.com",
    externalOrderId: session.id,
    orderNumber: `CRAVE-${String(session.id).slice(-8).toUpperCase()}`,
    placedAt: new Date(Number(session.created || 0) * 1000 || Date.now()).toISOString(),
    stripeSessionId: session.id,
    stripePaymentIntentId: paymentIntent,
    customerEmail: email,
    customerName: String(session.customer_details?.name || shipping?.name || ""),
    customerPhone: session.customer_details?.phone || null,
    currency: String(session.currency || "usd").toUpperCase(),
    subtotalCents: tier.amount * quantity,
    shippingCents: Number(session.total_details?.amount_shipping || 0),
    taxCents: Number(session.total_details?.amount_tax || 0),
    discountCents: Number(session.total_details?.amount_discount || 0),
    totalCents: Number(session.amount_total || tier.amount * quantity),
    shippingAddress: {
      name: String(shipping?.name || session.customer_details?.name || "") || undefined,
      line1: String(address.line1), line2: address.line2 ? String(address.line2) : null,
      city: String(address.city), state: String(address.state), postalCode: String(address.postal_code), country: String(address.country).slice(0, 2).toUpperCase(),
    },
    senderEmail: "shop@skynpatch.com",
    senderName: "CRAVE by SkynPatch",
    fulfillmentEmail: "shop@skynpatch.com",
    items: [{
      externalLineId: String(line.id || priceId), title,
      variantTitle: `${tier.packs} pack${tier.packs === 1 ? "" : "s"} / ${tier.patches} patches`,
      sku, quantity, unitPriceCents: tier.amount, totalPriceCents: tier.amount * quantity,
    }],
  };
  const token = String(env.STOREFRONT_ORDER_INGRESS_TOKEN || "").trim();
  if (!token) throw new Error("commerceos_ingress_not_configured");
  const res = await fetch(String(env.COMMERCE_OS_ORDER_INGRESS_URL || "https://commerce-os.smatdesigns.workers.dev/api/storefront-orders/paid"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": `libidopatch:${session.id}` },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body?.error || `commerceos_http_${res.status}`));
  return { ok: true, orderId: body.orderId, emails: body.emails };
}

export async function onRequestPost({ request, env }) {
  const raw = await request.text();
  const secret = String(env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!secret || !(await verifyStripeSignature(raw, request.headers.get("stripe-signature"), secret))) return json({ ok: false, error: "invalid_signature" }, 400);
  const event = JSON.parse(raw);
  if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) return json({ received: true, ignored: true });
  try {
    const result = await processPaidSession(env, event.data?.object?.id);
    return json({ received: true, ...result });
  } catch (error) {
    return json({ received: true, ok: false, error: error instanceof Error ? error.message : "processing_failed" }, 500);
  }
}
