'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseHtml, parseText, formatDuration, isVideoUrl, isPrivateHost } = require('../lib/importer');

test('formatDuration turns ISO 8601 into something readable', () => {
  assert.strictEqual(formatDuration('PT1H30M'), '1 h 30 min');
  assert.strictEqual(formatDuration('PT45M'), '45 min');
  assert.strictEqual(formatDuration('PT90M'), '1 h 30 min');
  assert.strictEqual(formatDuration('P0DT2H'), '2 h');
  assert.strictEqual(formatDuration('20 minutes'), '20 minutes');
  assert.strictEqual(formatDuration(''), '');
});

test('parseHtml reads a schema.org Recipe inside an @graph', () => {
  const html = `<html><head><title>Ignore me</title>
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"WebPage","name":"page"},
      {"@type":["Recipe","NewsArticle"],"name":"Best Banana Bread &amp; More",
       "image":[{"@type":"ImageObject","url":"/img/bread.jpg"}],
       "recipeYield":["8","8 slices"],"prepTime":"PT15M","cookTime":"PT1H","totalTime":"PT1H15M",
       "recipeIngredient":["3 ripe bananas","<b>250 g</b> flour"],
       "recipeCategory":"Dessert","keywords":"baking, bread",
       "recipeInstructions":[
         {"@type":"HowToSection","name":"Batter","itemListElement":[
           {"@type":"HowToStep","text":"Mash the bananas."},
           {"@type":"HowToStep","text":"Stir in flour."}]},
         {"@type":"HowToStep","text":"Bake for 1 hour."}]}
    ]}</script></head><body></body></html>`;
  const d = parseHtml(html, 'https://example.com/recipes/bread');
  assert.strictEqual(d.title, 'Best Banana Bread & More');
  assert.strictEqual(d.imageUrl, 'https://example.com/img/bread.jpg');
  assert.deepStrictEqual(d.ingredients, ['3 ripe bananas', '250 g flour']);
  assert.deepStrictEqual(d.instructions, ['## Batter', 'Mash the bananas.', 'Stir in flour.', 'Bake for 1 hour.']);
  assert.strictEqual(d.servings, '8 slices');
  assert.strictEqual(d.prepTime, '15 min');
  assert.strictEqual(d.cookTime, '1 h');
  assert.deepStrictEqual(d.tags, ['dessert', 'baking', 'bread']);
  assert.deepStrictEqual(d.source, { type: 'url', url: 'https://example.com/recipes/bread' });
  assert.strictEqual(d.structured, true);
});

test('parseHtml splits a single instruction string into steps', () => {
  const html = `<script type="application/ld+json">[{"@type":"Recipe","name":"Soup",
    "recipeIngredient":["water"],"recipeInstructions":"<p>Boil water.</p><p>Add salt.</p>"}]</script>`;
  const d = parseHtml(html, 'https://example.com/soup');
  assert.deepStrictEqual(d.instructions, ['Boil water.', 'Add salt.']);
});

test('parseHtml falls back to Open Graph tags when there is no recipe data', () => {
  const html = `<html><head>
    <meta property="og:title" content="Quick Pasta">
    <meta property="og:image" content="https://cdn.example.com/p.jpg">
    <meta name="description" content="Dinner in 10 minutes"></head></html>`;
  const d = parseHtml(html, 'https://blog.example.com/pasta');
  assert.strictEqual(d.title, 'Quick Pasta');
  assert.strictEqual(d.imageUrl, 'https://cdn.example.com/p.jpg');
  assert.strictEqual(d.description, 'Dinner in 10 minutes');
  assert.strictEqual(d.structured, false);
});

test('parseHtml marks video sites and pulls a recipe out of the caption', () => {
  const html = `<meta property="og:title" content="Garlic noodles">
    <meta property="og:description" content="Garlic noodles! Ingredients: 200 g noodles
2 tbsp butter
4 cloves garlic
Method: Cook the noodles and toss with the garlic butter.">`;
  const d = parseHtml(html, 'https://www.youtube.com/watch?v=abc123');
  assert.strictEqual(d.source.type, 'video');
  assert.strictEqual(d.videoUrl, 'https://www.youtube.com/watch?v=abc123');
});

test('parseHtml reads microdata recipes', () => {
  const html = `<div itemscope itemtype="http://schema.org/Recipe"><h1 itemprop="name">Pancakes</h1>
    <li itemprop="recipeIngredient">1 cup flour</li><li itemprop="recipeIngredient">1 egg</li>
    <div itemprop="recipeInstructions">Mix and fry.</div></div>`;
  const d = parseHtml(html, 'https://example.com/pancakes');
  assert.deepStrictEqual(d.ingredients, ['1 cup flour', '1 egg']);
  assert.deepStrictEqual(d.instructions, ['Mix and fry.']);
});

test('parseText splits a recipe with headings', () => {
  const d = parseText(`Grandma's Lemon Cake
A family favourite.
Serves: 8
Prep time: 20 min

Ingredients:
- 200 g flour
- 2 eggs
For the glaze:
• 100 g icing sugar

Instructions
1. Preheat the oven to 180°C.
2) Mix everything.
Step 3: Bake 40 minutes.

Notes
Keeps for 3 days.`);
  assert.strictEqual(d.title, "Grandma's Lemon Cake");
  assert.strictEqual(d.description, 'A family favourite.');
  assert.strictEqual(d.servings, '8');
  assert.strictEqual(d.prepTime, '20 min');
  assert.deepStrictEqual(d.ingredients, ['200 g flour', '2 eggs', '## For the glaze', '100 g icing sugar']);
  assert.deepStrictEqual(d.instructions, ['Preheat the oven to 180°C.', 'Mix everything.', 'Bake 40 minutes.']);
  assert.strictEqual(d.notes, 'Keeps for 3 days.');
});

test('parseText guesses ingredients and steps without headings', () => {
  const d = parseText(`Easy Guacamole
2 avocados
1/2 lime, juiced
1 tsp salt
1. Mash the avocados in a bowl with a fork.
2. Stir in the lime juice and salt, then serve.`);
  assert.strictEqual(d.title, 'Easy Guacamole');
  assert.deepStrictEqual(d.ingredients, ['2 avocados', '1/2 lime, juiced', '1 tsp salt']);
  assert.strictEqual(d.instructions.length, 2);
  assert.strictEqual(d.instructions[0], 'Mash the avocados in a bowl with a fork.');
});

test('parseText understands German headings', () => {
  const d = parseText('Kartoffelsalat\nZutaten\n1 kg Kartoffeln\nZubereitung\nKartoffeln kochen.');
  assert.deepStrictEqual(d.ingredients, ['1 kg Kartoffeln']);
  assert.deepStrictEqual(d.instructions, ['Kartoffeln kochen.']);
});

test('isVideoUrl recognises the common video platforms', () => {
  assert.ok(isVideoUrl('https://youtu.be/xyz'));
  assert.ok(isVideoUrl('https://www.tiktok.com/@chef/video/123'));
  assert.ok(isVideoUrl('https://www.instagram.com/reel/abc/'));
  assert.ok(!isVideoUrl('https://www.instagram.com/someone/'));
  assert.ok(!isVideoUrl('https://www.bbcgoodfood.com/recipes/x'));
});

test('isPrivateHost blocks local network targets', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.10', '172.20.0.1', '169.254.169.254', '[::1]', 'printer.local']) {
    assert.ok(isPrivateHost(h), h);
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1']) assert.ok(!isPrivateHost(h), h);
});

test('parseText keeps "Cook ..." steps as steps', () => {
  const d = parseText('Pasta\nServes 2\nIngredients\n200 g pasta\nMethod\nCook the pasta\nCook 10 min more');
  assert.strictEqual(d.servings, '2');
  assert.deepStrictEqual(d.instructions, ['Cook the pasta', 'Cook 10 min more']);
});

test('parseText finds servings and times in other languages', () => {
  const de = parseText('Brownies\nErgibt: 12 Stück\nZubereitungszeit: 15 Min.\nBackzeit: 25 Min.\nZutaten\n200 g Mehl\nFür den Teig:\n2 Eier\nZubereitung\nBacken.');
  assert.deepStrictEqual([de.servings, de.prepTime, de.cookTime], ['12 Stück', '15 Min.', '25 Min.']);
  assert.deepStrictEqual(de.ingredients, ['200 g Mehl', '## Für den Teig', '2 Eier']);
  const fr = parseText('Crêpes\nPour 4 personnes\nCuisson : 20 min\nIngrédients\n250 g de farine\nPréparation\nMélanger.');
  assert.deepStrictEqual([fr.servings, fr.cookTime, fr.instructions[0]], ['4 personnes', '20 min', 'Mélanger.']);
});
