'use strict';

// What each Claude action actually cost, from the token counts the API reports.
// Kept in data/usage.json so the app can show it, and later charge for it.

const fsp = require('fs').promises;
const path = require('path');

// US dollars per million tokens (Anthropic list prices, September 2026).
// Cache writes cost 1.25x input; a web search costs $10 per 1,000.
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
};
const WEB_SEARCH_USD = 0.01;
const MAX_ENTRIES = 5000;

// Cost of one API response. Unknown models are priced like Opus 5.5.
function costOfResponse(response) {
  const u = response?.usage || {};
  const price = PRICES[response?.model] || PRICES['claude-opus-5-5'];
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const searches = u.server_tool_use?.web_search_requests || 0;
  const usd = (input * price.input + output * price.output + cacheRead * price.cacheRead + cacheWrite * price.input * 1.25) / 1e6
    + searches * WEB_SEARCH_USD;
  return { model: response?.model || '', input, output, cacheRead, cacheWrite, searches, usd };
}

// Add up the costs of several responses (one action can take several API calls).
function sumCosts(costs) {
  const total = { model: costs[0]?.model || '', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, searches: 0, usd: 0 };
  for (const c of costs) for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'searches', 'usd']) total[k] += c[k];
  return total;
}

class UsageLog {
  constructor(dir) {
    this.path = path.join(dir, 'usage.json');
    this.entries = [];
    this.queue = Promise.resolve();
  }

  async init() {
    try {
      const data = JSON.parse(await fsp.readFile(this.path, 'utf8'));
      this.entries = Array.isArray(data.entries) ? data.entries : [];
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    }
    return this;
  }

  record(action, cost) {
    const entry = { at: new Date().toISOString(), action, ...cost, usd: Math.round(cost.usd * 1e6) / 1e6 };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
    this.queue = this.queue.then(async () => {
      const tmp = `${this.path}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ entries: this.entries }));
      await fsp.rename(tmp, this.path);
    });
    return entry;
  }

  // This month and all time, per action.
  summary(now = new Date()) {
    const month = now.toISOString().slice(0, 7);
    const sum = (list) => {
      const byAction = {};
      let usd = 0;
      for (const e of list) {
        usd += e.usd;
        const a = (byAction[e.action] ||= { count: 0, usd: 0 });
        a.count++;
        a.usd += e.usd;
      }
      return { count: list.length, usd, byAction };
    };
    return {
      month: { key: month, ...sum(this.entries.filter((e) => e.at.startsWith(month))) },
      allTime: sum(this.entries),
      recent: this.entries.slice(-10).reverse(),
    };
  }
}

module.exports = { UsageLog, costOfResponse, sumCosts, PRICES, WEB_SEARCH_USD };
