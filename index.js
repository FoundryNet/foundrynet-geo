"use strict";
/**
 * FoundryNet Geo — x402-gated geocoding gateway.
 *   POST /v1/geocode   $0.005  address↔lat/lng (Census + Nominatim)
 *   POST /v1/distance  $0.005  from/to → distance + duration estimate
 * Also exposes both as MCP tools at /mcp (Streamable HTTP).
 */
const express = require("express");
const { z } = require("zod");
const { x402, paymentRequired, PAY_TO, USDC_MINT, CAIP2, PUBLIC_URL } = require("./lib/x402");
const { mountMcp } = require("./lib/mcp");
const handlers = require("./lib/handlers");

const SERVICE = "foundrynet-geo";
const app = express();
app.use(express.json({ limit: "1mb" }));

const ROUTES = {
  geocode: { price: 0.005, desc: "Geocode an address ↔ lat/lng (Census + Nominatim)" },
  distance: { price: 0.005, desc: "Distance + duration estimate between two places" },
};
const TOOL_SPECS = [
  { name: "geocode", price: 0.005, desc: ROUTES.geocode.desc,
    schema: { address: z.string().optional(), lat: z.number().optional(), lng: z.number().optional(), api_key: z.string().optional() },
    fn: handlers.geocode },
  { name: "distance", price: 0.005, desc: ROUTES.distance.desc,
    schema: { from: z.string().describe("origin address"), to: z.string().describe("destination address"), api_key: z.string().optional() },
    fn: handlers.distance },
];
const KEYWORDS = ["geocoding", "geocode", "reverse-geocode", "address", "coordinates", "distance", "logistics", "delivery", "real-estate", "maps"];

app.get("/health", (req, res) => res.json({ status: "ok", service: SERVICE, tiers: Object.keys(ROUTES) }));

function discoveryIndex() {
  return { x402Version: 2, name: "FoundryNet Geo", description: "x402 geocoding + distance gateway.",
    network: "FoundryNet Data Network", asset: USDC_MINT, chain: CAIP2, payTo: PAY_TO,
    resources: Object.entries(ROUTES).map(([r, m]) => ({ tool: r, url: `${PUBLIC_URL}/x402/${r}`,
      price_usdc: m.price, amount: String(Math.round(m.price * 1e6)), description: m.desc, method: "POST" })) };
}
app.get("/x402", (req, res) => res.set("Access-Control-Allow-Origin", "*").json(discoveryIndex()));
app.get("/.well-known/x402", (req, res) => res.set("Access-Control-Allow-Origin", "*").json(discoveryIndex()));
app.get("/x402/:route", (req, res) => {
  const r = req.params.route;
  if (!ROUTES[r]) return res.status(404).json({ error: "unknown_resource", available: Object.keys(ROUTES) });
  res.set("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(paymentRequired(r, ROUTES[r].price, ROUTES[r].desc))).toString("base64"));
  res.set("WWW-Authenticate", 'x402 version="2"').set("Access-Control-Allow-Origin", "*");
  return res.status(402).json(paymentRequired(r, ROUTES[r].price, ROUTES[r].desc));
});

function restRoute(name, fn) {
  app.post(`/v1/${name}`, x402(name, ROUTES[name].price, ROUTES[name].desc), async (req, res) => {
    try { res.json({ billing: req.billing, ...(await fn(req.body || {})) }); }
    catch (e) { res.status(e.code === "bad_request" ? 400 : (e.code === "not_found" ? 404 : 502)).json({ error: `${name}_error`, detail: String(e.message || e).slice(0, 300) }); }
  });
}
restRoute("geocode", handlers.geocode);
restRoute("distance", handlers.distance);

mountMcp(app, SERVICE, TOOL_SPECS);

const AGENT_CARD = { name: "FoundryNet Geo", description: "x402 geocoding + distance gateway (Census + Nominatim).",
  url: `${PUBLIC_URL}/mcp`, transport: ["streamable-http"], tools: TOOL_SPECS.map((t) => t.name),
  pricing: { model: "per-call", currency: "USDC", rates: { geocode: 0.005, distance: 0.005 } },
  keywords: KEYWORDS, network: { name: "FoundryNet Data Network", homepage: "https://foundrynet.io" },
  provider: { name: "FoundryNet", url: "https://foundrynet.io" } };
const card = (req, res) => res.set("Access-Control-Allow-Origin", "*").set("Cache-Control", "public, max-age=300").json(AGENT_CARD);
app.get("/.well-known/mcp.json", card);
app.get("/agent-card.json", card);

app.listen(process.env.PORT || 3000, () => console.log(`${SERVICE} listening`));
module.exports = app;
