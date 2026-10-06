'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Accounts } = require('../lib/accounts');
const { createServer } = require('../server');
const ai = require('../lib/ai');
const billing = require('../lib/billing');
const { priceMinor } = require('../lib/credits');

async function startHosted() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-box-hosted-'));
  const accounts = await new Accounts(dataDir).init();
  const server = createServer(null, { accounts, dataDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // A tiny browser: remembers the session cookie, sends the app's header.
  const browser = () => {
    let jar = '';
    return async (method, p, body, { header = true, raw } = {}) => {
      const headers = {};
      if (jar) headers.cookie = jar;
      if (header) headers['x-recipe-box'] = '1';
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(base + p, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
      const set = res.headers.get('set-cookie');
      if (set) jar = set.split(';')[0];
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json, text, setCookie: set };
    };
  };
  return { dataDir, base, browser, stop: () => new Promise((r) => server.close(r)) };
}

test('accounts keep each person’s recipes apart', async (t) => {
  const s = await startHosted();
  t.after(s.stop);
  const anna = s.browser();
  const ben = s.browser();
  assert.strictEqual((await anna('GET', '/api/recipes')).status, 401);
  const reg = await anna('POST', '/api/auth/register', { email: 'Anna@Example.ch', password: 'geheim123', country: 'CH' });
  assert.strictEqual(reg.status, 201);
  assert.match(reg.setCookie, /HttpOnly/);
  assert.strictEqual(reg.json.user.currency, 'CHF');
  await ben('POST', '/api/auth/register', { email: 'ben@example.de', password: 'passwort1', country: 'DE' });

  const { json: recipe } = await anna('POST', '/api/recipes', { title: 'Zürcher Geschnetzeltes' });
  await anna('POST', `/api/recipes/${recipe.id}/files`, undefined, { raw: 'hello' });
  assert.strictEqual((await ben('GET', '/api/recipes')).json.length, 0);
  assert.strictEqual((await ben('GET', `/api/recipes/${recipe.id}`)).status, 404);
  assert.strictEqual((await anna('GET', '/api/recipes')).json.length, 1);

  // Requests without the app's header are refused (protects against other sites).
  assert.strictEqual((await anna('POST', '/api/recipes', { title: 'x' }, { header: false })).status, 403);

  // Wrong password; then log out and back in.
  const bad = await s.browser()('POST', '/api/auth/login', { email: 'anna@example.ch', password: 'falsch' });
  assert.strictEqual(bad.status, 401);
  await anna('POST', '/api/auth/logout');
  assert.strictEqual((await anna('GET', '/api/recipes')).status, 401);
  assert.strictEqual((await anna('POST', '/api/auth/login', { email: 'anna@example.ch', password: 'geheim123' })).status, 200);
  assert.strictEqual((await anna('GET', '/api/recipes')).json[0].title, 'Zürcher Geschnetzeltes');
  const cfg = (await anna('GET', '/api/config')).json;
  assert.strictEqual(cfg.hosted, true);
  assert.strictEqual(cfg.user.email, 'anna@example.ch');
  assert.strictEqual(cfg.balance, 0);

  // Deleting the account removes the data.
  const userDir = path.join(s.dataDir, 'users', cfg.user.id);
  assert.ok(fs.existsSync(userDir));
  assert.strictEqual((await anna('POST', '/api/auth/delete', { password: 'falsch' })).status, 401);
  assert.strictEqual((await anna('POST', '/api/auth/delete', { password: 'geheim123' })).status, 200);
  assert.ok(!fs.existsSync(userDir));
  assert.strictEqual((await anna('POST', '/api/auth/login', { email: 'anna@example.ch', password: 'geheim123' })).status, 401);
});

test('credit: top up through Stripe, Claude actions are charged three times their cost', async (t) => {
  const Stripe = require('stripe');
  const real = new (Stripe.default || Stripe)('sk_test_dummy');
  const sessions = {};
  billing.deps.stripe = {
    checkout: { sessions: {
      create: async (p) => { const id = `cs_test_${Object.keys(sessions).length + 1}`; sessions[id] = { id, ...p, payment_status: 'unpaid', currency: p.line_items[0].price_data.currency, amount_total: p.line_items[0].price_data.unit_amount }; return { id, url: `https://checkout.stripe.com/pay/${id}` }; },
      retrieve: async (id) => sessions[id],
    } },
    webhooks: real.webhooks,
  };
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
  // Claude stand-in: a translation that "costs" $0.02.
  ai.deps.client = { beta: { messages: { create: async () => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 2500, output_tokens: 500 },
    content: [{ type: 'text', text: JSON.stringify({ sourceLanguage: 'de', title: 'Sliced veal Zurich style', description: '', servings: '', prepTime: '', cookTime: '', totalTime: '', ingredients: ['500 g veal'], instructions: ['Fry.'], notes: '', tags: [] }) }] }) } } };
  t.after(() => { billing.deps.stripe = null; ai.deps.client = null; delete process.env.STRIPE_WEBHOOK_SECRET; });

  const s = await startHosted();
  t.after(s.stop);
  const anna = s.browser();
  await anna('POST', '/api/auth/register', { email: 'anna@example.ch', password: 'geheim123', country: 'CH' });
  const { json: recipe } = await anna('POST', '/api/recipes', { title: 'Zürcher Geschnetzeltes', ingredients: ['500 g Kalbfleisch'], instructions: ['Das Fleisch anbraten und mit der Sahne verrühren.'] });

  // No credit yet: refused before Claude is called.
  const refused = await anna('POST', `/api/recipes/${recipe.id}/translate`, { to: 'en' });
  assert.strictEqual(refused.status, 402);
  assert.strictEqual(refused.json.code, 'no_credit');

  // Top up 10 CHF: checkout, then the payment goes through.
  const info = (await anna('GET', '/api/billing')).json;
  assert.deepStrictEqual(info.packs, [500, 1000, 2000]);
  assert.strictEqual((await anna('POST', '/api/billing/checkout', { amount: 777 })).status, 400);
  const checkout = await anna('POST', '/api/billing/checkout', { amount: 1000 });
  assert.match(checkout.json.url, /checkout\.stripe\.com/);
  const created = sessions[checkout.json.id];
  assert.strictEqual(created.price_data, undefined);
  assert.strictEqual(created.line_items[0].price_data.currency, 'chf');
  assert.strictEqual((await anna('POST', '/api/billing/confirm', { sessionId: checkout.json.id })).status, 402); // not paid yet
  created.payment_status = 'paid';

  // Stripe's webhook (signed) books it; coming back to the app books nothing twice.
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: created } });
  const unsigned = await fetch(`${s.base}/api/billing/webhook`, { method: 'POST', body: payload, headers: { 'stripe-signature': 't=1,v1=bad' } });
  assert.strictEqual(unsigned.status, 400);
  const sig = real.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_secret' });
  const hook = await fetch(`${s.base}/api/billing/webhook`, { method: 'POST', body: payload, headers: { 'stripe-signature': sig } });
  assert.strictEqual(hook.status, 200);
  const confirmed = await anna('POST', '/api/billing/confirm', { sessionId: checkout.json.id });
  assert.strictEqual(confirmed.json.added, false);
  assert.strictEqual(confirmed.json.balance, 1000);

  // Now the translation runs and costs 3x its Claude cost, in Rappen.
  const tr = await anna('POST', `/api/recipes/${recipe.id}/translate`, { to: 'en' });
  assert.strictEqual(tr.status, 200);
  assert.strictEqual(tr.json.title, 'Sliced veal Zurich style');
  const usd = (2500 * 4 + 500 * 20) / 1e6; // $0.02
  assert.strictEqual(tr.json.charged.amount, priceMinor(usd, 'CHF'));
  assert.strictEqual(tr.json.charged.balance, 1000 - priceMinor(usd, 'CHF'));
  const history = (await anna('GET', '/api/billing')).json.history;
  assert.deepStrictEqual(history.map((h) => h.type), ['charge', 'purchase']);

  // Someone else's payment can't be claimed.
  const ben = s.browser();
  await ben('POST', '/api/auth/register', { email: 'ben@example.ch', password: 'passwort1', country: 'CH' });
  assert.strictEqual((await ben('POST', '/api/billing/confirm', { sessionId: checkout.json.id })).status, 402);
});
