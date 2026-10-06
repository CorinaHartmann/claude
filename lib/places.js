'use strict';

// Where the user is and which supermarkets are nearby, from OpenStreetMap.
// Free services with fair-use rules: one request at a time, a real User-Agent,
// and results are cached so the same question isn't asked twice.

const USER_AGENT = 'RecipeBox/1.0 (self-hosted recipe app; https://github.com/CorinaHartmann/claude)';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
// Overpass servers with the same OpenStreetMap data. The main one is often
// overloaded (HTTP 504/429), so the others are tried in turn.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const deps = { fetch: (...a) => fetch(...a) }; // swapped out in tests
const cache = new Map();

class PlacesError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function getJson(url, opts = {}, timeoutMs = 20000) {
  let res;
  try {
    res = await deps.fetch(url, {
      ...opts,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(opts.headers || {}) },
    });
  } catch {
    throw new PlacesError(502, 'OpenStreetMap could not be reached. Check the internet connection and try again.');
  }
  if (res.status === 429 || res.status === 503 || res.status === 504) throw new PlacesError(503, 'OpenStreetMap is busy right now. Try again in a minute.');
  if (!res.ok) throw new PlacesError(502, `OpenStreetMap answered with HTTP ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new PlacesError(502, 'OpenStreetMap sent an unreadable answer. Try again in a minute.');
  }
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

// Postcodes have 5 digits in Germany and 4 in Austria and Switzerland.
const POSTCODE_DIGITS = { DE: 5, AT: 4, CH: 4 };

// Does a search hit carry this postcode? ("8001;8002" lists several.)
const hasPostcode = (hit, plz) => String(hit?.address?.postcode || '').split(/[;,\s]+/).includes(plz);

// "8001", "8001 Zürich", "Zürich" or "Hauptstraße 5, Köln" -> a place with coordinates.
// With a country, the search stays inside it. A postcode is looked up as a
// postcode (not as free text, which also matches house numbers and streets),
// and the result must really have that postcode.
async function geocode(query, lang = 'de', country = '') {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) throw new PlacesError(400, 'Enter a postcode or a town.');
  const cc = /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : '';
  const key = `geo:${lang}:${cc}:${q.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);

  const plz = (/(?:^|\D)(\d{4,5})(?!\d)/.exec(q) || [])[1] || '';
  const town = q.replace(plz, ' ').replace(/^[\s,-]+|[\s,-]+$/g, '').replace(/^(CH|AT|DE|A|D)-?\s*$/i, '');
  if (plz && POSTCODE_DIGITS[cc] && plz.length !== POSTCODE_DIGITS[cc]) {
    throw new PlacesError(400, cc === 'DE'
      ? 'German postcodes have 5 digits. For Switzerland or Austria, choose that country first.'
      : 'Postcodes in Switzerland and Austria have 4 digits. For Germany, choose Germany first.');
  }

  const base = `${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=10&accept-language=${encodeURIComponent(lang)}${cc ? `&countrycodes=${cc.toLowerCase()}` : ''}`;
  let hit = null;
  if (plz) {
    // 1. Structured postcode search (with the town, if one was typed).
    const structured = await getJson(`${base}&postalcode=${plz}${town && !/\d/.test(town) ? `&city=${encodeURIComponent(town)}` : ''}`);
    hit = (Array.isArray(structured) && (structured.find((h) => hasPostcode(h, plz)) || structured[0])) || null;
    // 2. Free text, but only accept a hit with exactly this postcode.
    if (!hit) {
      const free = await getJson(`${base}&q=${encodeURIComponent(q)}`);
      hit = (Array.isArray(free) && free.find((h) => hasPostcode(h, plz))) || null;
    }
    if (!hit) throw new PlacesError(404, 'This postcode could not be found. Check the postcode and the country.');
  } else {
    const hits = await getJson(`${base}&q=${encodeURIComponent(q)}`);
    hit = Array.isArray(hits) && hits[0];
    if (!hit) throw new PlacesError(404, 'That place could not be found. Try a postcode and town, e.g. "10115 Berlin".');
  }

  const place = placeFrom(hit);
  if (plz) {
    place.postcode = plz;
    // A postcode hit often has no town name; ask for the town at that point.
    if (!place.city) {
      try { place.city = (await reverseGeocode(place.lat, place.lon, lang)).city; } catch { /* the postcode alone will do */ }
    }
    if (!place.city && town && !/\d/.test(town)) place.city = town;
    place.label = [plz, place.city].filter(Boolean).join(' ');
  }
  if (!place.country && cc) place.country = cc;
  cache.set(key, place);
  return place;
}

// Browser location -> a place with a readable name. Zoom 18 (building level)
// so the answer includes the postcode of exactly this spot.
async function reverseGeocode(lat, lon, lang = 'de') {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new PlacesError(400, 'Invalid location');
  const url = `${NOMINATIM}/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=${encodeURIComponent(lang)}&lat=${lat}&lon=${lon}`;
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
  node["shop"="convenience"]["brand"~"^(Volg|Coop|Coop Pronto|Migrolino|Migros|Denner|Spar|Nah&Frisch|Billa|Unimarkt|ADEG)$",i](around:${radiusM},${place.lat},${place.lon});
  way["shop"="convenience"]["brand"~"^(Volg|Coop|Coop Pronto|Migrolino|Migros|Denner|Spar|Nah&Frisch|Billa|Unimarkt|ADEG)$",i](around:${radiusM},${place.lat},${place.lon});
);
out center tags 200;`;
  let data = null;
  let lastError = null;
  for (const server of OVERPASS) {
    try {
      data = await getJson(server, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      }, 30000);
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!data) {
    throw lastError?.status === 503 || lastError?.status === 502
      ? new PlacesError(503, 'The supermarket map (OpenStreetMap) is overloaded right now, so nearby supermarkets can\'t be shown. Try again in a few minutes.')
      : lastError;
  }
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
    const address = [[tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' '), [tags['addr:postcode'], tags['addr:city']].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const prev = byChain.get(chain.toLowerCase());
    if (!prev || km < prev.km) {
      byChain.set(chain.toLowerCase(), { chain, branch: tags.name || chain, address, km: Math.round(km * 10) / 10, lat, lon, count: (prev?.count || 0) + 1 });
    } else prev.count++;
  }
  const stores = [...byChain.values()].sort((a, b) => a.km - b.km).slice(0, 12);
  cache.set(key, stores);
  return stores;
}

module.exports = { geocode, reverseGeocode, nearbySupermarkets, distanceKm, PlacesError, deps, OVERPASS };
