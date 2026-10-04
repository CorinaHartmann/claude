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
    if (err instanceof Anthropic.AuthenticationError) throw new AiError(502, 'The Anthropic API key was not accepted. Check ANTHROPIC_API_KEY.');
    if (err instanceof Anthropic.RateLimitError) throw new AiError(429, 'Too many requests to Claude right now. Try again in a minute.');
    if (err instanceof Anthropic.BadRequestError) throw new AiError(400, `Claude couldn't read that: ${err.message}`);
    if (err instanceof Anthropic.APIError) throw new AiError(502, `Claude is not reachable right now (${err.status || 'network'}). Try again.`);
    throw err;
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

module.exports = { isEnabled, extractRecipe, translateRecipe, AiError, RECIPE_SCHEMA, TRANSLATION_SCHEMA };
