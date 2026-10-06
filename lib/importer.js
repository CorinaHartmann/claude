'use strict';

// Turns outside content (web pages, video links, pasted text) into a recipe draft.
// Nothing here touches the store; callers decide whether to save the result.

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', frac12: '½',
  frac14: '¼', frac34: '¾', deg: '°', ndash: '–', mdash: '—', hellip: '…',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', eacute: 'é', egrave: 'è',
  times: '×', reg: '®', copy: '©', trade: '™',
};

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    const v = ENTITIES[code.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function cleanText(s) {
  if (s === undefined || s === null) return '';
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// "PT1H30M" -> "1 h 30 min". Leaves anything else untouched.
function formatDuration(value) {
  if (!value) return '';
  const s = String(value).trim();
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(s);
  if (!m) return cleanText(s);
  let [, d, h, min] = m;
  let total = (Number(d) || 0) * 1440 + (Number(h) || 0) * 60 + (Number(min) || 0);
  total = Math.round(total);
  if (!total) return '';
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return [hours && `${hours} h`, mins && `${mins} min`].filter(Boolean).join(' ');
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function hasType(node, type) {
  return asArray(node && node['@type']).some((t) => String(t).toLowerCase() === type.toLowerCase());
}

// Recursively look through JSON-LD (arrays, @graph, nested objects) for a Recipe node.
function findRecipeNode(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 6) return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const hit = findRecipeNode(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (hasType(data, 'Recipe')) return data;
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
    const hit = findRecipeNode(data[key], depth + 1);
    if (hit) return hit;
  }
  return null;
}

function imageFrom(value) {
  for (const img of asArray(value)) {
    if (typeof img === 'string' && img) return img;
    if (img && typeof img === 'object') {
      const url = img.url || img.contentUrl || img['@id'];
      if (typeof url === 'string' && url) return url;
    }
  }
  return '';
}

// recipeInstructions can be a string, a list of strings, HowToStep objects,
// or HowToSection objects wrapping steps. Flatten all of it.
function flattenInstructions(value) {
  const out = [];
  const walk = (v) => {
    if (!v) return;
    if (typeof v === 'string') {
      // A single string may hold several steps separated by newlines or <p>/<br>.
      const raw = decodeEntities(v.replace(/<\/(p|li|div)>|<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''));
      out.push(...raw.split(/\n+/).map(cleanText).filter(Boolean));
      return;
    }
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === 'object') {
      if (hasType(v, 'HowToSection')) {
        if (v.name) out.push(`## ${cleanText(v.name)}`);
        return walk(v.itemListElement || v.steps);
      }
      if (v.itemListElement) return walk(v.itemListElement);
      return walk(v.text || v.name || v.description);
    }
  };
  walk(value);
  return out.map((s) => s.replace(/^(step\s*)?\d+[.):]\s+/i, '')).filter(Boolean);
}

function textValue(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return textValue(v[0]);
  if (typeof v === 'object') return cleanText(v.name || v['@value'] || '');
  return cleanText(v);
}

function keywordsToTags(node) {
  const raw = [
    ...asArray(node.recipeCategory),
    ...asArray(node.recipeCuisine),
    ...asArray(node.keywords).flatMap((k) => String(k).split(',')),
  ];
  const tags = [];
  for (const t of raw.map((x) => cleanText(x).toLowerCase())) {
    if (t && t.length <= 30 && !tags.includes(t)) tags.push(t);
  }
  return tags.slice(0, 8);
}

function recipeFromJsonLd(node, pageUrl) {
  const yieldValue = asArray(node.recipeYield).map(textValue).filter(Boolean);
  // Prefer the most descriptive yield ("4 servings" over "4").
  const servings = yieldValue.sort((a, b) => b.length - a.length)[0] || '';
  return {
    title: textValue(node.name || node.headline),
    description: textValue(node.description),
    imageUrl: absolutize(imageFrom(node.image || node.thumbnailUrl), pageUrl),
    ingredients: asArray(node.recipeIngredient || node.ingredients).map(cleanText).filter(Boolean),
    instructions: flattenInstructions(node.recipeInstructions),
    servings,
    prepTime: formatDuration(node.prepTime),
    cookTime: formatDuration(node.cookTime),
    totalTime: formatDuration(node.totalTime),
    tags: keywordsToTags(node),
    videoUrl: absolutize(node.video ? (asArray(node.video)[0].embedUrl || asArray(node.video)[0].contentUrl || '') : '', pageUrl),
  };
}

function absolutize(url, base) {
  if (!url) return '';
  try {
    return new URL(url, base).href;
  } catch {
    return '';
  }
}

function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1].trim().replace(/^<!--|-->$/g, '');
    try {
      blocks.push(JSON.parse(body));
    } catch {
      // Some sites emit invalid JSON (trailing commas, raw newlines). Try a light repair.
      try {
        blocks.push(JSON.parse(body.replace(/[\u0000-\u001f]+/g, ' ').replace(/,\s*([}\]])/g, '$1')));
      } catch { /* give up on this block */ }
    }
  }
  return blocks;
}

function metaContent(html, key) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name|itemprop)\\s*=\\s*["']${key}["'][^>]*>`, 'i');
  const tag = re.exec(html);
  if (!tag) return '';
  const content = /content\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag[0]);
  return content ? cleanText(content[2] !== undefined ? content[2] : content[3]) : '';
}

// Very small microdata fallback for older sites that use itemprop="recipeIngredient".
function extractMicrodata(html) {
  const grab = (prop) => {
    const re = new RegExp(`<([a-z0-9]+)[^>]*itemprop\\s*=\\s*["'](?:[^"']*\\s)?${prop}(?:\\s[^"']*)?["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');
    const out = [];
    let m;
    while ((m = re.exec(html))) out.push(cleanText(m[2]));
    return out.filter(Boolean);
  };
  const ingredients = [...grab('recipeIngredient'), ...grab('ingredients')];
  const instructions = grab('recipeInstructions');
  if (!ingredients.length && !instructions.length) return null;
  return { ingredients, instructions };
}

const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|dailymotion\.com)$/i;

function isVideoUrl(url) {
  try {
    const u = new URL(url);
    if (!VIDEO_HOSTS.test(u.hostname)) return false;
    if (/instagram\.com|facebook\.com/i.test(u.hostname)) return /\/(reel|reels|p|tv|watch|videos)\//i.test(u.pathname);
    return true;
  } catch {
    return false;
  }
}

// Parse a fetched HTML page into a draft. Pure: easy to test without the network.
function parseHtml(html, pageUrl) {
  let draft = null;
  for (const block of extractJsonLd(html)) {
    const node = findRecipeNode(block);
    if (node) {
      draft = recipeFromJsonLd(node, pageUrl);
      break;
    }
  }
  const micro = !draft || (!draft.ingredients.length && !draft.instructions.length) ? extractMicrodata(html) : null;
  if (!draft) draft = { ingredients: [], instructions: [], tags: [] };
  if (micro) {
    if (!draft.ingredients.length) draft.ingredients = micro.ingredients;
    if (!draft.instructions.length) draft.instructions = micro.instructions;
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  draft.title = draft.title || metaContent(html, 'og:title') || metaContent(html, 'twitter:title') || (titleTag ? cleanText(titleTag[1]) : '');
  draft.description = draft.description || metaContent(html, 'og:description') || metaContent(html, 'description');
  draft.imageUrl = draft.imageUrl || absolutize(metaContent(html, 'og:image') || metaContent(html, 'twitter:image'), pageUrl);

  const video = isVideoUrl(pageUrl);
  if (video) draft.videoUrl = pageUrl;
  else if (!draft.videoUrl) draft.videoUrl = '';

  draft.source = { type: video ? 'video' : 'url', url: pageUrl };
  draft.structured = draft.ingredients.length > 0 || draft.instructions.length > 0;
  // Video captions often contain the whole recipe; try to pull it out.
  if (!draft.structured && draft.description && draft.description.length > 80) {
    const fromText = parseText(draft.description);
    if (fromText.ingredients.length >= 2) {
      draft.ingredients = fromText.ingredients;
      draft.instructions = fromText.instructions;
    }
  }
  return draft;
}

// Reject obvious internal targets so the server can't be used to probe the LAN.
function isPrivateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return false;
}

async function fetchPage(url, { timeoutMs = 15000, maxBytes = 5 * 1024 * 1024 } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw Object.assign(new Error('That does not look like a valid link'), { status: 400 });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw Object.assign(new Error('Only http and https links can be imported'), { status: 400 });
  }
  if (isPrivateHost(parsed.hostname)) {
    throw Object.assign(new Error('Links to private network addresses are not allowed'), { status: 400 });
  }
  const res = await fetch(parsed.href, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      // Many recipe sites serve a stripped page (or block) unknown agents.
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en,*;q=0.5',
    },
  });
  if (!res.ok) {
    throw Object.assign(new Error(`The site answered with HTTP ${res.status}`), { status: 502 });
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return { html: Buffer.concat(chunks).toString('utf8'), finalUrl: res.url || parsed.href };
}

async function importUrl(url, opts) {
  const { html, finalUrl } = await fetchPage(url.trim(), opts);
  const draft = parseHtml(html, finalUrl);
  // Keep the link the person actually pasted; redirects (e.g. youtu.be) are noise.
  draft.source.url = url.trim();
  if (draft.source.type === 'video') draft.videoUrl = url.trim();
  return draft;
}

// ---------- Plain text ----------

const INGREDIENT_HEADINGS = /^(ingredients?|zutaten|ingrédients|ingredienti|ingredientes|what you('ll)? need|you will need|shopping list)\b/i;
const STEP_HEADINGS = /^(instructions?|directions?|method|steps?|preparation|how to make( it)?|zubereitung|anleitung|préparation|preparazione|preparación|procedure)\b/i;
const NOTE_HEADINGS = /^(notes?|tips?|variations?|storage|hinweise?|notizen)\b/i;
// "Serves 4", "Prep time: 15 min" and the same in German, French, Italian, Spanish and Dutch.
const SERVINGS_WORDS = 'serves|servings|yield|makes|portionen|ergibt|menge|für|personen|pour|portions|porzioni|dosi per|dosi|raciones|porciones|para|personas|aantal personen|porties|voor';
const PREP_WORDS = 'prep(?: time)?|vorbereitung(?:szeit)?|zubereitungszeit|arbeitszeit|préparation|temps de préparation|preparazione|tempo di preparazione|preparación|tiempo de preparación|voorbereiding(?:stijd)?|bereidingstijd';
const COOK_WORDS = 'cook(?: time)?|bake(?: time)?|kochzeit|backzeit|garzeit|cuisson|temps de cuisson|cottura|tempo di cottura|cocción|tiempo de cocción|baktijd|kooktijd';
const TOTAL_WORDS = 'total(?: time)?|gesamtzeit|temps total|tempo totale|tiempo total|totale tijd';
const META_LINE = new RegExp(`^(${SERVINGS_WORDS}|${PREP_WORDS}|${COOK_WORDS}|${TOTAL_WORDS})\\s*([:\\-])?\\s*(.+)$`, 'i');
const SERVINGS_RE = new RegExp(`^(${SERVINGS_WORDS})$`, 'i');
const PREP_RE = new RegExp(`^(${PREP_WORDS})$`, 'i');
const COOK_RE = new RegExp(`^(${COOK_WORDS})$`, 'i');

const UNIT = '(cups?|c\\.|tbsp|tablespoons?|tsp|teaspoons?|oz|ounces?|lbs?|pounds?|g|grams?|kg|ml|l|liters?|litres?|pinch|dash|cloves?|cans?|packages?|sticks?|slices?|bunch|handful|el|tl|prise|stück)';
const QUANTITY_START = new RegExp(`^([\\d½¼¾⅓⅔⅛]+([\\s./-]+[\\d½¼¾⅓⅔⅛]+)*\\s*${UNIT}?\\b|a\\s+(pinch|handful|dash|few)|${UNIT}\\s)`, 'i');

function stripBullet(line) {
  return line.replace(/^\s*([-*•·▪◦‣–—]|\[\s?[x ]?\]|\(\s*\))\s*/, '').trim();
}

function stripStepNumber(line) {
  return line.replace(/^\s*(step\s*)?\d+\s*[.):\-]\s*/i, '').trim();
}

function headingText(line) {
  // Social media captions often start headings with emoji ("🛒 Zutaten:").
  return line.replace(/^#+\s*/, '').replace(/^[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s•*-]+/u, '').replace(/[:：]\s*$/, '').trim();
}

// "Zutaten (für 2 Personen)", "Ingredients for 12 cookies" -> the amount part.
const INGREDIENT_HEADING_WITH_AMOUNT = new RegExp(`${INGREDIENT_HEADINGS.source.replace(/\\b$/, '')}\\s*[(\\[]?\\s*(?:für|for|pour|per|para|voor)?\\s*([^)\\]]{1,30}?)\\s*[)\\]]?$`, 'i');

function parseText(input) {
  const text = String(input || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n').map((l) => l.trim());
  const draft = {
    title: '', description: '', ingredients: [], instructions: [], notes: '',
    servings: '', prepTime: '', cookTime: '', totalTime: '', tags: [],
    source: { type: 'text', url: '' },
  };
  let section = 'intro';
  const intro = [];
  const notes = [];
  let sawHeading = false;

  for (const raw of lines) {
    if (!raw) continue;
    const heading = headingText(raw);
    // Headings are short and never numbered ("Step 3: Bake" is a step, not a heading).
    const isShort = heading.length <= 40 && !/\d/.test(heading);
    if (isShort && INGREDIENT_HEADINGS.test(heading)) { section = 'ingredients'; sawHeading = true; continue; }
    const withAmount = heading.length <= 50 && /\d/.test(heading) ? INGREDIENT_HEADING_WITH_AMOUNT.exec(heading) : null;
    if (withAmount) {
      section = 'ingredients';
      sawHeading = true;
      if (!draft.servings) draft.servings = withAmount[withAmount.length - 1].trim();
      continue;
    }
    if (isShort && STEP_HEADINGS.test(heading)) { section = 'instructions'; sawHeading = true; continue; }
    if (isShort && NOTE_HEADINGS.test(heading)) { section = 'notes'; sawHeading = true; continue; }

    // "Prep time: 20 min" anywhere, or "Serves 4" before the first section.
    // Without a colon, "Cook the pasta" inside the steps must stay a step.
    const meta = META_LINE.exec(stripBullet(raw));
    if (meta && meta[3].length < 40 && (meta[2] || (section === 'intro' && /^\d/.test(meta[3])))) {
      const key = meta[1].toLowerCase();
      if (SERVINGS_RE.test(key)) draft.servings = /^(für|pour|para|voor|personen|personas)$/i.test(key) && !/\D/.test(meta[3].trim()) ? `${meta[3]} ${/^(für|personen)$/i.test(key) ? 'Personen' : ''}`.trim() : meta[3];
      else if (PREP_RE.test(key)) draft.prepTime = meta[3];
      else if (COOK_RE.test(key)) draft.cookTime = meta[3];
      else draft.totalTime = meta[3];
      continue;
    }

    if (!draft.title && section === 'intro') {
      draft.title = headingText(raw).slice(0, 200);
      continue;
    }

    if (section === 'ingredients') {
      // A sub-heading inside ingredients ("For the sauce:") is kept as a group label.
      if (/:$/.test(raw) && raw.length < 40) draft.ingredients.push(`## ${headingText(raw)}`);
      else draft.ingredients.push(stripBullet(raw));
    } else if (section === 'instructions') {
      if (/:$/.test(raw) && raw.length < 40) draft.instructions.push(`## ${headingText(raw)}`);
      else draft.instructions.push(stripStepNumber(stripBullet(raw)));
    } else if (section === 'notes') {
      notes.push(stripBullet(raw));
    } else {
      intro.push(raw);
    }
  }

  // No headings at all: guess line-by-line. Short, quantity-led lines are
  // ingredients; numbered or sentence-like lines are steps.
  if (!sawHeading) {
    const rest = [];
    for (const line of intro) {
      const bare = stripBullet(line);
      const numberedStep = /^\s*(step\s*)?\d+\s*[.)]\s+\S/i.test(line) && bare.length > 25;
      if (!numberedStep && QUANTITY_START.test(bare) && bare.length <= 80) draft.ingredients.push(bare);
      else if (numberedStep || /^\s*step\s*\d+/i.test(line)) draft.instructions.push(stripStepNumber(bare));
      else if (draft.ingredients.length && bare.length > 40) draft.instructions.push(stripStepNumber(bare));
      else if (draft.ingredients.length && /^[-*•]/.test(line) && bare.length <= 60) draft.ingredients.push(bare);
      else rest.push(line);
    }
    intro.length = 0;
    intro.push(...rest);
  }

  draft.description = intro.join('\n').slice(0, 2000);
  draft.notes = notes.join('\n');
  draft.ingredients = draft.ingredients.filter(Boolean);
  draft.instructions = draft.instructions.filter(Boolean);
  if (!draft.title) draft.title = 'Untitled recipe';
  return draft;
}

module.exports = {
  parseHtml, parseText, importUrl, fetchPage, isVideoUrl, isPrivateHost,
  formatDuration, decodeEntities, flattenInstructions,
};
