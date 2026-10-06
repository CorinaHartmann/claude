'use strict';

// The shopping list lives in data/shopping.json, next to the recipes.
// Ingredients from several recipes are added up: 200 g Mehl + 300 g Mehl = 500 g Mehl.

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { parseIngredientLine, shoppingKey, toBase, categorize } = require('../public/recipe-kit');

const newId = () => crypto.randomBytes(6).toString('hex');
const str = (v, max = 300) => String(v ?? '').slice(0, max).trim();

class ShoppingList {
  constructor(dir) {
    this.path = path.join(dir, 'shopping.json');
    this.items = [];
    this.comparison = null;
    this.queue = Promise.resolve();
  }

  async init() {
    try {
      const data = JSON.parse(await fsp.readFile(this.path, 'utf8'));
      this.items = Array.isArray(data.items) ? data.items : [];
      this.comparison = data.comparison || null;
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    }
    return this;
  }

  persist() {
    this.queue = this.queue.then(async () => {
      const tmp = `${this.path}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ items: this.items, comparison: this.comparison }, null, 2));
      await fsp.rename(tmp, this.path);
    });
    return this.queue;
  }

  get() {
    return { items: this.items, comparison: this.comparison };
  }

  // The things still to buy (not ticked off).
  open() {
    return this.items.filter((i) => !i.checked);
  }

  // Add one line, merging it into an open item for the same thing and unit.
  addOne(text, source) {
    const parsed = parseIngredientLine(text);
    if (!parsed) return;
    const { qty, unit } = parsed.qty === null ? { qty: null, unit: '' } : toBase(parsed.qty, parsed.unit);
    const key = shoppingKey(parsed.name);
    const same = this.items.find((i) => !i.checked && i.key === key && i.unit === unit);
    if (same) {
      if (qty !== null) same.qty = (same.qty || 0) + qty;
      if (source && !same.sources.some((s) => s.id === source.id)) same.sources.push(source);
      return;
    }
    this.items.push({
      id: newId(),
      name: parsed.name.slice(0, 120),
      key,
      qty,
      unit,
      category: categorize(parsed.name),
      sources: source ? [source] : [],
      checked: false,
      addedAt: new Date().toISOString(),
    });
  }

  async add(lines, source) {
    const src = source && source.id ? { id: str(source.id, 40), title: str(source.title, 200) } : null;
    for (const line of lines.slice(0, 300)) this.addOne(str(line), src);
    await this.persist();
    return this.get();
  }

  async update(id, patch) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return null;
    if ('checked' in patch) item.checked = Boolean(patch.checked);
    if (typeof patch.name === 'string' && patch.name.trim()) {
      item.name = str(patch.name, 120);
      item.key = shoppingKey(item.name);
      item.category = categorize(item.name);
    }
    await this.persist();
    return item;
  }

  async remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length === before) return false;
    await this.persist();
    return true;
  }

  async clear(onlyChecked) {
    this.items = onlyChecked ? this.items.filter((i) => !i.checked) : [];
    if (!this.items.length) this.comparison = null;
    await this.persist();
    return this.get();
  }

  async setComparison(comparison) {
    this.comparison = comparison;
    await this.persist();
    return comparison;
  }
}

module.exports = { ShoppingList };
