import test from "node:test";
import assert from "node:assert/strict";
import { onRequestPost, processPaidSession, verifyStripeSignature } from "../functions/api/stripe-webhook.js";

async function stripeSig(body, secret, ts) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const out = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`));
  return [...new Uint8Array(out)].map(v=>v.toString(16).padStart(2,"0")).join("");
}

test("Stripe signature verification rejects stale and accepts valid signatures", async () => {
  const secret="whsec_test", body='{"id":"evt_1"}', ts=Math.floor(Date.now()/1000), sig=await stripeSig(body,secret,ts);
  assert.equal(await verifyStripeSignature(body,`t=${ts},v1=${sig}`,secret,ts),true);
  assert.equal(await verifyStripeSignature(body,`t=${ts-1000},v1=${sig}`,secret,ts),false);
});

test("paid CRAVE checkout forwards exact tier identity to CommerceOS", async () => {
  const calls=[]; const original=globalThis.fetch;
  globalThis.fetch=async (url,init={})=>{ calls.push([String(url),init]); if(String(url).includes("api.stripe.com")) return new Response(JSON.stringify({id:"cs_live_1",created:1700000000,payment_status:"paid",payment_intent:"pi_1",currency:"usd",amount_total:1499,total_details:{amount_shipping:0,amount_tax:0,amount_discount:0},customer_details:{email:"buyer@example.com",name:"Buyer"},shipping_details:{name:"Buyer",address:{line1:"1 Main",city:"Phoenix",state:"AZ",postal_code:"85001",country:"US"}},line_items:{data:[{id:"li_1",quantity:1,price:{id:"price_1TutBaKCahDryrU4ojkWGlii",unit_amount:1499,product:{id:"prod_U4o7YNF5Vbt0Dm",name:"CRAVE Patch",metadata:{sku:"CRAVE-6"}}}}]}}),{status:200}); return new Response(JSON.stringify({ok:true,orderId:"co_1",emails:{customer:{status:"sent"},pickPack:{status:"sent"}}}),{status:201}); };
  try { const result=await processPaidSession({STRIPE_SECRET_KEY:"sk_test",STOREFRONT_ORDER_INGRESS_TOKEN:"ingress"},"cs_live_1"); assert.equal(result.ok,true); const body=JSON.parse(calls[1][1].body); assert.equal(body.brand,"libidopatch"); assert.equal(body.items[0].variantTitle,"2 packs / 12 patches"); assert.equal(body.items[0].sku,"CRAVE-6"); assert.equal(body.items[0].totalPriceCents,1499); }
  finally { globalThis.fetch=original; }
});

test("webhook is replay-safe through stable external order identity", async () => {
  const secret="whsec_test", evt={id:"evt_1",type:"checkout.session.completed",data:{object:{id:"cs_replay"}}}, raw=JSON.stringify(evt), ts=Math.floor(Date.now()/1000), sig=await stripeSig(raw,secret,ts); let commerceBodies=[]; const original=globalThis.fetch;
  globalThis.fetch=async (url,init={})=>{ if(String(url).includes("api.stripe.com")) return new Response(JSON.stringify({id:"cs_replay",created:1700000000,payment_status:"paid",payment_intent:"pi_replay",currency:"usd",amount_total:849,total_details:{},customer_details:{email:"buyer@example.com",name:"Buyer"},shipping_details:{name:"Buyer",address:{line1:"1 Main",city:"Phoenix",state:"AZ",postal_code:"85001",country:"US"}},line_items:{data:[{id:"li_1",quantity:1,price:{id:"price_1TutBZKCahDryrU4trqDhyLV",unit_amount:849,product:{id:"prod_U4o7YNF5Vbt0Dm",name:"CRAVE Patch",metadata:{sku:"CRAVE-6"}}}}]}}),{status:200}); commerceBodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ok:true,orderId:"co_1",emails:{customer:{status:"sent"},pickPack:{status:"sent"}}}),{status:200}); };
  try { const req=()=>new Request("https://libidopatch.com/api/stripe-webhook",{method:"POST",headers:{"stripe-signature":`t=${ts},v1=${sig}`},body:raw}); await onRequestPost({request:req(),env:{STRIPE_WEBHOOK_SECRET:secret,STRIPE_SECRET_KEY:"sk",STOREFRONT_ORDER_INGRESS_TOKEN:"ingress"}}); await onRequestPost({request:req(),env:{STRIPE_WEBHOOK_SECRET:secret,STRIPE_SECRET_KEY:"sk",STOREFRONT_ORDER_INGRESS_TOKEN:"ingress"}}); assert.equal(commerceBodies.length,2); assert.equal(commerceBodies[0].externalOrderId,"cs_replay"); assert.equal(commerceBodies[1].externalOrderId,"cs_replay"); }
  finally { globalThis.fetch=original; }
});
