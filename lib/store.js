'use strict';

// Recipes live in one JSON file; attachments live as files next to it.
// Writes go to a temp file and are renamed into place so a crash never
// leaves a half-written database behind.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { normalizeRecipe, LANGUAGES } = require('../public/recipe-kit');
const { ShoppingList } = require('./shopping');
const { UsageLog } = require('./usage');

const RECIPE_FIELDS = [
  'title', 'description', 'source', 'imageUrl', 'videoUrl', 'ingredients',
  'instructions', 'notes', 'tags', 'servings', 'prepTime', 'cookTime',
  'totalTime', 'favorite', 'rating', 'lang',
];

// The parts of a recipe that are written in a language (and get translated).
const TEXT_FIELDS = ['title', 'description', 'ingredients', 'instructions', 'notes', 'tags', 'servings', 'prepTime', 'cookTime', 'totalTime'];
const DEFAULT_SETTINGS = { language: null, autoTranslate: true, location: null };

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function cleanList(value) {
  if (!Array.isArray(value)) {
    if (typeof value !== 'string') return [];
    value = value.split('\n');
  }
  return value.map((v) => String(v).trim()).filter(Boolean);
}

function cleanTags(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = String(raw).trim().toLowerCase();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

function str(value, max = 20000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

// Accept whatever the client sends but only keep known fields in known shapes.
function sanitize(input, base = {}) {
  const out = { ...base };
  for (const key of RECIPE_FIELDS) {
    if (!(key in input)) continue;
    const v = input[key];
    switch (key) {
      case 'ingredients':
      case 'instructions':
        out[key] = cleanList(v);
        break;
      case 'tags':
        out[key] = cleanTags(v);
        break;
      case 'favorite':
        out[key] = Boolean(v);
        break;
      case 'rating': {
        const n = Math.round(Number(v));
        out[key] = Number.isFinite(n) ? Math.min(5, Math.max(0, n)) : 0;
        break;
      }
      case 'lang':
        out.lang = LANGUAGES[v] ? v : null;
        break;
      case 'source': {
        const s = v && typeof v === 'object' ? v : {};
        out.source = { type: str(s.type, 20) || 'manual', url: str(s.url, 2000) };
        break;
      }
      default:
        out[key] = str(v);
    }
  }
  // One house style, however the recipe arrived (see public/recipe-kit.js).
  return normalizeRecipe(out);
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.filesDir = path.join(dir, 'files');
    this.dbPath = path.join(dir, 'recipes.json');
    this.settingsPath = path.join(dir, 'settings.json');
    this.settings = { ...DEFAULT_SETTINGS };
    this.recipes = [];
    this.queue = Promise.resolve();
  }

  async init() {
    await fsp.mkdir(this.filesDir, { recursive: true });
    try {
      const raw = await fsp.readFile(this.dbPath, 'utf8');
      const parsed = JSON.parse(raw);
      this.recipes = Array.isArray(parsed.recipes) ? parsed.recipes : [];
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.recipes = [];
    }
    this.shopping = await new ShoppingList(this.dir).init();
    this.usage = await new UsageLog(this.dir).init();
    try {
      this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(await fsp.readFile(this.settingsPath, 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    }
    return this;
  }

  persist() {
    // Chain writes so two quick saves can't interleave.
    this.queue = this.queue.then(async () => {
      const tmp = `${this.dbPath}.${process.pid}.tmp`;
      const body = JSON.stringify({ version: 1, recipes: this.recipes }, null, 2);
      await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, this.dbPath);
    });
    return this.queue;
  }

  list({ q = '', tag = '', favorite = false } = {}) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return this.recipes
      .filter((r) => {
        if (favorite && !r.favorite) return false;
        if (tag && !(r.tags || []).includes(tag.toLowerCase())) return false;
        if (!terms.length) return true;
        const hay = [
          r.title, r.description, r.notes, (r.tags || []).join(' '),
          (r.ingredients || []).join(' '), (r.instructions || []).join(' '),
          (r.attachments || []).map((a) => a.name).join(' '),
        ].join(' ').toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  tags() {
    const counts = new Map();
    for (const r of this.recipes) {
      for (const t of r.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }));
  }

  get(id) {
    return this.recipes.find((r) => r.id === id) || null;
  }

  async create(input) {
    const now = new Date().toISOString();
    const recipe = sanitize(input, {
      id: newId(),
      title: '',
      description: '',
      source: { type: 'manual', url: '' },
      imageUrl: '',
      videoUrl: '',
      ingredients: [],
      instructions: [],
      notes: '',
      tags: [],
      servings: '',
      prepTime: '',
      cookTime: '',
      totalTime: '',
      favorite: false,
      rating: 0,
      attachments: [],
      createdAt: now,
      updatedAt: now,
    });
    if (!recipe.title) recipe.title = 'Untitled recipe';
    this.recipes.push(recipe);
    await this.persist();
    return recipe;
  }

  async update(id, input) {
    const idx = this.recipes.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    const updated = sanitize(input, this.recipes[idx]);
    if (!updated.title) updated.title = 'Untitled recipe';
    updated.updatedAt = new Date().toISOString();
    this.recipes[idx] = updated;
    await this.persist();
    return updated;
  }

  getSettings() {
    return { ...this.settings };
  }

  async updateSettings(input) {
    const next = { ...this.settings };
    if ('language' in input) next.language = LANGUAGES[input.language] ? input.language : next.language;
    if ('autoTranslate' in input) next.autoTranslate = Boolean(input.autoTranslate);
    if ('location' in input) {
      const l = input.location;
      next.location = l && Number.isFinite(l.lat) && Number.isFinite(l.lon)
        ? { lat: l.lat, lon: l.lon, label: str(l.label, 120), city: str(l.city, 80), postcode: str(l.postcode, 20), country: str(l.country, 2).toUpperCase() }
        : null;
    }
    this.settings = next;
    const tmp = `${this.settingsPath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2));
    await fsp.rename(tmp, this.settingsPath);
    return { ...next };
  }

  // Replace a recipe's text with a translation. The first time, the original
  // text is kept in recipe.original so it can always be shown or restored.
  async applyTranslation(id, translated, { from, to }) {
    const recipe = this.get(id);
    if (!recipe) return null;
    if (!recipe.original) {
      recipe.original = { lang: from || null };
      for (const k of TEXT_FIELDS) recipe.original[k] = recipe[k];
    }
    const fields = {};
    for (const k of TEXT_FIELDS) if (k in translated) fields[k] = translated[k];
    return this.update(id, { ...fields, lang: to });
  }

  // Put the original text back and forget the translation.
  async restoreOriginal(id) {
    const recipe = this.get(id);
    if (!recipe || !recipe.original) return null;
    const { lang, ...fields } = recipe.original;
    delete recipe.original;
    return this.update(id, { ...fields, lang });
  }

  async remove(id) {
    const recipe = this.get(id);
    if (!recipe) return false;
    this.recipes = this.recipes.filter((r) => r.id !== id);
    await this.persist();
    await Promise.all((recipe.attachments || []).map((a) => this.unlinkFile(a.id)));
    return true;
  }

  filePath(fileId) {
    if (!/^[a-f0-9]{16}$/.test(fileId)) return null;
    return path.join(this.filesDir, fileId);
  }

  async unlinkFile(fileId) {
    const p = this.filePath(fileId);
    if (p) await fsp.rm(p, { force: true });
  }

  // Stream an upload straight to disk, enforcing a size limit.
  async addAttachment(id, stream, { name, type, maxBytes }) {
    const recipe = this.get(id);
    if (!recipe) return null;
    const fileId = newId();
    const dest = this.filePath(fileId);
    let size = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          stream.destroy();
          out.destroy();
          const err = new Error(`File is larger than ${Math.round(maxBytes / 1e6)} MB`);
          err.status = 413;
          reject(err);
        }
      });
      stream.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      stream.pipe(out);
    }).catch(async (err) => {
      await fsp.rm(dest, { force: true });
      throw err;
    });
    const attachment = {
      id: fileId,
      name: str(name, 255) || 'file',
      type: str(type, 100) || 'application/octet-stream',
      size,
      addedAt: new Date().toISOString(),
    };
    recipe.attachments = [...(recipe.attachments || []), attachment];
    recipe.updatedAt = attachment.addedAt;
    await this.persist();
    return attachment;
  }

  findAttachment(fileId) {
    for (const r of this.recipes) {
      const a = (r.attachments || []).find((x) => x.id === fileId);
      if (a) return a;
    }
    return null;
  }

  async removeAttachment(id, fileId) {
    const recipe = this.get(id);
    if (!recipe) return false;
    const before = (recipe.attachments || []).length;
    recipe.attachments = (recipe.attachments || []).filter((a) => a.id !== fileId);
    if (recipe.attachments.length === before) return false;
    recipe.updatedAt = new Date().toISOString();
    await this.persist();
    await this.unlinkFile(fileId);
    return true;
  }

  // Full backup with attachments embedded as base64, so one file restores everything.
  async exportAll() {
    const recipes = [];
    for (const r of this.recipes) {
      const attachments = [];
      for (const a of r.attachments || []) {
        try {
          const data = await fsp.readFile(this.filePath(a.id));
          attachments.push({ ...a, data: data.toString('base64') });
        } catch {
          // Missing file on disk: keep the metadata, skip the bytes.
          attachments.push({ ...a });
        }
      }
      recipes.push({ ...r, attachments });
    }
    return { app: 'recipe-box', version: 1, exportedAt: new Date().toISOString(), recipes };
  }

  // Import a backup. Every recipe gets a fresh id so importing twice never clobbers.
  async importAll(backup) {
    const list = Array.isArray(backup) ? backup : backup && backup.recipes;
    if (!Array.isArray(list)) {
      const err = new Error('Not a recipe backup file');
      err.status = 400;
      throw err;
    }
    let count = 0;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const recipe = sanitize(item, {
        id: newId(),
        title: 'Untitled recipe',
        source: { type: 'manual', url: '' },
        ingredients: [],
        instructions: [],
        tags: [],
        favorite: false,
        rating: 0,
        attachments: [],
        createdAt: str(item.createdAt) || new Date().toISOString(),
        updatedAt: str(item.updatedAt) || new Date().toISOString(),
      });
      if (item.original && typeof item.original === 'object') {
        const original = { lang: LANGUAGES[item.original.lang] ? item.original.lang : null };
        for (const k of TEXT_FIELDS) if (k in item.original) original[k] = item.original[k];
        recipe.original = sanitize(original, {});
        recipe.original.lang = original.lang;
      }
      for (const a of Array.isArray(item.attachments) ? item.attachments : []) {
        if (!a || typeof a.data !== 'string') continue;
        const fileId = newId();
        const buf = Buffer.from(a.data, 'base64');
        await fsp.writeFile(this.filePath(fileId), buf);
        recipe.attachments.push({
          id: fileId,
          name: str(a.name, 255) || 'file',
          type: str(a.type, 100) || 'application/octet-stream',
          size: buf.length,
          addedAt: str(a.addedAt) || new Date().toISOString(),
        });
      }
      this.recipes.push(recipe);
      count++;
    }
    await this.persist();
    return count;
  }
}

module.exports = { Store, sanitize, TEXT_FIELDS };
