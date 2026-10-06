'use strict';

// Where the user is and which supermarkets are nearby, from OpenStreetMap.
// Free services with fair-use rules: one request at a time, a real User-Agent,
// and results are cached so the same question isn't asked twice.

const USER_AGENT = 'RecipeBox/1.0 (self-hosted recipe app; https://github.com/CorinaHartmann/claude)';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OVERPASS = 'https://overpass-api.de/api/interpreter';

const deps = { fetch: (...a) => fetch(...a) }; // swapped out in tests
const cache = new Map();

class PlacesError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function getJson(url, opts = {}) {
  let res;
  try {
    res = await deps.fetch(url, {
      ...opts,
      signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(opts.headers || {}) },
    });
  } catch {
    throw new PlacesError(502, 'OpenStreetMap could not be reached. Check the internet connection and try again.');
  }
  if (res.status === 429) throw new PlacesError(429, 'OpenStreetMap is busy right now. Try again in a minute.');
  if (!res.ok) throw new PlacesError(502, `OpenStreetMap answered with HTTP ${res.status}.`);
  return res.json();
}

function placeFrom(hit) {
  const a = hit.address || {};
  const city = a.city || a.town || a.village || a.municipality || a.suburb || '';
  return {
    lat: Number(hit.lat),
    lon: Number(hit.lon),
    city,
    postcode: a.postcode || '',
    country: (a.country_code || '').toUpperCase(),
    label: [a.postcode, city].filter(Boolean).join(' ') || hit.display_name?.split(',').slice(0, 2).join(',') || '',
  };
}

// "10115" or "Berlin" or "Hauptstraße 5, Köln" -> a place with coordinates.
async function geocode(query, lang = 'de') {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) throw new PlacesError(400, 'Enter a postcode or a town.');
  const key = `geo:${lang}:${q.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  const url = `${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=1&accept-language=${encodeURIComponent(lang)}&q=${encodeURIComponent(q)}`;
  const hits = await getJson(url);
  if (!Array.isArray(hits) || !hits.length) throw new PlacesError(404, 'That place could not be found. Try a postcode and town, e.g. "10115 Berlin".');
  const place = placeFrom(hits[0]);
  cache.set(key, place);
  return place;
}

// Browser location -> a place with a readable name.
async function reverseGeocode(lat, lon, lang = 'de') {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new PlacesError(400, 'Invalid location');
  const url = `${NOMINATIM}/reverse?format=jsonv2&addressdetails=1&zoom=14&accept-language=${encodeURIComponent(lang)}&lat=${lat}&lon=${lon}`;
  const hit = await getJson(url);
  if (!hit || hit.error) throw new PlacesError(404, 'No address found for this location.');
  return { ...placeFrom(hit), lat, lon };
}

function distanceKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Supermarkets within `radiusM` metres, one entry per chain (the nearest branch),
// plus independent shops by name. Sorted by distance.
async function nearbySupermarkets(place, radiusM = 3000) {
  const key = `shops:${place.lat.toFixed(3)},${place.lon.toFixed(3)}:${radiusM}`;
  if (cache.has(key)) return cache.get(key);
  const query = `[out:json][timeout:25];
(
  node["shop"~"^(supermarket|discount)$"](around:${radiusM},${place.lat},${place.lon});
  way["shop"~"^(supermarket|discount)$"](around:${radiusM},${place.lat},${place.lon});
);
out center tags 200;`;
  const data = await getJson(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
  });
  const byChain = new Map();
  for (const el of data.elements || []) {
    const tags = el.tags || {};
    const name = tags.brand || tags.name;
    if (!name) continue;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const km = distanceKm(place, { lat, lon });
    const chain = name.trim();
    const address = [[tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' '), tags['addr:city']].filter(Boolean).join(', ');
    const prev = byChain.get(chain.toLowerCase());
    if (!prev || km < prev.km) {
      byChain.set(chain.toLowerCase(), { chain, branch: tags.name || chain, address, km: Math.round(km * 10) / 10, lat, lon, count: (prev?.count || 0) + 1 });
    } else prev.count++;
  }
  const stores = [...byChain.values()].sort((a, b) => a.km - b.km).slice(0, 12);
  cache.set(key, stores);
  return stores;
}

module.exports = { geocode, reverseGeocode, nearbySupermarkets, distanceKm, PlacesError, deps };
