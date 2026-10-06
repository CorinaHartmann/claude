'use strict';

// Instagram posts and reels. Instagram has no public API for other people's
// posts, so the caption is read from the post's embed page (which works without
// logging in), with the page's preview text as a fallback. Instagram changes its
// pages now and then; when nothing can be read the app falls back to screenshots.

const { parseText, decodeEntities } = require('./importer');

const BROWSER_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
// Instagram serves link previews (title, caption, picture) to link-preview bots.
const PREVIEW_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const MAX_IMAGE = 8 * 1024 * 1024;

const deps = { fetch: (...a) => fetch(...a) }; // swapped out in tests

// https://www.instagram.com/reel/ABC123/?igsh=… -> { kind: 'reel', code: 'ABC123' }
function parseInstagramUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)instagram\.com$/i.test(u.hostname) && !/^instagr\.am$/i.test(u.hostname)) return null;
    const m = /^\/(?:[\w.]+\/)?(p|reel|reels|tv)\/([\w-]+)/i.exec(u.pathname);
    if (!m) return null;
    const kind = m[1].toLowerCase() === 'p' ? 'p' : 'reel';
    return { kind, code: m[2], url: `https://www.instagram.com/${kind}/${m[2]}/` };
  } catch {
    return null;
  }
}

async function getText(url, ua) {
  const res = await deps.fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': ua, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'en,de;q=0.8' },
  });
  if (!res.ok) return '';
  return res.text();
}

const htmlToText = (html) => decodeEntities(String(html)
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div)>/gi, '\n')
  .replace(/<[^>]*>/g, ''))
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

// Read the JSON string literal that starts at `i` (at the opening quote).
function readJsonString(src, i) {
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') j += 2;
    else if (src[j] === '"') break;
    else j++;
  }
  try { return JSON.parse(src.slice(i, j + 1)); } catch { return null; }
}

// Find the first value under `key` anywhere in a parsed object.
function deepFind(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const found = deepFind(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

// The embed page: either the caption in HTML, or the post data as JSON in a script.
function parseEmbed(html) {
  const out = { caption: '', author: '', imageUrl: '' };
  const ctx = html.indexOf('"contextJSON":"');
  if (ctx >= 0) {
    try {
      const data = JSON.parse(readJsonString(html, ctx + '"contextJSON":'.length) || 'null');
      const media = deepFind(data, 'shortcode_media') || data;
      out.caption = deepFind(deepFind(media, 'edge_media_to_caption'), 'text') || '';
      out.author = deepFind(deepFind(media, 'owner'), 'username') || '';
      out.imageUrl = deepFind(media, 'display_url') || '';
    } catch { /* fall through to the HTML */ }
  }
  if (!out.caption) {
    const cap = /<div class="Caption"[^>]*>([\s\S]*?)<div class="CaptionComments"/i.exec(html);
    if (cap) {
      const user = /<a class="CaptionUsername"[^>]*>([\s\S]*?)<\/a>/i.exec(cap[1]);
      if (user) out.author ||= htmlToText(user[1]);
      out.caption = htmlToText(cap[1].replace(/<a class="CaptionUsername"[\s\S]*?<\/a>/i, ''));
    }
  }
  if (!out.author) {
    const user = /<(?:span|a) class="UsernameText"[^>]*>([\s\S]*?)<\/(?:span|a)>/i.exec(html);
    if (user) out.author = htmlToText(user[1]);
  }
  if (!out.imageUrl) {
    const img = /<img[^>]+class="EmbeddedMediaImage"[^>]*>/i.exec(html);
    const src = img && /\ssrc="([^"]+)"/i.exec(img[0]);
    if (src) out.imageUrl = decodeEntities(src[1]);
  }
  return out;
}

const meta = (html, prop) => {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
  const tag = re.exec(html);
  const content = tag && /content=["']([^"']*)["']/i.exec(tag[0]);
  return content ? decodeEntities(content[1]) : '';
};

// The link preview: 'og:description' is like
// '1,234 likes, 56 comments - koch.mit.anna on March 3, 2026: "Caption…".'
function parsePreview(html) {
  const desc = meta(html, 'og:description') || meta(html, 'description');
  const title = meta(html, 'og:title');
  const out = { caption: '', author: '', imageUrl: meta(html, 'og:image') };
  const m = /(?:^|\s-\s)([\w.]+) on [^:]{3,40}:\s*["“]([\s\S]*)["”]\.?\s*$/.exec(desc);
  if (m) {
    out.author = m[1];
    out.caption = m[2];
  } else {
    const t = /^(?:.*?\(@)?([\w.]+)\)? on Instagram:\s*["“]([\s\S]*)["”]\s*$/.exec(title);
    if (t) { out.author = t[1]; out.caption = t[2]; }
  }
  return out;
}

const QUANTITY_LINE = /^[-•*▪️✔️🔸🔹]*\s*(\d+[\d.,/½¼¾]*|½|¼|¾|eine?|one|a)\s*(g|gr|kg|ml|cl|dl|l|el|tl|tbsp|tsp|cups?|tassen?|prise|pinch|stk|stück|pcs|zehen?|cloves?|dose|can|bund|päckchen|pck)?\b/i;

// What the caption says about the recipe.
function analyseCaption(caption) {
  const text = String(caption || '');
  // Hashtag and mention lines ("#pasta #rezept") are not part of the recipe.
  const parsed = parseText(text.split('\n').filter((l) => !/^([#@][\p{L}\p{N}_.]+[\s.,]*)+$/u.test(l.trim())).join('\n'));
  const quantityLines = text.split('\n').filter((l) => QUANTITY_LINE.test(l.trim())).length;
  const hasRecipe = parsed.ingredients.length >= 2
    || /\b(zutaten|ingredients?|ingrédients|ingredienti|ingredientes|ingrediënten)\b/i.test(text)
    || quantityLines >= 3;
  return {
    parsed,
    hasRecipe,
    linkInBio: /\b(link|rezept|recipe|recette|ricetta|receta)\b[^\n]{0,40}\b(bio|profil|profile)\b/i.test(text),
    // "Comment RECIPE and I'll send it to you" (sent by direct message).
    viaComment: /(kommentier|comment|schreib)[^\n]{0,40}(["“'„]?[A-ZÄÖÜ]{3,}["”'“]?)[^\n]{0,60}(dm|nachricht|message|schick|send)/i.test(text)
      || /\b(dm|direct message|direktnachricht)\b[^\n]{0,40}\b(rezept|recipe)\b/i.test(text),
  };
}

// First useful line of the caption, without emoji, hashtags or mentions.
function titleFrom(caption, author) {
  for (const raw of String(caption || '').split('\n')) {
    const line = raw
      .replace(/[#@][\p{L}\p{N}_.]+/gu, '')
      .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
      .replace(/\s+/g, ' ')
      // "… Rezept im Link in meiner Bio!" / "… (recipe in bio)" is not part of the name.
      .replace(/[\s(–-]*\b(das |the )?(rezept|recipe|recette|ricetta|receta|link)\b[^\n]{0,40}\b(bio|profil|profile)\b.*$/i, '')
      .replace(/^[\s\-–•:|]+|[\s\-–•:|!]+$/g, '')
      .trim();
    if (line.length >= 3 && !QUANTITY_LINE.test(line) && !/^(zutaten|ingredients?)\b/i.test(line)) {
      return line.length > 80 ? `${line.slice(0, 77).replace(/\s+\S*$/, '')}…` : line;
    }
  }
  return author ? `Instagram · @${author}` : 'Instagram';
}

// Instagram's picture links expire after a while, so the picture is downloaded.
async function downloadImage(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !/(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(u.hostname)) return null;
    const res = await deps.fetch(u.href, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': BROWSER_UA } });
    const type = (res.headers.get('content-type') || '').split(';')[0];
    if (!res.ok || !/^image\/(jpeg|png|webp)$/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE) return null;
    return { type, data: buf.toString('base64') };
  } catch {
    return null;
  }
}

// An Instagram link -> a draft recipe plus what was found, for the app to explain.
async function importInstagram(url) {
  const post = parseInstagramUrl(url);
  if (!post) return null;
  let found = { caption: '', author: '', imageUrl: '' };
  try {
    found = parseEmbed(await getText(`${post.url}embed/captioned/`, BROWSER_UA));
  } catch { /* try the preview */ }
  if (!found.caption || !found.imageUrl) {
    try {
      const preview = parsePreview(await getText(post.url, PREVIEW_UA));
      found = {
        caption: found.caption || preview.caption,
        author: found.author || preview.author,
        imageUrl: found.imageUrl || preview.imageUrl,
      };
    } catch { /* nothing readable */ }
  }
  const caption = found.caption.trim();
  const info = analyseCaption(caption);
  const draft = {
    title: caption ? titleFrom(caption, found.author) : '',
    // Without a recipe the caption is still worth keeping (tips, the creator's notes).
    description: info.hasRecipe ? '' : caption.slice(0, 800),
    ingredients: info.hasRecipe ? info.parsed.ingredients : [],
    instructions: info.hasRecipe ? info.parsed.instructions : [],
    servings: info.parsed.servings || '',
    prepTime: info.parsed.prepTime || '',
    cookTime: info.parsed.cookTime || '',
    totalTime: info.parsed.totalTime || '',
    notes: '',
    tags: [],
    source: { type: 'video', url: post.url },
    videoUrl: post.url,
    imageUrl: '',
  };
  return {
    draft,
    instagram: {
      fetched: Boolean(caption),
      caption,
      author: found.author,
      hasRecipe: info.hasRecipe,
      linkInBio: info.linkInBio,
      viaComment: info.viaComment,
    },
    cover: found.imageUrl ? await downloadImage(found.imageUrl) : null,
  };
}

module.exports = { importInstagram, parseInstagramUrl, parseEmbed, parsePreview, analyseCaption, titleFrom, deps };
