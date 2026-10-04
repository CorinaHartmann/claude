'use strict';

// Recipe Box server: a JSON API plus the static web app.
//   PORT               port to listen on            (default 3000)
//   HOST               interface to bind            (default 0.0.0.0 so phones on your Wi-Fi can reach it)
//   DATA_DIR           where recipes + files live   (default ./data)
//   ANTHROPIC_API_KEY  optional: lets Claude read recipes from photos and pasted text

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store } = require('./lib/store');
const importer = require('./lib/importer');
const ai = require('./lib/ai');
const { normalizeRecipe, detectLang, LANGUAGES } = require('./public/recipe-kit');

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
  if (rel === '/' || rel === '/share' || rel.startsWith('/recipe/') || rel === '/new' || rel === '/settings') rel = '/index.html';
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

async function handleApi(req, res, store, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const method = req.method;

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
      const result = await ai.translateRecipe(recipe, to);
      const from = LANGUAGES[result.sourceLanguage] ? result.sourceLanguage : null;
      if (from === to) return send(res, 200, await store.update(id, { lang: to }));
      const { sourceLanguage, ...fields } = result;
      return send(res, 200, await store.applyTranslation(id, fields, { from, to }));
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

  if (parts[0] === 'config' && method === 'GET') return send(res, 200, { ai: ai.isEnabled() });

  if (parts[0] === 'settings') {
    if (method === 'GET') return send(res, 200, store.getSettings());
    if (method === 'PUT') return send(res, 200, await store.updateSettings(await readJson(req)));
  }

  if (parts[0] === 'ai' && parts[1] === 'extract' && method === 'POST') {
    const body = await readJson(req, MAX_AI);
    return send(res, 200, draft({ ...(await ai.extractRecipe(body)), source: { type: body.images ? 'file' : 'text', url: '' } }));
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

function createServer(store) {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, 'Bad request');
    }
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, store, url);
      if (url.pathname.startsWith('/files/') && (req.method === 'GET' || req.method === 'HEAD')) {
        return serveFile(req, res, store, url.pathname.split('/')[2] || '');
      }
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
      return send(res, 405, 'Method not allowed');
    } catch (err) {
      const status = err.status || (err.name === 'TimeoutError' ? 504 : 500);
      if (status >= 500 && status !== 502 && status !== 504) console.error(err);
      const message = err.name === 'TimeoutError' ? 'The site took too long to respond'
        : err.cause && err.cause.code === 'ENOTFOUND' ? 'Could not find that website'
          : err.message || 'Something went wrong';
      if (!res.headersSent) send(res, status, { error: message });
      else res.end();
    }
  });
}

async function main() {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  const store = await new Store(dataDir).init();
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  createServer(store).listen(port, host, () => {
    console.log(`Recipe Box is running at http://localhost:${port}`);
    console.log(`Saving recipes to ${dataDir}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createServer };
