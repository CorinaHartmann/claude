'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ai = require('../lib/ai');
const { costOfResponse, UsageLog } = require('../lib/usage');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A stand-in for the Anthropic client: answers with the queued responses in order.
function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (params) => { calls.push(JSON.parse(JSON.stringify(params))); return responses.shift(); } } },
  };
}

const usage = (input, output, searches = 0) => ({ input_tokens: input, output_tokens: output, server_tool_use: { web_search_requests: searches } });

test('cost of a response follows the price list', () => {
  const c = costOfResponse({ model: 'claude-opus-5-5', usage: { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, server_tool_use: { web_search_requests: 3 } } });
  // 1M input * $4 + 0.1M output * $20 + 1M cache reads * $0.20 + 3 searches * $0.01
  assert.strictEqual(Math.round(c.usd * 100) / 100, 4 + 2 + 0.2 + 0.03);
});

test('price comparison for Switzerland: CHF, Swiss chains, resumes paused searches, reports cost', async (t) => {
  const result = { currency: 'CHF', stores: [{ chain: 'Denner', total: 12.4, items: [], missing: [], note: '' }], cheapest: 'Denner', summary: 'Denner ist am günstigsten.', sources: [] };
  const client = fakeClient([
    { model: 'claude-opus-5-5', stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'Migros Mehl Preis' } }], usage: usage(20000, 500, 5) },
    { model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'report_prices', input: result }], usage: usage(30000, 1500, 3) },
  ]);
  ai.deps.client = client;
  t.after(() => { ai.deps.client = null; });
  let cost = null;
  const out = await ai.compareSupermarkets({
    items: [{ name: 'Mehl', amount: '500 g' }],
    place: { label: '8001 Zürich', city: 'Zürich', country: 'CH' },
    stores: [],
    onCost: (c) => { cost = c; },
  });
  assert.strictEqual(out.cheapest, 'Denner');
  assert.strictEqual(client.calls.length, 2);
  // The paused turn is sent back so the search continues.
  assert.strictEqual(client.calls[1].messages[1].role, 'assistant');
  const prompt = client.calls[0].messages[0].content;
  assert.match(prompt, /CHF/);
  assert.match(prompt, /Migros, Coop, Denner/);
  assert.match(prompt, /migros\.ch/);
  const search = client.calls[0].tools.find((x) => x.name === 'web_search');
  assert.deepStrictEqual(search.user_location, { type: 'approximate', city: 'Zürich', country: 'CH' });
  // Both calls are counted: 50k input, 2k output, 8 searches.
  assert.strictEqual(cost.searches, 8);
  assert.strictEqual(Math.round(cost.usd * 1000) / 1000, Math.round((50000 * 4 + 2000 * 20) / 1e6 * 1000 + 80) / 1000);
});

test('usage log sums up this month per action', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-box-usage-'));
  const log = await new UsageLog(dir).init();
  log.record('translate', { usd: 0.02, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, searches: 0, model: 'm' });
  log.record('translate', { usd: 0.03, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, searches: 0, model: 'm' });
  log.record('compare-prices', { usd: 0.3, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, searches: 6, model: 'm' });
  await log.queue;
  const sum = (await new UsageLog(dir).init()).summary();
  assert.strictEqual(sum.month.count, 3);
  assert.strictEqual(Math.round(sum.month.usd * 100), 35);
  assert.strictEqual(sum.month.byAction.translate.count, 2);
});
