"use strict";
/**
 * FoundryNet Geo — Facility Risk Mapper. x402-gated geo + risk gateway.
 *   POST /v1/geocode        $0.005  address↔lat/lng (Census + Nominatim)
 *   POST /v1/distance       $0.005  from/to → distance + duration estimate
 *   POST /v1/facility-risk  $0.02   address → operational risk profile (weather + regulatory)
 * Also exposes all three as MCP tools at /mcp (Streamable HTTP).
 */
const express = require("express");
const { z } = require("zod");
const { x402, paymentRequired, PAY_TO, USDC_MINT, CAIP2, PUBLIC_URL } = require("./lib/x402");
const { mountMcp } = require("./lib/mcp");
const handlers = require("./lib/handlers");

const SERVICE = "foundrynet-geo";
const app = express();
app.use(express.json({ limit: "1mb" }));
// Point every response (esp. the 402 challenges) at the OpenAPI spec so x402scan auto-discovers it.
app.use((req, res, next) => { res.set("Link", '</openapi.json>; rel="describedby"'); next(); });

const ROUTES = {
  geocode: { price: 0.005, desc: "Geocode an address ↔ lat/lng (Census + Nominatim)" },
  distance: { price: 0.005, desc: "Distance + duration estimate between two places" },
  "facility-risk": { price: 0.02, desc: "Facility location risk profile (weather threats + regulatory activity) for any address" },
};
const TOOL_SPECS = [
  { name: "geocode", price: 0.005, desc: ROUTES.geocode.desc,
    schema: { address: z.string().optional(), lat: z.number().optional(), lng: z.number().optional(), api_key: z.string().optional() },
    fn: handlers.geocode },
  { name: "distance", price: 0.005, desc: ROUTES.distance.desc,
    schema: { from: z.string().describe("origin address"), to: z.string().describe("destination address"), api_key: z.string().optional() },
    fn: handlers.distance },
  { name: "facility_risk", price: 0.02, desc: ROUTES["facility-risk"].desc,
    schema: { address: z.string().describe("facility / site address to assess"), api_key: z.string().optional() },
    fn: handlers.facility_risk },
];
const KEYWORDS = ["geocoding", "geocode", "reverse-geocode", "address", "coordinates", "distance", "logistics", "delivery", "real-estate", "maps",
  "facility-risk", "location-assessment", "operational-risk", "site-evaluation", "supply-chain-location"];

app.get("/health", (req, res) => res.json({ status: "ok", service: SERVICE, tiers: Object.keys(ROUTES) }));

function discoveryIndex() {
  return { x402Version: 2, name: "FoundryNet Geo", description: "Facility location risk assessment — score any address for weather threats, regulatory activity, and operational risk factors. Also provides geocoding and distance calculations.",
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

// OpenAPI 3.1 discovery doc (x402scan indexes this). Describes the real POST /v1/* endpoints;
// the x402 gate fires before validation, so an empty-body probe returns 402, not 400.
app.get("/openapi.json", (req, res) => res.set("Access-Control-Allow-Origin", "*").set("Cache-Control", "public, max-age=300").json({
  openapi: "3.1.0",
  info: { title: "FoundryNet Geo", description: "Facility location risk assessment — score any address for weather threats, regulatory activity, and operational risk factors. Also provides geocoding and distance calculations.", version: "1.1.0", contact: { email: "foundrynet@proton.me" } },
  servers: [{ url: PUBLIC_URL }],
  paths: {
    "/v1/geocode": { post: { operationId: "geocode", summary: ROUTES.geocode.desc, "x-x402-price": "$0.005",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object",
        properties: { address: { type: "string", description: "Address to geocode (provide this OR lat+lng)" }, lat: { type: "number" }, lng: { type: "number" } } } } } },
      responses: { "200": { description: "Geocode result (lat/lng or reverse address)" }, "402": { description: "Payment required — x402 challenge" } } } },
    "/v1/distance": { post: { operationId: "distance", summary: ROUTES.distance.desc, "x-x402-price": "$0.005",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object",
        properties: { from: { type: "string", description: "Origin address" }, to: { type: "string", description: "Destination address" } }, required: ["from","to"] } } } },
      responses: { "200": { description: "Distance + duration estimate" }, "402": { description: "Payment required — x402 challenge" } } } },
    "/v1/facility-risk": { post: { operationId: "facility_risk", summary: ROUTES["facility-risk"].desc, "x-x402-price": "$0.02",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object",
        properties: { address: { type: "string", description: "Facility / site address to assess for operational risk" } }, required: ["address"] } } } },
      responses: { "200": { description: "Risk profile: risk_score, risk_level, risk_factors[], coordinates, recommendation" }, "402": { description: "Payment required — x402 challenge" } } } },
  },
}));

function restRoute(name, fn) {
  app.post(`/v1/${name}`, x402(name, ROUTES[name].price, ROUTES[name].desc), async (req, res) => {
    try { res.json({ billing: req.billing, ...(await fn(req.body || {})) }); }
    catch (e) { res.status(e.code === "bad_request" ? 400 : (e.code === "not_found" ? 404 : 502)).json({ error: `${name}_error`, detail: String(e.message || e).slice(0, 300) }); }
  });
}
restRoute("geocode", handlers.geocode);
restRoute("distance", handlers.distance);
restRoute("facility-risk", handlers.facility_risk);

mountMcp(app, SERVICE, TOOL_SPECS);

const AGENT_CARD = { name: "FoundryNet Geo", description: "Facility location risk assessment — score any address for weather threats, regulatory activity, and operational risk factors. Also provides geocoding and distance calculations.",
  url: `${PUBLIC_URL}/mcp`, transport: ["streamable-http"], tools: TOOL_SPECS.map((t) => t.name),
  pricing: { model: "per-call", currency: "USDC", rates: { geocode: 0.005, distance: 0.005, facility_risk: 0.02 } },
  keywords: KEYWORDS, network: { name: "FoundryNet Data Network", homepage: "https://foundrynet.io" },
  provider: { name: "FoundryNet", url: "https://foundrynet.io" } };
const card = (req, res) => res.set("Access-Control-Allow-Origin", "*").set("Cache-Control", "public, max-age=300").json(AGENT_CARD);
app.get("/.well-known/mcp.json", card);
app.get("/agent-card.json", card);

app.listen(process.env.PORT || 3000, () => console.log(`${SERVICE} listening`));
module.exports = app;
