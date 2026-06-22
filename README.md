# FoundryNet Geo

x402-gated **geocoding + distance** gateway for AI agents. One call, one micropayment — no API keys, no accounts.

Part of the [FoundryNet Data Network](https://foundrynet.io). Pay-per-call in USDC (x402) or bypass with an `fnet_` Forge key. Also exposed as an MCP server so agents on Smithery/Glama/Claude can call it directly.

## Tools / Endpoints

| Tool / Route | Price | Description |
|--------------|-------|-------------|
| `geocode` — `POST /v1/geocode` | $0.005 | Address → `{lat, lng, formatted_address, components}`, or `{lat,lng}` → reverse-geocode |
| `distance` — `POST /v1/distance` | $0.005 | `{from, to}` → `{distance_km, duration_estimate}` |

Backends: **US Census Geocoder** (precise for US addresses) + **Nominatim / OpenStreetMap** (global) — both free and keyless.

## MCP

Streamable HTTP endpoint: `https://foundrynet-geo-production.up.railway.app/mcp`

```
claude mcp add --transport http foundrynet-geo https://foundrynet-geo-production.up.railway.app/mcp
```

Tools list without auth (discoverable). Pass an `fnet_` key as the `api_key` argument (or `Authorization: Bearer`) to bypass payment; otherwise the tool returns an x402 `payment_required` object.

## Payment (x402)

Standard x402 v2 on Solana mainnet USDC. Discovery: `GET /x402`, `GET /.well-known/x402`, and a per-route `402` at `GET /x402/{route}` (with the `PAYMENT-REQUIRED` header). Validated on [402 Index](https://402index.io).

For logistics, delivery, and real-estate agents that need geocoding at high frequency and low cost.
