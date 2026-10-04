'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../lib/store');
const { createServer } = require('../server');

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-box-'));
  const store = await new Store(dir).init();
  const server = createServer(store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const opts = { method, headers };
    if (body !== undefined) {
      opts.body = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      if (!headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(base + p, opts);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { dir, store, server, base, call, stop: () => new Promise((r) => server.close(r)) };
}

test('create, search, update and delete a recipe', async (t) => {
  const s = await startServer();
  t.after(s.stop);

  const created = await s.call('POST', '/api/recipes', {
    title: 'Tomato Soup', ingredients: 'tomatoes\n\nsalt', tags: 'Soup, quick, soup', evil: 'ignored',
  });
  assert.strictEqual(created.status, 201);
  assert.deepStrictEqual(created.json.ingredients, ['tomatoes', 'salt']);
  assert.deepStrictEqual(created.json.tags, ['soup', 'quick']);
  assert.strictEqual(created.json.evil, undefined);
  const id = created.json.id;

  await s.call('POST', '/api/recipes', { title: 'Pancakes', tags: ['breakfast'] });

  assert.strictEqual((await s.call('GET', '/api/recipes')).json.length, 2);
  assert.deepStrictEqual((await s.call('GET', '/api/recipes?q=salt')).json.map((r) => r.title), ['Tomato Soup']);
  assert.deepStrictEqual((await s.call('GET', '/api/recipes?tag=breakfast')).json.map((r) => r.title), ['Pancakes']);

  const updated = await s.call('PUT', `/api/recipes/${id}`, { favorite: true, rating: 9 });
  assert.strictEqual(updated.json.favorite, true);
  assert.strictEqual(updated.json.rating, 5);
  assert.strictEqual(updated.json.title, 'Tomato Soup');
  assert.deepStrictEqual((await s.call('GET', '/api/recipes?favorite=1')).json.map((r) => r.id), [id]);

  const tags = (await s.call('GET', '/api/tags')).json;
  assert.deepStrictEqual(tags.map((x) => x.name).sort(), ['breakfast', 'quick', 'soup']);

  // Data survives a restart.
  const reloaded = await new Store(s.dir).init();
  assert.strictEqual(reloaded.get(id).favorite, true);

  assert.strictEqual((await s.call('DELETE', `/api/recipes/${id}`)).status, 204);
  assert.strictEqual((await s.call('GET', `/api/recipes/${id}`)).status, 404);
});

test('upload, serve and delete attachments', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { json: r } = await s.call('POST', '/api/recipes', { title: 'Scanned card' });

  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const up = await s.call('POST', `/api/recipes/${r.id}/files`, png, {
    'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('Omas Karte.png'),
  });
  assert.strictEqual(up.status, 201);
  assert.strictEqual(up.json.name, 'Omas Karte.png');
  assert.strictEqual(up.json.size, png.length);

  const file = await fetch(`${s.base}/files/${up.json.id}`);
  assert.strictEqual(file.headers.get('content-type'), 'image/png');
  assert.match(file.headers.get('content-security-policy'), /sandbox/);
  assert.deepStrictEqual(Buffer.from(await file.arrayBuffer()), png);

  // HTML uploads are never served as HTML.
  const html = await s.call('POST', `/api/recipes/${r.id}/files`, '<script>alert(1)</script>', {
    'Content-Type': 'text/html', 'X-Filename': 'x.html',
  });
  const served = await fetch(`${s.base}/files/${html.json.id}`);
  assert.strictEqual(served.headers.get('content-type'), 'application/octet-stream');
  assert.match(served.headers.get('content-disposition'), /^attachment/);

  // Range requests (video seeking).
  const ranged = await fetch(`${s.base}/files/${up.json.id}`, { headers: { Range: 'bytes=2-4' } });
  assert.strictEqual(ranged.status, 206);
  assert.strictEqual(Buffer.from(await ranged.arrayBuffer()).length, 3);

  assert.strictEqual((await s.call('DELETE', `/api/recipes/${r.id}/files/${up.json.id}`)).status, 204);
  assert.strictEqual((await fetch(`${s.base}/files/${up.json.id}`)).status, 404);
  assert.ok(!fs.existsSync(path.join(s.dir, 'files', up.json.id)));
});

test('backup export and restore round-trips recipes and files', async (t) => {
  const a = await startServer();
  t.after(a.stop);
  const { json: r } = await a.call('POST', '/api/recipes', { title: 'Backup me', ingredients: ['1 egg'] });
  await a.call('POST', `/api/recipes/${r.id}/files`, 'hello', { 'Content-Type': 'text/plain', 'X-Filename': 'note.txt' });
  const backup = await a.call('GET', '/api/export');
  assert.match(backup.headers.get('content-disposition'), /recipe-box-backup/);

  const b = await startServer();
  t.after(b.stop);
  const restored = await b.call('POST', '/api/import/backup', backup.text);
  assert.deepStrictEqual(restored.json, { imported: 1 });
  const [copy] = (await b.call('GET', '/api/recipes')).json;
  assert.strictEqual(copy.title, 'Backup me');
  assert.strictEqual(copy.attachments.length, 1);
  const file = await fetch(`${b.base}/files/${copy.attachments[0].id}`);
  assert.strictEqual(await file.text(), 'hello');
});

test('text import endpoint and URL import validation', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const text = await s.call('POST', '/api/import/text', { text: 'Toast\nIngredients\n1 slice bread\nSteps\nToast it.' });
  assert.strictEqual(text.json.title, 'Toast');
  assert.deepStrictEqual(text.json.instructions, ['Toast it.']);

  const bad = await s.call('POST', '/api/import/url', { url: 'file:///etc/passwd' });
  assert.strictEqual(bad.status, 400);
  const local = await s.call('POST', '/api/import/url', { url: 'http://127.0.0.1:1/' });
  assert.strictEqual(local.status, 400);
});

test('static files and client routes are served, traversal is not', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  for (const p of ['/', '/new', '/settings', '/recipe/abc123', '/share?url=x']) {
    const res = await s.call('GET', p);
    assert.strictEqual(res.status, 200, p);
    assert.match(res.text, /<title>Recipe Box<\/title>/);
  }
  assert.strictEqual((await s.call('GET', '/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.notStrictEqual((await s.call('GET', '/..%2fserver.js')).status, 200);
  assert.strictEqual((await s.call('GET', '/files/../../server.js')).status, 404);
});

test('every saved recipe gets the same formatting', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const { json } = await s.call('POST', '/api/recipes', {
    title: 'BROWNIES | Chefkoch.de',
    ingredients: ['- 200g Mehl', 'Zucker: 100 g', 'Für den Teig:'],
    instructions: ['1. ofen vorheizen', 'Schritt 2: 25 Min. backen'],
    servings: 'für 4 Personen', cookTime: '90 Min.',
  });
  assert.strictEqual(json.title, 'Brownies');
  assert.deepStrictEqual(json.ingredients, ['200 g Mehl', '100 g Zucker', '## Für den Teig']);
  assert.deepStrictEqual(json.instructions, ['Ofen vorheizen.', '25 Min. backen.']);
  assert.strictEqual(json.servings, '4 Personen');
  assert.strictEqual(json.cookTime, '1 h 30 min');

  const draft = await s.call('POST', '/api/import/text', { text: 'Soup\nServes 2\nIngredients\n1 l stock\nMethod\n1. simmer for 20 minutes' });
  assert.strictEqual(draft.json.servings, '2 people');
  assert.deepStrictEqual(draft.json.instructions, ['Simmer for 20 minutes.']);
});

test('reading with Claude is reported as off without an API key', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; });
  if (!process.env.ANTHROPIC_AUTH_TOKEN) {
    assert.deepStrictEqual((await s.call('GET', '/api/config')).json, { ai: false });
    const res = await s.call('POST', '/api/ai/extract', { text: 'Toast' });
    assert.strictEqual(res.status, 503);
  }
});

test('language setting is saved', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  assert.deepStrictEqual((await s.call('GET', '/api/settings')).json, { language: null, autoTranslate: true });
  assert.strictEqual((await s.call('PUT', '/api/settings', { language: 'fr' })).json.language, 'fr');
  assert.strictEqual((await s.call('PUT', '/api/settings', { language: 'xx' })).json.language, 'fr');
  const reloaded = await new Store(s.dir).init();
  assert.strictEqual(reloaded.getSettings().language, 'fr');
});

test('translating keeps the original and can restore it', async (t) => {
  const ai = require('../lib/ai');
  const real = ai.translateRecipe;
  let calls = 0;
  ai.translateRecipe = async (recipe, to) => {
    calls++;
    assert.strictEqual(to, 'en');
    return {
      sourceLanguage: 'de', title: 'Sugar-free brownies', description: '', servings: '12 pieces', prepTime: '', cookTime: '25 min', totalTime: '',
      ingredients: ['200 g dates', '2 eggs'], instructions: ['Bake for 25 minutes.'], notes: '', tags: ['baking'],
    };
  };
  t.after(() => { ai.translateRecipe = real; });
  const s = await startServer();
  t.after(s.stop);

  const { json: r } = await s.call('POST', '/api/recipes', {
    title: 'Zuckerfreie Brownies', ingredients: ['200 g Datteln', '2 Eier'], instructions: ['25 Minuten backen.'], servings: '12 Stück', tags: ['backen'],
  });
  const tr = await s.call('POST', `/api/recipes/${r.id}/translate`, { to: 'en' });
  assert.strictEqual(tr.status, 200);
  assert.strictEqual(tr.json.title, 'Sugar-free brownies');
  assert.deepStrictEqual(tr.json.ingredients, ['200 g dates', '2 eggs']);
  assert.strictEqual(tr.json.lang, 'en');
  assert.strictEqual(tr.json.original.lang, 'de');
  assert.strictEqual(tr.json.original.title, 'Zuckerfreie Brownies');

  // Already English: no second call to Claude.
  await s.call('POST', `/api/recipes/${r.id}/translate`, { to: 'en' });
  assert.strictEqual(calls, 1);

  // Editing keeps the original copy.
  const edited = await s.call('PUT', `/api/recipes/${r.id}`, { favorite: true });
  assert.strictEqual(edited.json.original.title, 'Zuckerfreie Brownies');

  // The original survives a backup round trip.
  const backup = await s.call('GET', '/api/export');
  const s2 = await startServer();
  t.after(s2.stop);
  await s2.call('POST', '/api/import/backup', backup.text);
  const [copy] = (await s2.call('GET', '/api/recipes')).json;
  assert.strictEqual(copy.original.title, 'Zuckerfreie Brownies');

  const back = await s.call('POST', `/api/recipes/${r.id}/original`);
  assert.strictEqual(back.json.title, 'Zuckerfreie Brownies');
  assert.strictEqual(back.json.lang, 'de');
  assert.strictEqual(back.json.original, undefined);
  assert.strictEqual(back.json.favorite, true);
});

test('translation without Claude explains what is missing', async (t) => {
  const s = await startServer();
  t.after(s.stop);
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; });
  if (process.env.ANTHROPIC_AUTH_TOKEN) return;
  const { json: r } = await s.call('POST', '/api/recipes', { title: 'Zuckerfreie Brownies', ingredients: ['200 g Datteln', '2 Eier'], instructions: ['Den Ofen vorheizen und 25 Minuten backen.'] });
  const res = await s.call('POST', `/api/recipes/${r.id}/translate`, { to: 'en' });
  assert.strictEqual(res.status, 503);
  // Same language needs no Claude at all.
  const same = await s.call('POST', `/api/recipes/${r.id}/translate`, { to: 'de' });
  assert.strictEqual(same.json.lang, 'de');
});
