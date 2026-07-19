import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("checkout-prices.json", root), "utf8"));
const html = await readFile(new URL("index.html", root), "utf8");
const errors = [];

for (const tier of manifest.tiers) {
  const escapedUrl = tier.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cardPattern = new RegExp(
    `<a[^>]+data-packs="${tier.packs}"[^>]+data-price-id="${tier.priceId}"[^>]+data-amount="${tier.amount}"[^>]+href="${escapedUrl}"[^>]*>`
  );
  if (!cardPattern.test(html)) errors.push(`Pack ${tier.packs} does not bind its expected amount, Price ID, and Payment Link URL`);

  const response = await fetch(tier.url, { redirect: "manual" });
  if (response.status < 200 || response.status >= 400) errors.push(`${tier.url} returned HTTP ${response.status}`);
}

const apiKey = process.env.STRIPE_SECRET_KEY;
if (apiKey) {
  for (const tier of manifest.tiers) {
    const query = new URLSearchParams({ "expand[]": "line_items" });
    const response = await fetch(`https://api.stripe.com/v1/payment_links/${tier.paymentLinkId}?${query}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Stripe-Account": manifest.stripeAccount
      }
    });
    const link = await response.json();
    if (!response.ok) {
      errors.push(`${tier.paymentLinkId}: ${link.error?.message || `HTTP ${response.status}`}`);
      continue;
    }
    const line = link.line_items?.data?.[0];
    if (!link.active) errors.push(`${tier.paymentLinkId} is inactive`);
    if (line?.price?.id !== tier.priceId) errors.push(`${tier.paymentLinkId} uses ${line?.price?.id}, expected ${tier.priceId}`);
    if (line?.price?.unit_amount !== tier.amount) errors.push(`${tier.priceId} is ${line?.price?.unit_amount}, expected ${tier.amount}`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Verified ${manifest.tiers.length} fixed Stripe checkout tiers${apiKey ? " with the Stripe API" : " and public payment links"}.`);
}
