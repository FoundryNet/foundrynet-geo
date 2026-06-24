"use strict";
/** Geocoding backends — US Census Geocoder (keyless) + Nominatim/OSM (keyless, UA required). */

const UA = "foundrynet-geo/1.0 (https://foundrynet.io)";

async function censusGeocode(address) {
  const u = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  const j = await r.json().catch(() => ({}));
  const m = j?.result?.addressMatches?.[0];
  if (!m) return null;
  return { lat: m.coordinates.y, lng: m.coordinates.x, formatted_address: m.matchedAddress,
    components: m.addressComponents || {}, source: "census" };
}

async function nominatimSearch(address) {
  const u = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&addressdetails=1&limit=1`;
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  const j = await r.json().catch(() => []);
  const m = Array.isArray(j) ? j[0] : null;
  if (!m) return null;
  return { lat: parseFloat(m.lat), lng: parseFloat(m.lon), formatted_address: m.display_name,
    components: m.address || {}, source: "nominatim" };
}

async function nominatimReverse(lat, lng) {
  const u = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  const j = await r.json().catch(() => ({}));
  if (!j || j.error) return null;
  return { lat: parseFloat(j.lat), lng: parseFloat(j.lon), formatted_address: j.display_name,
    components: j.address || {}, source: "nominatim" };
}

async function geocode({ address, lat, lng }) {
  if (lat != null && lng != null) {
    const rev = await nominatimReverse(lat, lng);
    if (!rev) throw Object.assign(new Error("no result for coordinates"), { code: "not_found" });
    return rev;
  }
  if (!address || typeof address !== "string") throw Object.assign(new Error("address (string) or {lat,lng} required"), { code: "bad_request" });
  // Census first (precise for US), then Nominatim (global).
  let res = null;
  try { res = await censusGeocode(address); } catch { /* fall through */ }
  if (!res) { try { res = await nominatimSearch(address); } catch { /* fall through */ } }
  if (!res) throw Object.assign(new Error("no geocoding match"), { code: "not_found" });
  return res;
}

function haversineKm(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function distance({ from, to }) {
  if (!from || !to) throw Object.assign(new Error("from and to required"), { code: "bad_request" });
  const a = await geocode(typeof from === "string" ? { address: from } : from);
  const b = await geocode(typeof to === "string" ? { address: to } : to);
  const km = +haversineKm(a, b).toFixed(2);
  const drivingKm = +(km * 1.3).toFixed(1); // rough road-distance factor
  const mins = Math.round((drivingKm / 70) * 60);  // ~70 km/h avg
  return { distance_km: km, road_distance_km_est: drivingKm,
    duration_estimate: mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`,
    from: a, to: b };
}

// ── facility_risk (PAID) ──────────────────────────────────────────────────────
// Score any address for operational risk by geocoding it, then enriching with
// sibling FoundryNet servers (weather alerts, compliance jurisdiction). Every
// cross-server call is best-effort and fails open — enrichment never throws.

const WEATHER_ALERTS_URL = process.env.WEATHER_ALERTS_URL || "https://weather-intel-mcp-production.up.railway.app/v1/alerts";
const COMPLIANCE_SEARCH_URL = process.env.COMPLIANCE_SEARCH_URL || "https://compliance-mcp-production.up.railway.app/v1/search";

// Pull a 2-letter state code out of a Census/Nominatim component bag (best-effort).
function stateFrom(components) {
  if (!components || typeof components !== "object") return null;
  // Census uses {state: "NY"}; Nominatim uses {state: "New York", "ISO3166-2-lvl4": "US-NY"}.
  const iso = components["ISO3166-2-lvl4"];
  if (typeof iso === "string" && iso.includes("-")) return iso.split("-").pop().slice(0, 2).toUpperCase();
  const s = components.state;
  if (typeof s === "string" && s.length === 2) return s.toUpperCase();
  return typeof s === "string" ? s : null; // may be a full name; weather call uses lat/lng anyway
}

async function fetchJson(url, body, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify(body), signal: ctrl.signal });
    return await r.json().catch(() => null);
  } catch { return null; }
  finally { clearTimeout(t); }
}

async function facility_risk({ address }) {
  if (!address || typeof address !== "string") throw Object.assign(new Error("address (string) required"), { code: "bad_request" });
  let geo = null;
  try { geo = await geocode({ address }); } catch { geo = null; }
  if (!geo || geo.lat == null) return { error: `Could not geocode: ${address}` };
  const { lat, lng } = geo;
  const state = stateFrom(geo.components);

  let risk_score = 0;
  const risk_factors = [];

  // Weather risk (cross-server, free /v1/alerts; prefer lat/lng over state code).
  try {
    const wx = await fetchJson(WEATHER_ALERTS_URL, { latitude: lat, longitude: lng });
    const alerts = Array.isArray(wx?.alerts) ? wx.alerts.slice(0, 5) : [];
    for (const a of alerts) {
      risk_score += 10;
      risk_factors.push({ category: "weather", threat: a.event || "weather alert",
        severity: a.severity || "unknown", area: a.area });
    }
  } catch { /* fail-open */ }

  // Compliance jurisdiction (cross-server, best-effort; search_regulations is x402-gated,
  // so an unauthenticated call returns a blocked/payment_required body — we self-skip then).
  try {
    if (state) {
      const regs = await fetchJson(COMPLIANCE_SEARCH_URL, { keyword: state, days_back: 30 });
      const count = (regs && typeof regs.count === "number") ? regs.count
        : (Array.isArray(regs?.results) ? regs.results.length : null);
      if (count != null && count > 10) {
        risk_score += 15;
        risk_factors.push({ category: "regulatory",
          detail: `${count} regulatory actions in jurisdiction last 30 days`, severity: "elevated" });
      }
    }
  } catch { /* fail-open */ }

  risk_score = Math.min(100, risk_score);
  const risk_level = risk_score > 50 ? "high" : risk_score > 25 ? "moderate" : "low";
  const recommendation = risk_score > 50 ? "Multiple active risks — review operational continuity plan"
    : risk_score > 25 ? "Some risk factors present — monitor conditions"
    : "Low risk environment — standard operations";

  return { address, coordinates: { lat, lng }, state, risk_score, risk_level, risk_factors, recommendation };
}

module.exports = { geocode, distance, facility_risk };
