'use strict';

// Recipe Box server: a JSON API plus the static web app.
//   PORT               port to listen on            (default 3000)
//   HOST               interface to bind            (default 0.0.0.0 so phones on your Wi-Fi can reach it)
//   DATA_DIR           where recipes + files live   (default ./data)
//   ANTHROPIC_API_KEY  optional: lets Claude read recipes from photos and pasted text
//
// Hosted version for several people (accounts + prepaid credit, see README):
//   MULTI_USER=1, PUBLIC_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, TRUST_PROXY=1 behind a proxy

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store } = require('./lib/store');
const importer = require('./lib/importer');
const ai = require('./lib/ai');
const places = require('./lib/places');
const billing = require('./lib/billing');
const { Accounts } = require('./lib/accounts');
const { Credits, PACKS, priceList, config: creditConfig } = require('./lib/credits');
const { normalizeRecipe, detectLang, LANGUAGES, formatAmount } = require('./public/recipe-kit');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD = 200 * 1024 * 1024;
const MAX_JSON = 2 * 1024 * 1024;
const MAX_BACKUP = 1024 * 1024 * 1024;
const MAX_AI = 40 * 1024 * 1024;

// Drafts from importers get the same formatting as saved recipes.
function draft(d) {
  const out = normalizeRecipe(d);
  if (!d.title) out.title = '';
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Types the browser can show inline without risk; everything else downloads.
const INLINE_SAFE = /^(image\/(png|jpe?g|gif|webp|avif|bmp|heic|heif)|application\/pdf|video\/|audio\/|text\/plain)/i;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request is too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = MAX_JSON) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  // Client-side routes all load the app shell.
  if (['/', '/share', '/new', '/settings', '/shopping', '/account', '/login'].includes(rel) || rel.startsWith('/recipe/')) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function serveFile(req, res, store, fileId) {
  const meta = store.findAttachment(fileId);
  const filePath = meta && store.filePath(fileId);
  if (!filePath) return send(res, 404, 'Not found');
  fs.stat(filePath, (err, stat) => {
    if (err) return send(res, 404, 'Not found');
    const inline = INLINE_SAFE.test(meta.type);
    const headers = {
      'Content-Type': inline ? meta.type : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Accept-Ranges': 'bytes',
    };
    // Uploaded files never get to run scripts in the app's origin. PDFs are
    // exempt because Chrome refuses to render a PDF inside a CSP sandbox.
    if (meta.type !== 'application/pdf') {
      headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";
    }
    // Range support so videos can seek.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, stat.size - 1);
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

// Run a Claude action: check the credit first (hosted version), then record and
// charge its measured cost, even when the action fails part-way.
async function withClaude(ctx, action, run) {
  await ctx.beforeAi(action);
  let cost = null;
  let billed = null;
  try {
    const result = await run((c) => { cost = c; });
    return { result, billed: cost ? (billed = await ctx.afterAi(action, cost)) : null };
  } finally {
    if (cost && !billed) await ctx.afterAi(action, cost);
  }
}

async function handleApi(req, res, ctx, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const method = req.method;
  const { store } = ctx;

  if (parts[0] === 'recipes') {
    const [, id, sub, fileId] = parts;
    if (!id) {
      if (method === 'GET') {
        return send(res, 200, store.list({
          q: url.searchParams.get('q') || '',
          tag: url.searchParams.get('tag') || '',
          favorite: url.searchParams.get('favorite') === '1',
        }));
      }
      if (method === 'POST') return send(res, 201, await store.create(await readJson(req)));
    } else if (!sub) {
      if (method === 'GET') {
        const r = store.get(id);
        return r ? send(res, 200, r) : send(res, 404, { error: 'Recipe not found' });
      }
      if (method === 'PUT' || method === 'PATCH') {
        const r = await store.update(id, await readJson(req));
        return r ? send(res, 200, r) : send(res, 404, { error: 'Recipe not found' });
      }
      if (method === 'DELETE') {
        return (await store.remove(id)) ? send(res, 204, '') : send(res, 404, { error: 'Recipe not found' });
      }
    } else if (sub === 'translate' && method === 'POST') {
      const recipe = store.get(id);
      if (!recipe) return send(res, 404, { error: 'Recipe not found' });
      const { to } = await readJson(req);
      if (!LANGUAGES[to]) throw new HttpError(400, 'Unknown language');
      // Nothing to do when we already know it's in that language.
      if ((recipe.lang || detectLang(recipe)) === to) {
        return send(res, 200, recipe.lang === to ? recipe : await store.update(id, { lang: to }));
      }
      const { result, billed } = await withClaude(ctx, 'translate', (onCost) => ai.translateRecipe(recipe, to, { onCost }));
      const from = LANGUAGES[result.sourceLanguage] ? result.sourceLanguage : null;
      if (from === to) return send(res, 200, { ...(await store.update(id, { lang: to })), ...billed });
      const { sourceLanguage, ...fields } = result;
      return send(res, 200, { ...(await store.applyTranslation(id, fields, { from, to })), ...billed });
    } else if (sub === 'original' && method === 'POST') {
      const restored = await store.restoreOriginal(id);
      return restored ? send(res, 200, restored) : send(res, 404, { error: 'This recipe has no original to go back to' });
    } else if (sub === 'files') {
      if (!fileId && method === 'POST') {
        if (!store.get(id)) return send(res, 404, { error: 'Recipe not found' });
        let name = 'file';
        try { name = decodeURIComponent(req.headers['x-filename'] || 'file'); } catch { /* keep default */ }
        const attachment = await store.addAttachment(id, req, {
          name,
          type: (req.headers['content-type'] || '').split(';')[0],
          maxBytes: MAX_UPLOAD,
        });
        return send(res, 201, attachment);
      }
      if (fileId && method === 'DELETE') {
        return (await store.removeAttachment(id, fileId)) ? send(res, 204, '') : send(res, 404, { error: 'File not found' });
      }
    }
  }

  if (parts[0] === 'tags' && method === 'GET') return send(res, 200, store.tags());


  if (parts[0] === 'usage' && method === 'GET') return send(res, 200, store.usage.summary());

  if (parts[0] === 'shopping') return handleShopping(req, res, ctx, parts.slice(1));

  if (parts[0] === 'location') {
    if (method === 'DELETE') return send(res, 200, await store.updateSettings({ location: null }));
    if (method === 'POST') {
      const body = await readJson(req);
      const lang = store.getSettings().language || 'de';
      const place = Number.isFinite(body.lat) && Number.isFinite(body.lon)
        ? await places.reverseGeocode(body.lat, body.lon, lang)
        : await places.geocode(body.query, lang, body.country);
      return send(res, 200, await store.updateSettings({ location: place }));
    }
  }

  if (parts[0] === 'settings') {
    if (method === 'GET') return send(res, 200, store.getSettings());
    if (method === 'PUT') return send(res, 200, await store.updateSettings(await readJson(req)));
  }

  if (parts[0] === 'ai' && parts[1] === 'extract' && method === 'POST') {
    const body = await readJson(req, MAX_AI);
    const { result, billed } = await withClaude(ctx, body.images ? 'read-photo' : 'read-text', (onCost) => ai.extractRecipe(body, { onCost }));
    return send(res, 200, { ...draft({ ...result, source: { type: body.images ? 'file' : 'text', url: '' } }), ...billed });
  }

  if (parts[0] === 'import' && method === 'POST') {
    if (parts[1] === 'url') {
      const { url: target } = await readJson(req);
      if (!target) throw new HttpError(400, 'Missing url');
      return send(res, 200, draft(await importer.importUrl(String(target))));
    }
    if (parts[1] === 'text') {
      const { text } = await readJson(req);
      return send(res, 200, draft(importer.parseText(text)));
    }
    if (parts[1] === 'backup') {
      const count = await store.importAll(await readJson(req, MAX_BACKUP));
      return send(res, 200, { imported: count });
    }
  }

  if (parts[0] === 'export' && method === 'GET') {
    const stamp = new Date().toISOString().slice(0, 10);
    return send(res, 200, await store.exportAll(), {
      'Content-Disposition': `attachment; filename="recipe-box-backup-${stamp}.json"`,
    });
  }

  return send(res, 404, { error: 'Unknown endpoint' });
}

async function handleShopping(req, res, ctx, parts) {
  const { store } = ctx;
  const list = store.shopping;
  const [what, id] = parts;
  const method = req.method;
  if (!what && method === 'GET') return send(res, 200, list.get());
  if (what === 'items' && !id && method === 'POST') {
    const body = await readJson(req);
    const lines = Array.isArray(body.lines) ? body.lines : [body.text];
    return send(res, 200, await list.add(lines.filter((l) => typeof l === 'string'), body.source));
  }
  if (what === 'items' && id && (method === 'PATCH' || method === 'PUT')) {
    const item = await list.update(id, await readJson(req));
    return item ? send(res, 200, item) : send(res, 404, { error: 'Item not found' });
  }
  if (what === 'items' && id && method === 'DELETE') {
    return (await list.remove(id)) ? send(res, 204, '') : send(res, 404, { error: 'Item not found' });
  }
  if (what === 'clear' && method === 'POST') {
    const { checked } = await readJson(req);
    return send(res, 200, await list.clear(Boolean(checked)));
  }
  const location = store.getSettings().location;
  if (what === 'stores' && method === 'GET') {
    if (!location) throw new HttpError(400, 'Set your location first.');
    return send(res, 200, { location, stores: await places.nearbySupermarkets(location) });
  }
  if (what === 'compare' && method === 'POST') {
    if (!location) throw new HttpError(400, 'Set your location first.');
    const open = list.open();
    // If the supermarket map is down, Claude works out the local chains itself.
    const stores = await places.nearbySupermarkets(location).catch(() => []);
    if (!open.length) throw new HttpError(400, 'The shopping list has nothing left to buy.');
    const { result, billed } = await withClaude(ctx, 'compare-prices', (onCost) => ai.compareSupermarkets({
      items: open.map((i) => ({ name: i.name, amount: formatAmount(i.qty, i.unit) })),
      place: location,
      stores,
      lang: store.getSettings().language || 'de',
      onCost,
    }));
    const comparison = {
      ...result,
      at: new Date().toISOString(),
      place: location.label,
      country: location.country,
      ...billed,
      itemKeys: open.map((i) => i.key),
      nearby: stores.map(({ chain, branch, address, km }) => ({ chain, branch, address, km })),
    };
    return send(res, 200, await list.setComparison(comparison));
  }
  return send(res, 404, { error: 'Unknown endpoint' });
}

// ---------- Hosted version: accounts, credit, Stripe ----------

function cookie(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
}

function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || '';
}

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const proto = process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'http';
  return `${proto}://${req.headers.host}`;
}

function sessionCookie(req, token, maxAge) {
  const secure = baseUrl(req).startsWith('https://') ? '; Secure' : '';
  return `rb_session=${token ? encodeURIComponent(token) : ''}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${token ? maxAge : 0}${secure}`;
}

async function handleAuth(req, res, hosted, action) {
  const { accounts } = hosted;
  const ip = clientIp(req);
  if (action === 'register' && req.method === 'POST') {
    const user = await accounts.register(await readJson(req), ip);
    const { token, maxAge } = await accounts.createSession(user);
    return send(res, 201, { user: accounts.publicUser(user) }, { 'Set-Cookie': sessionCookie(req, token, maxAge) });
  }
  if (action === 'login' && req.method === 'POST') {
    const user = await accounts.login(await readJson(req), ip);
    const { token, maxAge } = await accounts.createSession(user);
    return send(res, 200, { user: accounts.publicUser(user) }, { 'Set-Cookie': sessionCookie(req, token, maxAge) });
  }
  if (action === 'logout' && req.method === 'POST') {
    await accounts.endSession(cookie(req, 'rb_session'));
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '') });
  }
  if (action === 'delete' && req.method === 'POST') {
    const user = accounts.userForToken(cookie(req, 'rb_session'));
    if (!user) return send(res, 401, { error: 'Please log in.', code: 'login' });
    const { password } = await readJson(req);
    await accounts.remove(user.id, password);
    hosted.registry.delete(user.id);
    await fs.promises.rm(path.join(hosted.dataDir, 'users', user.id), { recursive: true, force: true });
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '') });
  }
  return send(res, 404, { error: 'Unknown endpoint' });
}

async function handleBilling(req, res, hosted, ctx, action) {
  const { user, credits } = ctx;
  if (!action && req.method === 'GET') {
    return send(res, 200, { ...credits.get(), packs: PACKS, prices: priceList(credits.currency), payments: billing.isEnabled() });
  }
  if (action === 'checkout' && req.method === 'POST') {
    const { amount, lang } = await readJson(req);
    if (!PACKS.includes(amount)) throw new HttpError(400, 'Choose one of the offered amounts.');
    return send(res, 200, await billing.createCheckout({ user, amountMinor: amount, currency: credits.currency, baseUrl: baseUrl(req), lang }));
  }
  if (action === 'confirm' && req.method === 'POST') {
    // Back from Stripe: book the payment right away instead of waiting for the webhook.
    const { sessionId } = await readJson(req);
    const paid = billing.creditFromSession(await billing.retrieveSession(sessionId));
    if (!paid || paid.userId !== user.id) throw new HttpError(402, 'The payment has not gone through (yet).');
    const added = await credits.add(paid.amountMinor, { type: 'purchase', ref: paid.ref });
    return send(res, 200, { ...credits.get(), added });
  }
  return send(res, 404, { error: 'Unknown endpoint' });
}

async function handleWebhook(req, res, hosted) {
  const raw = await readBody(req, MAX_JSON);
  const event = billing.verifyWebhook(raw, req.headers['stripe-signature']);
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const paid = billing.creditFromSession(event.data.object);
    const user = paid && hosted.accounts.findById(paid.userId);
    if (user) {
      const { credits } = await hosted.userContext(user);
      if (paid.currency === credits.currency) await credits.add(paid.amountMinor, { type: 'purchase', ref: paid.ref });
      else console.error(`Payment ${paid.ref} in ${paid.currency} does not match the account currency ${credits.currency}; not booked.`);
    }
  }
  return send(res, 200, { received: true });
}

// Single-user (self-hosted) context: no accounts, no charges, costs only logged.
function localContext(store) {
  return {
    store,
    user: null,
    credits: null,
    beforeAi: async () => {},
    afterAi: async (action, cost) => ({ costUsd: store.usage.record(action, cost).usd }),
  };
}

function createServer(store, options = {}) {
  const hosted = options.accounts ? { ...options, registry: new Map() } : null;
  if (hosted) {
    // Each account has its own folder: data/users/<id>/ with recipes, files, list, settings and credit.
    hosted.userContext = (user) => {
      if (!hosted.registry.has(user.id)) {
        hosted.registry.set(user.id, (async () => {
          const dir = path.join(hosted.dataDir, 'users', user.id);
          const userStore = await new Store(dir).init();
          const credits = await new Credits(dir, user.currency).init({ startCredit: creditConfig().startCredit });
          return {
            store: userStore,
            user,
            credits,
            beforeAi: async (action) => credits.ensureFor(action),
            afterAi: async (action, cost) => {
              userStore.usage.record(action, cost);
              const amount = await credits.charge(action, cost.usd);
              return { charged: { amount, currency: credits.currency, balance: credits.balance } };
            },
          };
        })());
      }
      return hosted.registry.get(user.id);
    };
  }
  const single = store ? localContext(store) : null;

  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, 'Bad request');
    }
    try {
      const { pathname } = url;
      let ctx = single;
      let user = null;
      if (hosted) {
        user = hosted.accounts.userForToken(cookie(req, 'rb_session'));
        if (pathname === '/api/billing/webhook' && req.method === 'POST') return await handleWebhook(req, res, hosted);
        // Changes must come from the app itself: browsers won't send this header cross-site without asking.
        if (pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method) && req.headers['x-recipe-box'] !== '1') {
          return send(res, 403, { error: 'Forbidden' });
        }
        if (pathname.startsWith('/api/auth/')) return await handleAuth(req, res, hosted, pathname.split('/')[3]);
        if (user) ctx = await hosted.userContext(user);
      }
      if (pathname === '/api/config' && req.method === 'GET') {
        return send(res, 200, {
          ai: ai.isEnabled(),
          hosted: Boolean(hosted),
          user: hosted ? hosted.accounts.publicUser(user) : null,
          payments: hosted ? billing.isEnabled() : false,
          currency: ctx?.credits?.currency || null,
          balance: ctx?.credits?.balance ?? null,
          prices: ctx?.credits ? priceList(ctx.credits.currency) : null,
        });
      }
      if (pathname.startsWith('/api/') || pathname.startsWith('/files/')) {
        if (!ctx) return send(res, 401, { error: 'Please log in.', code: 'login' });
      }
      if (hosted && pathname.startsWith('/api/billing')) return await handleBilling(req, res, hosted, ctx, pathname.split('/')[3]);
      if (pathname.startsWith('/api/')) return await handleApi(req, res, ctx, url);
      if (pathname.startsWith('/files/') && (req.method === 'GET' || req.method === 'HEAD')) {
        return serveFile(req, res, ctx.store, pathname.split('/')[2] || '');
      }
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
      return send(res, 405, 'Method not allowed');
    } catch (err) {
      const status = err.status || (err.name === 'TimeoutError' ? 504 : 500);
      if (status >= 500 && status !== 502 && status !== 503 && status !== 504) console.error(err);
      const message = err.name === 'TimeoutError' ? 'The site took too long to respond'
        : err.cause && err.cause.code === 'ENOTFOUND' ? 'Could not find that website'
          : err.message || 'Something went wrong';
      const extra = err.code && typeof err.code === 'string' && !err.code.startsWith('E') ? { code: err.code } : {};
      if (err.needed !== undefined) Object.assign(extra, { needed: err.needed, balance: err.balance, currency: err.currency });
      if (!res.headersSent) send(res, status, { error: message, ...extra });
      else res.end();
    }
  });
}

async function main() {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  let server;
  if (process.env.MULTI_USER === '1') {
    const accounts = await new Accounts(dataDir).init();
    server = createServer(null, { accounts, dataDir });
    console.log('Hosted version: accounts and prepaid credit are on.');
    if (!ai.isEnabled()) console.warn('No ANTHROPIC_API_KEY: Claude features are off.');
    if (!billing.isEnabled()) console.warn('No STRIPE_SECRET_KEY: users cannot top up credit.');
    if (!process.env.PUBLIC_URL) console.warn('PUBLIC_URL is not set; Stripe will send people back to the address they used.');
  } else {
    server = createServer(await new Store(dataDir).init());
  }
  server.listen(port, host, () => {
    console.log(`Recipe Box is running at http://localhost:${port}`);
    console.log(`Saving data to ${dataDir}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createServer };
