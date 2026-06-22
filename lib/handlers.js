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

module.exports = { geocode, distance };
