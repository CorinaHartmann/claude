'use strict';

// Optional: let Claude read recipes from pasted text or photos.
// Turned on when the @anthropic-ai/sdk package is installed and an API key
// is set (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN). Without them the app
// still works and falls back to the built-in text splitter.

let Anthropic = null;
try {
  const mod = require('@anthropic-ai/sdk');
  Anthropic = mod.default || mod;
} catch {
  Anthropic = null;
}

const MODEL = 'claude-opus-5-5';
const { LANGUAGES } = require('../public/recipe-kit');

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

function isEnabled() {
  return Boolean(Anthropic && (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN));
}

const str = { type: 'string' };
const list = { type: 'array', items: { type: 'string' } };
const RECIPE_SCHEMA = {
  type: 'object',
  properties: {
    title: str, description: str, servings: str, prepTime: str, cookTime: str, totalTime: str,
    ingredients: list, instructions: list, notes: str, tags: list,
  },
  required: ['title', 'description', 'servings', 'prepTime', 'cookTime', 'totalTime', 'ingredients', 'instructions', 'notes', 'tags'],
  additionalProperties: false,
};

const STYLE = [
  'Keep the recipe in its original language. Never invent or change amounts. Use "" or [] for anything not given.',
  'ingredients: one item per entry, written as amount, unit, then ingredient, e.g. "200 g Mehl", "2 EL Zucker", "1½ cups flour", "2 eggs", "Salz".',
  'Put group headings such as "Für den Teig" or "For the sauce" as their own entry prefixed with "## ".',
  'instructions: one step per entry, full sentences as written, without step numbers.',
  'Times like "15 min" or "1 h 30 min". servings: a number plus what it counts, e.g. "4 people", "4 Portionen", "20 slices", "12 Stück".',
  'notes: tips, storage or variations. tags: 2-4 short lowercase tags in the recipe\'s language, such as dish type or main ingredient.',
  'If there is no recipe, return an empty title and empty lists.',
].join('\n');

const TRANSLATION_SCHEMA = {
  type: 'object',
  properties: {
    sourceLanguage: { type: 'string', enum: [...Object.keys(LANGUAGES), 'other'] },
    ...RECIPE_SCHEMA.properties,
  },
  required: ['sourceLanguage', ...RECIPE_SCHEMA.required],
  additionalProperties: false,
};

class AiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// input: { text } or { images: [{ type: 'image/jpeg', data: '<base64>' }] }
async function extractRecipe(input) {
  if (!isEnabled()) throw new AiError(503, 'Reading with Claude is not set up. Add an API key, see the README.');
  const content = [];
  let task;
  if (Array.isArray(input.images) && input.images.length) {
    for (const img of input.images.slice(0, 6)) {
      if (!img || typeof img.data !== 'string' || !/^image\/(jpeg|png|gif|webp)$/.test(img.type)) continue;
      content.push({ type: 'image', source: { type: 'base64', media_type: img.type, data: img.data } });
    }
    if (!content.length) throw new AiError(400, 'No usable images. Use JPEG or PNG photos.');
    task = `These ${content.length} image(s) show one recipe: a cookbook page, a handwritten card, a screenshot of a website or a video caption. Transcribe the recipe faithfully. If it continues across several images, combine them in order.`;
  } else if (typeof input.text === 'string' && input.text.trim()) {
    task = 'The text between <page> tags was copied from a recipe website, an app, a message or a video caption. '
      + 'It may include menus, ads, ratings, comments, nutrition tables and other recipes\' titles: ignore all of that and extract the one main recipe.\n'
      + `<page>\n${input.text.slice(0, 100000)}\n</page>`;
  } else {
    throw new AiError(400, 'Nothing to read. Paste some text or add a photo.');
  }
  content.push({ type: 'text', text: `${task}\n\n${STYLE}` });

  return askForJson(content, RECIPE_SCHEMA);
}

function apiError(err) {
  if (err instanceof Anthropic.AuthenticationError) return new AiError(502, 'The Anthropic API key was not accepted. Check ANTHROPIC_API_KEY.');
  if (err instanceof Anthropic.RateLimitError) return new AiError(429, 'Too many requests to Claude right now. Try again in a minute.');
  if (err instanceof Anthropic.BadRequestError) return new AiError(400, `Claude couldn't do that: ${err.message}`);
  if (err instanceof Anthropic.APIError) return new AiError(502, `Claude is not reachable right now (${err.status || 'network'}). Try again.`);
  return err;
}

async function askForJson(content, schema) {
  let response;
  try {
    response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // If Claude declines, the API retries on a fallback model in the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content }],
    });
  } catch (err) {
    throw apiError(err);
  }
  if (response.stop_reason === 'refusal') throw new AiError(422, 'Claude declined to read this. Try a different photo or text.');
  if (response.stop_reason === 'max_tokens') throw new AiError(422, 'The recipe was too long to read in one go. Paste a shorter part.');
  const block = response.content.find((b) => b.type === 'text');
  try {
    return JSON.parse(block ? block.text : '');
  } catch {
    throw new AiError(502, 'Claude\'s answer could not be read. Try again.');
  }
}

// Translate a recipe's text into another language. Returns the translated
// fields plus sourceLanguage (the language the recipe was written in).
async function translateRecipe(recipe, to) {
  if (!isEnabled()) throw new AiError(503, 'Translating needs Claude. Add an API key, see the README.');
  const target = LANGUAGES[to];
  if (!target) throw new AiError(400, 'Unknown language');
  const fields = {
    title: recipe.title || '', description: recipe.description || '', servings: recipe.servings || '',
    prepTime: recipe.prepTime || '', cookTime: recipe.cookTime || '', totalTime: recipe.totalTime || '',
    ingredients: recipe.ingredients || [], instructions: recipe.instructions || [], notes: recipe.notes || '', tags: recipe.tags || [],
  };
  const prompt = [
    `Translate this recipe into ${target.english}. It is given as JSON between <recipe> tags.`,
    'Translate naturally, the way a cookbook in that language would say it, including dish names that have a usual translation.',
    'Keep every amount and number exactly as it is. Do not convert between metric and imperial.',
    `Write units the way ${target.english} recipes abbreviate them (for example EL/TL in German, tbsp/tsp in English, c. à s./c. à c. in French); g, kg, ml and l stay as they are.`,
    'Keep the same ingredients and steps in the same order, one per entry. Keep the "## " prefix on group headings.',
    'Translate the tags and the word in servings (e.g. "4 Personen" becomes "4 people" in English). Times stay like "15 min" or "1 h 30 min".',
    'Set sourceLanguage to the language the recipe is written in. If it is already in the target language, return the text unchanged.',
    `<recipe>\n${JSON.stringify(fields)}\n</recipe>`,
  ].join('\n');
  return askForJson([{ type: 'text', text: prompt }], TRANSLATION_SCHEMA);
}

// ---------- Supermarket price comparison ----------

const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const num = { type: 'number' };
const PRICE_REPORT_TOOL = {
  name: 'report_prices',
  description: 'Report the finished price comparison. Call this exactly once, at the end, after researching prices.',
  strict: true,
  input_schema: obj({
    currency: str,
    stores: {
      type: 'array',
      items: obj({
        chain: str,
        total: num,
        items: { type: 'array', items: obj({ item: str, product: str, price: num, estimated: { type: 'boolean' }, offer: { type: 'boolean' } }) },
        missing: list,
        note: str,
      }),
    },
    cheapest: str,
    summary: str,
    sources: { type: 'array', items: obj({ title: str, url: str }) },
  }),
};

// items: [{ name, amount }], place: { city, postcode, country }, stores: [{ chain, km }]
async function compareSupermarkets({ items, place, stores, lang = 'de', today = new Date() }) {
  if (!isEnabled()) throw new AiError(503, 'The price comparison needs Claude. Add an API key, see the README.');
  if (!items.length) throw new AiError(400, 'The shopping list has nothing left to buy.');
  const chains = stores.slice(0, 6);
  if (!chains.length) throw new AiError(404, 'No supermarkets were found near this place.');
  const language = LANGUAGES[lang]?.english || 'German';
  const date = today.toISOString().slice(0, 10);
  const prompt = [
    `Today is ${date}. Someone in ${place.label || place.city} (${place.country || 'unknown country'}) wants to buy the items below and asks which nearby supermarket is cheapest for the whole list.`,
    '',
    'Supermarkets near them (nearest branch first):',
    ...chains.map((c) => `- ${c.chain} (${c.km} km)`),
    '',
    'Shopping list (amounts needed for the recipes):',
    ...items.map((i) => `- ${i.amount ? `${i.amount} ` : ''}${i.name}`),
    '',
    'Use web search to find current prices at these chains in this country: their online shops or price pages, this week\'s offer leaflets, and price comparison sites.',
    'For each chain, pick the cheapest normal product that covers the amount (the smallest pack that is enough; store own brands are fine) and give its pack price.',
    'Mark a price as estimated when you could not find it for that chain and used typical prices instead, and as an offer when it is a time-limited special.',
    'Put items the chain doesn\'t sell in missing. total is the sum of the item prices for that chain.',
    'Only compare the chains listed above; skip any for which you can\'t find prices at all.',
    `Write product names, notes and the summary in ${language}. In the summary, say which chain is cheapest overall and by roughly how much, in one or two sentences.`,
    'Then call report_prices once with the result and the most useful sources.',
  ].join('\n');

  const tools = [
    {
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: 12,
      user_location: { type: 'approximate', city: place.city || undefined, country: place.country || undefined },
    },
    PRICE_REPORT_TOOL,
  ];
  const messages = [{ role: 'user', content: prompt }];
  let reminded = false;
  for (let round = 0; round < 8; round++) {
    let response;
    try {
      response = await getClient().beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        tools,
        messages,
      });
    } catch (err) {
      throw apiError(err);
    }
    if (response.stop_reason === 'refusal') throw new AiError(422, 'Claude declined this request.');
    const report = response.content.find((b) => b.type === 'tool_use' && b.name === 'report_prices');
    if (report) return { ...report.input, searches: response.usage?.server_tool_use?.web_search_requests ?? null };
    messages.push({ role: 'assistant', content: response.content });
    // Web search ran out of server-side turns: send the turn back and it continues.
    if (response.stop_reason === 'pause_turn') continue;
    if (reminded) break;
    reminded = true;
    messages.push({ role: 'user', content: 'Please call report_prices now with what you found.' });
  }
  throw new AiError(502, 'Claude didn\'t finish the price comparison. Try again.');
}

module.exports = { isEnabled, extractRecipe, translateRecipe, compareSupermarkets, AiError, RECIPE_SCHEMA, TRANSLATION_SCHEMA, PRICE_REPORT_TOOL };
