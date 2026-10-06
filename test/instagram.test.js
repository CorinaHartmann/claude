'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ig = require('../lib/instagram');
const { Store } = require('../lib/store');
const { createServer } = require('../server');

const CAPTION = 'Cremige Tomatenpasta in 15 Minuten 🍝🔥\n\n🛒 Zutaten (2 Personen):\n200 g Spaghetti\n1 Dose Tomaten\n2 Knoblauchzehen\n50 ml Sahne\n\n👩‍🍳 Zubereitung:\n1. Pasta kochen.\n2. Knoblauch anbraten, Tomaten dazu.\n3. Sahne unterrühren.\n\n#pasta #rezept #schnell';
const embedJson = (caption) => `<html><script>window.__x({"contextJSON":${JSON.stringify(JSON.stringify({ context: { media: { shortcode_media: { owner: { username: 'koch.mit.anna' }, display_url: 'https://scontent-zrh1-1.cdninstagram.com/v/pic.jpg?x=1', edge_media_to_caption: { edges: [{ node: { text: caption } }] } } } } }))}})</script></html>`;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

function fakeInstagram(t, pages) {
  const real = ig.deps.fetch;
  t.after(() => { ig.deps.fetch = real; });
  const seen = [];
  ig.deps.fetch = async (url, opts) => {
    seen.push({ url, ua: opts?.headers?.['User-Agent'] || '' });
    if (url.includes('cdninstagram.com')) return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
    for (const [match, body] of pages) if (url.includes(match)) return new Response(body, { status: body === null ? 404 : 200 });
    return new Response('<html>Login • Instagram</html>');
  };
  return seen;
}

test('instagram links are recognised and cleaned up', () => {
  assert.deepStrictEqual(ig.parseInstagramUrl('https://www.instagram.com/reel/DAbc_12-x/?igsh=MWx=='), { kind: 'reel', code: 'DAbc_12-x', url: 'https://www.instagram.com/reel/DAbc_12-x/' });
  assert.strictEqual(ig.parseInstagramUrl('https://instagram.com/koch.anna/p/Cxyz/').url, 'https://www.instagram.com/p/Cxyz/');
  assert.strictEqual(ig.parseInstagramUrl('https://www.instagram.com/koch.anna/'), null);
  assert.strictEqual(ig.parseInstagramUrl('https://example.com/reel/abc/'), null);
});

test('a recipe in the caption becomes a draft, with the picture kept as a file', async (t) => {
  const seen = fakeInstagram(t, [['/embed/captioned/', embedJson(CAPTION)]]);
  const r = await ig.importInstagram('https://www.instagram.com/reel/ABC/?igsh=1');
  assert.strictEqual(r.draft.title, 'Cremige Tomatenpasta in 15 Minuten');
  assert.deepStrictEqual(r.draft.ingredients, ['200 g Spaghetti', '1 Dose Tomaten', '2 Knoblauchzehen', '50 ml Sahne']);
  assert.deepStrictEqual(r.draft.instructions, ['Pasta kochen.', 'Knoblauch anbraten, Tomaten dazu.', 'Sahne unterrühren.']);
  assert.strictEqual(r.draft.servings, '2 Personen');
  assert.strictEqual(r.draft.videoUrl, 'https://www.instagram.com/reel/ABC/');
  assert.strictEqual(r.instagram.author, 'koch.mit.anna');
  assert.strictEqual(r.instagram.hasRecipe, true);
  assert.strictEqual(r.cover.type, 'image/jpeg');
  assert.deepStrictEqual(Buffer.from(r.cover.data, 'base64'), JPEG);
  assert.ok(seen[0].url.endsWith('/reel/ABC/embed/captioned/'));
});

test('falls back to the link preview, and explains captions without a recipe', async (t) => {
  const preview = '<meta property="og:description" content="1,204 likes, 33 comments - backfee on March 3, 2026: &quot;Das beste Bananenbrot 🍌 Rezept im Link in meiner Bio!&quot;. "><meta property="og:image" content="https://scontent.cdninstagram.com/b.jpg">';
  const seen = fakeInstagram(t, [['/embed/captioned/', null], ['/p/XYZ/', preview]]);
  const r = await ig.importInstagram('https://www.instagram.com/p/XYZ/');
  assert.ok(seen.some((s) => /facebookexternalhit/.test(s.ua)));
  assert.strictEqual(r.instagram.fetched, true);
  assert.strictEqual(r.instagram.hasRecipe, false);
  assert.strictEqual(r.instagram.linkInBio, true);
  assert.strictEqual(r.instagram.author, 'backfee');
  assert.deepStrictEqual(r.draft.ingredients, []);
  assert.match(r.draft.description, /Bananenbrot/);
  assert.ok(r.cover);

  assert.strictEqual(ig.analyseCaption('Kommentiere "REZEPT" und ich schicke dir das Rezept per DM 💌').viaComment, true);
});

test('when Instagram gives nothing away, the link is still saved', async (t) => {
  fakeInstagram(t, []);
  const r = await ig.importInstagram('https://www.instagram.com/reel/NOPE/');
  assert.strictEqual(r.instagram.fetched, false);
  assert.strictEqual(r.cover, null);
  assert.strictEqual(r.draft.source.url, 'https://www.instagram.com/reel/NOPE/');
});

test('pictures are only downloaded from Instagram’s own servers', async (t) => {
  const evil = embedJson('Hallo').replace('https://scontent-zrh1-1.cdninstagram.com/v/pic.jpg?x=1', 'http://192.168.1.1/x.jpg');
  const seen = fakeInstagram(t, [['/embed/captioned/', evil]]);
  const r = await ig.importInstagram('https://www.instagram.com/p/Q/');
  assert.strictEqual(r.cover, null);
  assert.ok(!seen.some((s) => s.url.includes('192.168')));
});

test('the import API answers Instagram links with the caption details', async (t) => {
  fakeInstagram(t, [['/embed/captioned/', embedJson(CAPTION)]]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-box-ig-'));
  const server = createServer(await new Store(dir).init());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/import/url`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://www.instagram.com/reel/ABC/' }),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.instagram.author, 'koch.mit.anna');
  assert.strictEqual(body.ingredients.length, 4);
  assert.strictEqual(body.source.type, 'video');
  assert.strictEqual(body.cover.type, 'image/jpeg');
});

test('titles leave out “recipe in bio” and emoji', () => {
  assert.strictEqual(ig.titleFrom('Das beste Bananenbrot 🍌 Rezept im Link in meiner Bio!', 'x'), 'Das beste Bananenbrot');
  assert.strictEqual(ig.titleFrom('Easy Tiramisu (recipe in bio) #dessert', 'x'), 'Easy Tiramisu');
  assert.strictEqual(ig.titleFrom('#reels @someone\n', 'koch.mit.anna'), 'Instagram · @koch.mit.anna');
});
