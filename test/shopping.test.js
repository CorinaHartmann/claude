'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../lib/store');
const { createServer } = require('../server');
const places = require('../lib/places');
const ai = require('../lib/ai');
const K = require('../public/recipe-kit');

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-box-shop-'));
  const store = await new Store(dir).init();
  const server = createServer(store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, json };
  };
  return { dir, call, stop: () => new Promise((r) => server.close(r)) };
}

test('ingredient lines are parsed for shopping', () => {
  assert.deepStrictEqual(K.parseIngredientLine('200 g Mehl, gesiebt'), { qty: 200, unit: 'g', name: 'Mehl' });
  assert.deepStrictEqual(K.parseIngredientLine('2–3 Eier'), { qty: 3, unit: '', name: 'Eier' });
  assert.deepStrictEqual(K.parseIngredientLine('Salz'), { qty: null, unit: '', name: 'Salz' });
  assert.deepStrictEqual(K.parseIngredientLine('250 g de farine'), { qty: 250, unit: 'g', name: 'farine' });
  assert.strictEqual(K.parseIngredientLine('## Für den Teig'), null);
  assert.strictEqual(K.formatAmount(1500, 'g'), '1½ kg');
  assert.strictEqual(K.formatAmount(1200, 'g'), '1200 g');
  assert.strictEqual(K.formatAmount(2000, 'ml'), '2 l');
  assert.strictEqual(K.formatAmount(2.5, ''), '2½');
  assert.strictEqual(K.formatAmount(1.2, 'cup'), '1.2 cup');
  assert.strictEqual(K.categorize('Knoblauchzehen'), 'produce');
  assert.strictEqual(K.categorize('Rinderhackfleisch'), 'meat');
  assert.strictEqual(K.categorize('lemons'), 'produce');
});

test('shopping list adds up amounts and keeps track of recipes', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  await s.call('POST', '/api/shopping/items', { lines: ['200 g Mehl', '2 Eier', '## Glasur', 'Salz'], source: { id: 'r1', title: 'Kuchen' } });
  const { json } = await s.call('POST', '/api/shopping/items', { lines: ['1 kg Mehl', '1 Ei', 'Salz'], source: { id: 'r2', title: 'Brot' } });
  const mehl = json.items.find((i) => i.key === 'mehl');
  assert.strictEqual(mehl.qty, 1200);
  assert.strictEqual(K.formatAmount(mehl.qty, mehl.unit), '1200 g');
  assert.deepStrictEqual(mehl.sources.map((x) => x.title), ['Kuchen', 'Brot']);
  assert.strictEqual(json.items.filter((i) => i.key === 'salz').length, 1);
  assert.strictEqual(json.items.length, 4); // Mehl, Eier, Salz, Ei (German plurals stay apart)

  // Ticking off, adding by hand, clearing what's done
  await s.call('PATCH', `/api/shopping/items/${mehl.id}`, { checked: true });
  const manual = await s.call('POST', '/api/shopping/items', { text: 'Spülmittel' });
  assert.strictEqual(manual.json.items.find((i) => i.name === 'Spülmittel').category, 'other');
  const cleared = await s.call('POST', '/api/shopping/clear', { checked: true });
  assert.ok(!cleared.json.items.some((i) => i.key === 'mehl'));
  // A new Mehl after the old one was bought starts fresh
  const again = await s.call('POST', '/api/shopping/items', { lines: ['100 g Mehl'] });
  assert.strictEqual(again.json.items.find((i) => i.key === 'mehl').qty, 100);

  // The list survives a restart
  const reloaded = await new Store(s.dir).init();
  assert.strictEqual(reloaded.shopping.get().items.length, again.json.items.length);
});

test('location, nearby supermarkets and price comparison', async (t) => {
  const realFetch = places.deps.fetch;
  const realCompare = ai.compareSupermarkets;
  t.after(() => { places.deps.fetch = realFetch; ai.compareSupermarkets = realCompare; });
  const asked = [];
  places.deps.fetch = async (url, opts) => {
    asked.push(url);
    assert.match(opts.headers['User-Agent'], /RecipeBox/);
    if (url.includes('/search')) {
      return new Response(JSON.stringify([{ lat: '52.53', lon: '13.38', address: { postcode: '10115', city: 'Berlin', country_code: 'de' } }]));
    }
    return new Response(JSON.stringify({ elements: [
      { lat: 52.531, lon: 13.381, tags: { shop: 'supermarket', brand: 'REWE', name: 'REWE City', 'addr:street': 'Chausseestraße', 'addr:housenumber': '1' } },
      { lat: 52.54, lon: 13.39, tags: { shop: 'supermarket', brand: 'REWE', name: 'REWE' } },
      { type: 'way', center: { lat: 52.535, lon: 13.385 }, tags: { shop: 'discount', brand: 'Lidl' } },
      { lat: 52.6, lon: 13.5, tags: { shop: 'supermarket', name: 'Bio Laden Müller' } },
    ] }));
  };
  let compareInput = null;
  ai.compareSupermarkets = async (input) => {
    compareInput = input;
    return { currency: 'EUR', stores: [{ chain: 'Lidl', total: 4.2, items: [], missing: [], note: '' }, { chain: 'REWE', total: 5.1, items: [], missing: [], note: '' }], cheapest: 'Lidl', summary: 'Lidl ist am günstigsten.', sources: [], searches: 3 };
  };

  const s = await startServer();
  t.after(s.stop);
  assert.strictEqual((await s.call('GET', '/api/shopping/stores')).status, 400);
  const loc = await s.call('POST', '/api/location', { query: '10115 Berlin' });
  assert.strictEqual(loc.json.location.label, '10115 Berlin');
  assert.strictEqual(loc.json.location.country, 'DE');

  const { json: near } = await s.call('GET', '/api/shopping/stores');
  assert.deepStrictEqual(near.stores.map((x) => x.chain), ['REWE', 'Lidl', 'Bio Laden Müller']);
  assert.strictEqual(near.stores[0].count, 2);
  assert.strictEqual(near.stores[0].address, 'Chausseestraße 1');

  await s.call('POST', '/api/shopping/items', { lines: ['200 g Mehl', '2 Eier'] });
  const cmp = await s.call('POST', '/api/shopping/compare');
  assert.strictEqual(cmp.json.cheapest, 'Lidl');
  assert.strictEqual(cmp.json.place, '10115 Berlin');
  assert.deepStrictEqual(compareInput.items, [{ name: 'Mehl', amount: '200 g' }, { name: 'Eier', amount: '2' }]);
  assert.strictEqual((await s.call('GET', '/api/shopping')).json.comparison.cheapest, 'Lidl');
});

test('comparison without Claude says what is missing', async (t) => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; });
  if (process.env.ANTHROPIC_AUTH_TOKEN) return;
  await assert.rejects(ai.compareSupermarkets({ items: [{ name: 'Mehl' }], place: {}, stores: [{ chain: 'Lidl', km: 1 }] }), (e) => e.status === 503);
});
