"use strict";
/**
 * Lean standard x402 v2 middleware — Solana mainnet USDC, self-settled via RPC
 * getTransaction (same rail as the 15 data servers; validated on 402 Index). An
 * `fnet_` Forge key bypasses. Shared verbatim across the FoundryNet gateways.
 */
const USDC_DECIMALS = 6;
const CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const PAY_TO = process.env.PAYMENT_RECIPIENT || "wUumjWJjfn27VQhTXd1jUNTzszCmsErkzaEeHWbLThd";
const USDC_MINT = process.env.PAYMENT_USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RPC = process.env.PAYMENT_VERIFY_RPC ||
  (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : "https://api.mainnet-beta.solana.com");
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const EXPIRY = parseInt(process.env.PAYMENT_EXPIRY_SECONDS || "300", 10);
const SERVICE = process.env.SERVICE_NAME || "foundrynet-gateway";

const usedTx = new Set();
const atomic = (p) => String(Math.round(p * 10 ** USDC_DECIMALS));
const intentFor = (route) => `fnet-${SERVICE}-${route}`.slice(0, 64);

function acceptsEntry(route, price, description) {
  const amount = atomic(price);
  return { scheme: "exact", network: CAIP2, amount, maxAmountRequired: amount, asset: USDC_MINT,
    payTo: PAY_TO, resource: `${PUBLIC_URL}/x402/${route}`, description, mimeType: "application/json",
    maxTimeoutSeconds: EXPIRY,
    extra: { feePayer: PAY_TO, networkName: "solana-mainnet", assetSymbol: "USDC", memo: intentFor(route) },
    outputSchema: { input: { type: "http", method: "POST" }, output: { type: "application/json" } } };
}
function paymentRequired(route, price, description, reason) {
  return { x402Version: 2, error: reason || "PAYMENT-SIGNATURE header is required",
    resource: { url: `${PUBLIC_URL}/x402/${route}`, description, mimeType: "application/json" },
    accepts: [acceptsEntry(route, price, description)],
    metadata: { name: SERVICE, network: "FoundryNet Data Network", homepage: "https://foundrynet.io" },
    extensions: {} };
}
const challengeHeader = (route, price, d) => Buffer.from(JSON.stringify(paymentRequired(route, price, d))).toString("base64");

async function verifySolana(tx, price, route) {
  if (!tx || usedTx.has(tx)) return false;
  const need = Math.round(price * 10 ** USDC_DECIMALS);
  try {
    const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction",
        params: [tx, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }] }) });
    const res = (await r.json())?.result;
    if (!res || (res.meta && res.meta.err != null)) return false;
    const meta = res.meta || {}; const pre = {};
    for (const b of meta.preTokenBalances || []) pre[b.accountIndex] = b;
    let delta = 0;
    for (const b of meta.postTokenBalances || []) {
      if (b.mint === USDC_MINT && b.owner === PAY_TO) {
        const post = parseInt(b.uiTokenAmount.amount, 10);
        const prev = parseInt((pre[b.accountIndex]?.uiTokenAmount?.amount) || "0", 10);
        delta = Math.max(delta, post - prev);
      }
    }
    if (delta < need) return false;
    if (!(meta.logMessages || []).join(" ").includes(intentFor(route))) return false;
    usedTx.add(tx); return true;
  } catch { return false; }
}

function x402(route, price, description) {
  return async (req, res, next) => {
    const auth = req.headers["authorization"] || "";
    const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
    if (bearer && bearer.startsWith("fnet_")) { req.billing = "api_key"; return next(); }
    const tx = req.headers["x-payment-tx"] || (req.body && req.body.payment_tx);
    const send402 = (reason) => {
      res.set("PAYMENT-REQUIRED", challengeHeader(route, price, description));
      res.set("WWW-Authenticate", 'x402 version="2"').set("Access-Control-Allow-Origin", "*");
      return res.status(402).json(paymentRequired(route, price, description, reason));
    };
    if (!tx) return send402();
    if (!(await verifySolana(tx, price, route))) return send402("Payment not verified on-chain.");
    req.billing = "paid"; return next();
  };
}
function gateForMcp(route, price, description, apiKey) {
  if (apiKey && String(apiKey).startsWith("fnet_")) return { paid: true, billing: "api_key" };
  return { paid: false, payment_required: paymentRequired(route, price, description,
    `Payment required ($${price}). Pass an fnet_ key as api_key, or pay via ${PUBLIC_URL}/v1/${route}.`) };
}
module.exports = { x402, gateForMcp, paymentRequired, acceptsEntry, PAY_TO, USDC_MINT, CAIP2, PUBLIC_URL };
