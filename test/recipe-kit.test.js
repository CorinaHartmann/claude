'use strict';

const test = require('node:test');
const assert = require('node:assert');
const K = require('../public/recipe-kit');

test('ingredients are written amount first with tidy units', () => {
  const cases = {
    '200g Mehl': '200 g Mehl', '- 2 Esslöffel Zucker': '2 EL Zucker', 'Flour: 2 cups': '2 cups Flour',
    '1 1/2 tablespoons olive oil': '1½ tbsp olive oil', '1/2 teaspoon salt': '½ tsp salt', '0,5 l Milch': '½ l Milch',
    '2-3 cloves garlic': '2–3 cloves garlic', 'Für den Teig:': '## Für den Teig', 'Salz und Pfeffer': 'Salz und Pfeffer',
  };
  for (const [input, want] of Object.entries(cases)) assert.strictEqual(K.normIngredient(input), want, input);
});

test('times and servings', () => {
  assert.strictEqual(K.normTime('1 Std. 30 Min.'), '1 h 30 min');
  assert.strictEqual(K.normTime('PT45M'), '45 min');
  assert.strictEqual(K.normTime('über Nacht'), 'über Nacht');
  assert.strictEqual(K.normServings('Serves 4'), '4 people');
  assert.strictEqual(K.normServings('Makes 24 cookies'), '24 cookies');
  assert.strictEqual(K.normServings('4-6 servings'), '4–6 servings');
});

test('scaling rounds the way you measure', () => {
  assert.deepStrictEqual(K.scaleIngredient('225 g butter', 0.5), { qty: '115', rest: ' g butter' });
  assert.deepStrictEqual(K.scaleIngredient('4 eggs', 1.2), { qty: '5', rest: ' eggs' });
  assert.deepStrictEqual(K.scaleIngredient('1/2 tsp salt', 2), { qty: '1', rest: ' tsp salt' });
  assert.strictEqual(K.scaleIngredient('Salz', 2), null);
});

test('durations in steps become timers', () => {
  const secs = (t) => K.findDurations(t).map((d) => [d.secs, d.max]);
  assert.deepStrictEqual(secs('Bake for 20–25 minutes.'), [[1200, 1500]]);
  assert.deepStrictEqual(secs('Den Teig 1 Std. 30 Min. ruhen lassen.'), [[5400, 0]]);
  assert.deepStrictEqual(secs('Simmer for half an hour.'), [[1800, 0]]);
  assert.deepStrictEqual(secs('Heat the oven to 200 °C.'), []);
  assert.strictEqual(K.fmtClock(65000), '1:05');
});

test('a duration keeps its abbreviation dot', () => {
  const [d] = K.findDurations('25 Min. backen.');
  assert.strictEqual('25 Min. backen.'.slice(d.start, d.end), '25 Min.');
});

test('detects the language of a recipe', () => {
  assert.strictEqual(K.detectLang({ title: 'Brownies', ingredients: ['200 g Mehl', '2 Eier'], instructions: ['Den Ofen vorheizen und 25 Minuten backen.'] }), 'de');
  assert.strictEqual(K.detectLang({ title: 'Crêpes', ingredients: ['250 g de farine', '4 œufs'], instructions: ['Mélanger la farine et les œufs.'] }), 'fr');
  assert.strictEqual(K.detectLang({ title: 'IMG 2041', ingredients: [], instructions: [] }), null);
});
