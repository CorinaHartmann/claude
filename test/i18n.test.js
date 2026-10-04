'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test('every app text has a translation in every language', async () => {
  // The browser loads i18n.js as an ES module; Node treats .js here as CommonJS, so load it as a data: module.
  const { _strings: strings } = await import(`data:text/javascript,${encodeURIComponent(read('i18n.js'))}`);
  const keys = new Set();
  for (const m of read('app.js').matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
  const html = read('index.html').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
  for (const m of html.matchAll(/data-i18n(?:-placeholder|-aria)?="([^"]*)"/g)) keys.add(m[1]);
  assert.ok(keys.size > 150, `found only ${keys.size} texts`);
  const missing = [...keys].filter((k) => !strings[k] || strings[k].length !== 5 || strings[k].some((v) => !v));
  assert.deepStrictEqual(missing, []);
  // Placeholders like {n} must survive translation.
  for (const [key, list] of Object.entries(strings)) {
    const vars = (key.match(/\{\w+\}/g) || []).sort().join();
    for (const v of list) assert.strictEqual((v.match(/\{\w+\}/g) || []).sort().join(), vars, `${key} → ${v}`);
  }
});
