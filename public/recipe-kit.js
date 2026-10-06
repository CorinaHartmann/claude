/* Recipe Box shared logic: formatting, amounts and timers.
 * Used by the browser app (window.RecipeKit) and the server (require).
 * The claude.ai version in online/recipe-box.html carries the same code. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RecipeKit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// ---------- Amounts ----------
const FR = { '½': 1 / 2, '¼': 1 / 4, '¾': 3 / 4, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8 };
// Longest forms first: "1 1/2", then "1/2", then "1.5" / "1½", then "½".
const NUM = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:[.,]\\d+)?(?:\\s*[½¼¾⅓⅔⅛⅜⅝⅞])?|[½¼¾⅓⅔⅛⅜⅝⅞])';
const QTY = new RegExp(`^(${NUM})(\\s*(?:-|–|to)\\s*(${NUM}))?`);
function toNum(s) {
  let t = 0;
  for (const p of s.replace(',', '.').match(/\d+\/\d+|\d+(?:\.\d+)?|[½¼¾⅓⅔⅛⅜⅝⅞]/g) || []) {
    if (FR[p]) t += FR[p];
    else if (p.includes('/')) { const [a, b] = p.split('/').map(Number); t += b ? a / b : 0; }
    else t += Number(p);
  }
  return t;
}
function fmtQty(n) {
  const w = Math.floor(n), f = n - w;
  const g = [[0, ''], [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'], [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞'], [1, '']];
  for (const [v, s] of g) if (Math.abs(f - v) < 0.02) return ((v === 1 ? w + 1 : w) || '') + s || '0';
  const k = n >= 10 ? 10 : 100;
  return String(Math.round(n * k) / k);
}
// Round scaled amounts the way you'd measure them: 112.5 g -> 115 g, 4.8 eggs -> 5 eggs, 1.8 cups -> 1¾ cups.
const MEASURED = /^\s*(g|kg|mg|ml|cl|dl|l|oz|lb|cups?|tbsp|tsp|EL|TL|Msp\.?|Pck\.?|Prisen?|pinch(es)?|dash(es)?|stick(s)?|cans?|Dosen?|Becher|Bund|bunch(es)?|handful|Handvoll)\b/i;
function niceAmount(v, rest) {
  if (v >= 100) return String(Math.round(v / 5) * 5);
  if (v >= 10) return String(Math.round(v));
  const unit = MEASURED.exec(rest);
  const metric = unit && /^(g|mg|ml|cl)$/i.test(unit[1]);
  if (metric) return String(Math.max(1, Math.round(v)));
  const step = !unit && v >= 1 ? 2 : 4; // things you count: nearest ½; measures: nearest ¼
  const r = Math.max(1 / step, Math.round(v * step) / step);
  return fmtQty(r);
}

function scaleIngredient(line, factor) {
  // Returns the amount (scaled and rounded) and the rest of the line, or null when the line has no amount.
  const m = QTY.exec(line);
  if (!m) return null;
  const rest = line.slice(m[0].length);
  const qty = factor === 1 ? m[0] : niceAmount(toNum(m[1]) * factor, rest) + (m[3] ? `–${niceAmount(toNum(m[3]) * factor, rest)}` : '');
  return { qty, rest };
}

function cleanTags(v) {
  const out = [];
  for (const t of (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim().toLowerCase())) {
    if (t && !out.includes(t)) out.push(t.slice(0, 30));
  }
  return out.slice(0, 20);
}

// ---------- One house style for every recipe ----------
// Every recipe passes through normalizeRecipe() on save and on display, so a
// recipe looks the same whether it was pasted, read from a photo, typed or imported.
const UNIT_MAP = [
  [/^(tablespoons?|tbsps?|tbls?|tbs)$/i, 'tbsp'], [/^(teaspoons?|tsps?)$/i, 'tsp'],
  [/^(esslöffel|el)$/i, 'EL'], [/^(teelöffel|tl)$/i, 'TL'],
  [/^(grams?|gramm|grammes?|gr)$/i, 'g'], [/^(kilograms?|kilogramm|kilos?|kgs?)$/i, 'kg'],
  [/^(milliliters?|millilitres?|milliliter|mls?)$/i, 'ml'], [/^(centiliters?|centilitres?|cls?)$/i, 'cl'],
  [/^(liters?|litres?|liter|ltr|l)$/i, 'l'], [/^(ounces?|oz)$/i, 'oz'], [/^(pounds?|lbs?)$/i, 'lb'],
  [/^(cups?|c)$/i, null], [/^(messerspitzen?|msp)$/i, 'Msp.'], [/^(päckchen|pck|pkg|packung)$/i, 'Pck.'],
];
const NICE = { 0.5: '½', 0.25: '¼', 0.75: '¾', 1.5: '1½', 2.5: '2½', 0.33: '⅓', 0.66: '⅔', 0.67: '⅔' };
const oneLine = (v) => String(v ?? '').replace(/[ \t]+/g, ' ').replace(/\s+/g, ' ').trim();
const capFirst = (t) => t.replace(/^(\P{L}*)(\p{Ll})/u, (m, a, b) => a + b.toUpperCase());

function normQty(q) {
  // Exact halves/quarters/thirds become ½ ¼ ⅓; whole numbers stay; anything else keeps its original spelling.
  const n = toNum(q);
  if (!n) return q.trim();
  if (Number.isInteger(n)) return String(n);
  const f = fmtQty(n);
  return /[½¼¾⅓⅔⅛⅜⅝⅞]/.test(f) ? f : q.trim().replace(/\s+/g, ' ');
}

function normUnit(word, plural) {
  const bare = word.replace(/\.$/, '');
  for (const [re, out] of UNIT_MAP) {
    if (re.test(bare)) return out === null ? (plural ? 'cups' : 'cup') : out;
  }
  return null;
}

const HEADING_WORDS = /^(für|for|zum|zur|to|topping|glaze|glasur|teig|dough|sauce|soße|sosse|dressing|filling|füllung|frosting|creme|marinade|streusel|belag|garnish|deko)\b/i;

function normIngredient(raw) {
  let s = oneLine(raw).replace(/^([-*•·▪◦‣–—]|\[\s?[x ]?\]|\(\s*\)|☐|☑|✓|✔)\s*/i, '');
  if (!s) return '';
  // Headings: "## X", "For the sauce:", "Für den Teig"
  if (/^#+\s*/.test(s)) return `## ${capFirst(s.replace(/^#+\s*/, '').replace(/[:：]\s*$/, ''))}`;
  if (!/\d|[½¼¾⅓⅔⅛]/.test(s) && s.length <= 45 && (/[:：]$/.test(s) || (HEADING_WORDS.test(s) && /^(für|for|zum|zur|to)\b/i.test(s)))) {
    return `## ${capFirst(s.replace(/[:：]\s*$/, ''))}`;
  }
  s = s.replace(/^\d{1,2}[.)]\s+(?=\p{L})/u, ''); // list numbering, not an amount
  s = s.replace(/\s*[.;]$/, '');
  // "Flour: 200 g" / "Mehl, 200g" / "Eggs – 2" -> amount first
  const tail = new RegExp(`^(\\D.*?)\\s*[:,–—-]\\s*(${NUM}(?:\\s*(?:-|–|to|bis)\\s*${NUM})?)\\s*([\\p{L}.]*)$`, 'iu');
  const t = tail.exec(s);
  if (t && (!t[3] || normUnit(t[3], true) || t[3].length <= 4)) s = `${t[2]}${t[3] ? ' ' + t[3] : ''} ${t[1]}`;
  // Amount, range, unit
  const m = new RegExp(`^(${NUM})(?:\\s*(?:-|–|to|bis)\\s*(${NUM}))?\\s*`, 'u').exec(s);
  if (m) {
    let rest = s.slice(m[0].length);
    let qty = normQty(m[1]) + (m[2] ? `–${normQty(m[2])}` : '');
    const w = /^([\p{L}]+\.?)(?=\s|$|,)/u.exec(rest);
    if (w) {
      const plural = toNum(m[2] || m[1]) > 1;
      const unit = normUnit(w[1], plural);
      if (unit) rest = unit + rest.slice(w[1].length);
    }
    s = rest ? `${qty} ${rest}` : qty;
  }
  return s.replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ').trim();
}

function splitSteps(text) {
  // "1. Mix. 2. Bake." written as one paragraph -> separate steps
  return oneLine(text).split(/(?<=[.!?])\s+(?=(?:(?:step|schritt)\s*)?\d{1,2}\s*[.):]\s+\p{Lu})/iu);
}

function normStep(raw) {
  let s = oneLine(raw);
  if (!s) return '';
  if (/^#+\s*/.test(s)) return `## ${capFirst(s.replace(/^#+\s*/, '').replace(/[:：]\s*$/, ''))}`;
  s = s.replace(/^(?:(?:step|schritt)\s*\d+\s*[.):\-–]?|\d{1,2}\s*[.):])\s*/i, '');
  s = s.replace(/^([-*•·▪◦‣–—])\s*/, '');
  if (!s) return '';
  s = capFirst(s);
  if (/[:：]$/.test(s) && s.length <= 45 && !/\d/.test(s)) return `## ${s.replace(/[:：]$/, '')}`;
  if (!/[.!?…)"”]$/.test(s)) s += '.';
  return s;
}

function normTime(v) {
  const s = oneLine(v);
  if (!s) return '';
  let mins = 0, found = false;
  const iso = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i.exec(s);
  if (iso && /^P/i.test(s)) { mins = (+iso[1] || 0) * 1440 + (+iso[2] || 0) * 60 + (+iso[3] || 0); found = mins > 0; }
  if (!found) {
    const re = /(\d+(?:[.,]\d+)?|[½¼¾])\s*(d|days?|tage?n?|h|hrs?|hours?|std\.?|stunden?|m|mins?|minutes?|minuten|min\.?)(?![\p{L}])/giu;
    let x;
    while ((x = re.exec(s))) {
      const n = FR[x[1]] ?? parseFloat(x[1].replace(',', '.'));
      const u = x[2].toLowerCase();
      if (/^(d|day|tag)/.test(u)) mins += n * 1440;
      else if (/^(h|hr|hour|std|stund)/.test(u)) mins += n * 60;
      else mins += n;
      found = true;
    }
    if (!found && /^\d+$/.test(s)) { mins = +s; found = true; }
  }
  if (!found || !mins) return s;
  mins = Math.round(mins);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  return [d && `${d} d`, h && `${h} h`, m && `${m} min`].filter(Boolean).join(' ');
}

// Servings are always "<number> <what>": "Serves 4" -> "4 people", "für 4 Personen" -> "4 Personen", "Makes 24 cookies" -> "24 cookies".
function parseServings(v) {
  const s = oneLine(v).replace(/\.$/, '');
  const m = /(\d+(?:[.,]\d+)?)(?:\s*(?:-|–|to|bis)\s*(\d+(?:[.,]\d+)?))?\s*(.*)$/i.exec(s);
  const n = m ? parseFloat(m[1].replace(',', '.')) : 0;
  if (!n) return null;
  let unit = m[3].trim();
  if (!unit || /^(persons?|people)$/i.test(unit)) unit = 'people';
  else if (/^(pers\.?|leute)$/i.test(unit)) unit = 'Personen';
  return { n, max: m[2] ? parseFloat(m[2].replace(',', '.')) : 0, unit };
}
function servingsUnit(unit, n) {
  const pairs = [['people', 'person'], ['Personen', 'Person'], ['Portionen', 'Portion'], ['servings', 'serving'], ['portions', 'portion']];
  for (const [pl, sg] of pairs) if (unit.toLowerCase() === pl.toLowerCase() || unit.toLowerCase() === sg.toLowerCase()) return n === 1 ? sg : pl;
  if (n === 1 && /^[a-z]+s$/i.test(unit) && !/ss$/i.test(unit) && /^[\x00-\x7f]+$/.test(unit)) return unit.replace(/ies$/, 'y').replace(/s$/, '');
  return unit;
}
function normServings(v) {
  const p = parseServings(v);
  if (!p) return oneLine(v);
  return `${p.n}${p.max ? `–${p.max}` : ''} ${servingsUnit(p.unit, p.max || p.n)}`;
}

function normTitle(v) {
  let s = oneLine(v).replace(/^["'„“”‚‘’]+|["'“”‘’]+$/g, '');
  s = s.replace(/\s+[|·–—-]\s+[^|·–—-]*(rezept|recipe|chefkoch|kochen|küche|kitchen|food|\.de|\.com|\.at|\.ch)[^|·–—-]*$/i, '');
  s = s.replace(/\s+(rezept|recipe)$/i, '').replace(/^(rezept|recipe)\s*[:\-–]\s*/i, '');
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (letters.length > 3 && letters === letters.toUpperCase()) s = s.toLowerCase();
  return capFirst(s);
}

function normParagraph(v) {
  return String(v ?? '').replace(/\r\n?/g, '\n').split('\n').map(oneLine).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeRecipe(r) {
  const list = (a) => (Array.isArray(a) ? a : String(a || '').split('\n'));
  const steps = list(r.instructions).flatMap((x) => (/^#/.test(String(x).trim()) ? [x] : splitSteps(x))).map(normStep).filter(Boolean);
  return {
    ...r,
    title: normTitle(r.title) || 'Untitled recipe',
    description: normParagraph(r.description),
    ingredients: list(r.ingredients).map(normIngredient).filter(Boolean),
    instructions: steps,
    notes: normParagraph(r.notes),
    servings: normServings(r.servings),
    prepTime: normTime(r.prepTime), cookTime: normTime(r.cookTime), totalTime: normTime(r.totalTime),
    tags: cleanTags(r.tags || []).slice(0, 6),
  };
}


// ---------- Timers ----------
// Durations in step text: "15 minutes", "20–25 Min.", "1 Std. 30 Min.", "eine halbe Stunde".
const DNUM = '(\\d+(?:[.,]\\d+)?|½|¼|¾)';
const DUNIT = '(stunden|stunde|std\\.?|hours?|hrs?|h|minuten|minutes?|min\\.|mins?|sekunden|sek\\.?|seconds?|secs?)';
const DUR_RE = new RegExp(`${DNUM}(?:\\s*(?:-|–|bis|to|or|oder)\\s*${DNUM})?\\s*${DUNIT}(?![\\p{L}])`, 'giu');
const HALF_HOUR = /(half an hour|(?:eine[rn]?\s+)?halben?\s+stunde)/giu;
const unitSecs = (u) => (/^(st|h)/i.test(u) ? 3600 : /^(se|sek)/i.test(u) ? 1 : 60);
const dnum = (x) => FR[x] ?? parseFloat(String(x).replace(',', '.'));

function findDurations(text) {
  const out = [];
  let m;
  DUR_RE.lastIndex = 0;
  while ((m = DUR_RE.exec(text))) {
    const k = unitSecs(m[3]);
    out.push({ start: m.index, end: m.index + m[0].length, secs: Math.round(dnum(m[1]) * k), max: m[2] ? Math.round(dnum(m[2]) * k) : 0, unit: k });
  }
  HALF_HOUR.lastIndex = 0;
  while ((m = HALF_HOUR.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, secs: 1800, max: 0, unit: 60 });
  out.sort((a, b) => a.start - b.start);
  // "1 Std. 30 Min." / "1 hour and 30 minutes" -> one duration
  const merged = [];
  for (const d of out) {
    const prev = merged[merged.length - 1];
    if (prev && !prev.max && !d.max && prev.unit > d.unit && /^\s*(,|and|und)?\s*$/i.test(text.slice(prev.end, d.start))) {
      prev.end = d.end; prev.secs += d.secs; prev.unit = d.unit;
    } else merged.push({ ...d });
  }
  return merged.filter((d) => d.secs >= 5 && d.secs <= 48 * 3600);
}

function fmtDur(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h} h${m ? ` ${m} min` : ''}`;
  if (m) return `${m} min${s ? ` ${s} s` : ''}`;
  return `${s} s`;
}
function fmtClock(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}


// ---------- Shopping list ----------
// Units that can be added up across recipes, converted to a base unit.
const BASE_UNITS = { g: ['g', 1], kg: ['g', 1000], mg: ['g', 0.001], ml: ['ml', 1], cl: ['ml', 10], dl: ['ml', 100], l: ['ml', 1000] };
const UNIT_CANON = [
  [/^cups?$/i, 'cup'], [/^tbsp$/i, 'tbsp'], [/^tsp$/i, 'tsp'], [/^EL$/, 'EL'], [/^TL$/, 'TL'], [/^Msp\.?$/i, 'Msp.'], [/^Pck\.?$/i, 'Pck.'],
  [/^Prisen?$/i, 'Prise'], [/^pinch(es)?$/i, 'pinch'], [/^dash(es)?$/i, 'dash'], [/^sticks?$/i, 'stick'], [/^cans?$/i, 'can'],
  [/^Dosen?$/i, 'Dose'], [/^Becher$/i, 'Becher'], [/^Bund$/i, 'Bund'], [/^bunch(es)?$/i, 'bunch'], [/^handful$/i, 'handful'], [/^Handvoll$/i, 'Handvoll'],
  [/^oz$/i, 'oz'], [/^lb$/i, 'lb'],
];

function canonUnit(u) {
  if (BASE_UNITS[u.toLowerCase()]) return u.toLowerCase();
  for (const [re, out] of UNIT_CANON) if (re.test(u)) return out;
  return u;
}

// "200 g Mehl, gesiebt" -> { qty: 200, unit: 'g', name: 'Mehl' }. Ranges count their upper end.
function parseIngredientLine(line) {
  const s = oneLine(line);
  if (!s || s.startsWith('#')) return null;
  let qty = null, unit = '', rest = s;
  const m = QTY.exec(s);
  if (m) {
    qty = toNum(m[3] || m[1]) || null;
    rest = s.slice(m[0].length);
  }
  const u = MEASURED.exec(rest);
  if (u && qty !== null) {
    unit = canonUnit(u[1]);
    rest = rest.slice(u[0].length);
  }
  let name = rest.replace(/\s*\([^)]*\)/g, ' ').split(/,|;| - | – /)[0]
    .replace(/^\s*(of|de|d'|du|des|di|del|della|dello|degli|van)\s+/i, '').trim();
  if (!name) name = s;
  return { qty, unit, name };
}

function shoppingKey(name) {
  let k = name.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  // English plurals, so "2 lemons" and "1 lemon" end up together.
  if (/^[a-z ]+$/.test(k) && k.length > 3) k = k.replace(/ies$/, 'y').replace(/(oes|ches|shes|xes)$/, (x) => x.slice(0, -2)).replace(/([^s])s$/, '$1');
  return k;
}

// Add up an amount on the base unit, so 500 g + 1 kg = 1500 g.
function toBase(qty, unit) {
  const b = BASE_UNITS[unit];
  return b ? { qty: qty * b[1], unit: b[0] } : { qty, unit };
}

function formatAmount(qty, unit) {
  if (qty === null || qty === undefined) return '';
  let q = qty, u = unit;
  const quarters = (x) => Math.abs(x * 4 - Math.round(x * 4)) < 1e-6;
  // 1500 g -> 1½ kg, but 1200 g stays 1200 g rather than turning into a rounded 1¼ kg.
  if (u === 'g' && q >= 1000 && quarters(q / 1000)) { q /= 1000; u = 'kg'; }
  if (u === 'ml' && q >= 1000 && quarters(q / 1000)) { q /= 1000; u = 'l'; }
  let shown;
  if (q >= 10) shown = String(Math.round(q));
  else {
    const f = fmtQty(q); // "2½", "1" or, when it isn't a simple fraction, a decimal
    shown = f.includes('.') ? String(Math.round(q * 10) / 10) : f;
  }
  return u ? `${shown} ${u}` : shown;
}

// Supermarket sections, recognised by common words in the six app languages.
const CATEGORY_WORDS = {
  produce: 'apfel äpfel banane bananen zitrone zitronen limette orange birne beeren erdbeeren himbeeren heidelbeeren trauben tomate tomaten gurke paprika zucchini aubergine kartoffel kartoffeln süßkartoffel karotte karotten möhre möhren zwiebel zwiebeln knoblauch lauch porree sellerie salat spinat rucola brokkoli blumenkohl kohl pilze champignons avocado ingwer kräuter petersilie basilikum schnittlauch koriander minze dill rosmarin thymian kürbis mais erbsen bohnen datteln apple apples banana lemon lime orange pear berries strawberries raspberries blueberries grapes tomato tomatoes cucumber pepper peppers zucchini eggplant potato potatoes carrot carrots onion onions garlic leek celery lettuce spinach arugula broccoli cauliflower cabbage mushrooms avocado ginger herbs parsley basil chives cilantro coriander mint dill rosemary thyme pumpkin squash corn peas beans dates pomme citron poire fraises tomates concombre poivron courgette aubergine pomme de terre carotte oignon ail poireau salade épinards champignons persil basilic mela limone pera fragole pomodori cetriolo peperone zucchine melanzana patate carota cipolla aglio porro insalata spinaci funghi prezzemolo basilico manzana limón pera fresas tomate pepino pimiento calabacín berenjena patata zanahoria cebolla ajo puerro lechuga espinacas champiñones perejil albahaca appel citroen peer aardbeien tomaat komkommer paprika courgette aardappel wortel ui knoflook prei sla spinazie champignons peterselie basilicum',
  dairy: 'milch butter sahne schlagsahne schmand saure quark joghurt jogurt käse parmesan mozzarella feta frischkäse mascarpone ricotta eier ei crème fraîche milk butter cream yogurt yoghurt cheese parmesan mozzarella feta ricotta mascarpone eggs egg lait beurre crème yaourt fromage œufs oeufs latte burro panna yogurt formaggio uova leche mantequilla nata yogur queso huevos melk boter room yoghurt kaas eieren',
  meat: 'fleisch hackfleisch hack rind rindfleisch schwein schweinefleisch hähnchen hühnchen huhn pute speck schinken wurst lachs thunfisch fisch garnelen meat beef pork chicken turkey bacon ham sausage salmon tuna fish shrimp prawns viande bœuf boeuf porc poulet jambon saumon thon poisson crevettes carne manzo maiale pollo prosciutto salmone tonno pesce gamberi ternera cerdo jamón salmón atún pescado gambas vlees rundvlees varkensvlees kip ham zalm tonijn vis garnalen',
  bakery: 'brot brötchen toast baguette tortilla tortillas wraps bread rolls toast baguette pain pane pan brood',
  frozen: 'tiefkühl tk gefroren frozen surgelé surgelati congelado diepvries',
  drinks: 'wein rotwein weißwein bier saft wasser mineralwasser wine beer juice water vin bière jus eau vino birra succo acqua cerveza zumo agua wijn bier sap water',
  spices: 'salz pfeffer zimt paprikapulver curry kreuzkümmel muskat oregano chili vanille vanillezucker gewürz gewürze lorbeer salt pepper cinnamon paprika curry cumin nutmeg oregano chili vanilla spice spices sel poivre cannelle sale pepe cannella sal pimienta canela zout peper kaneel',
  pantry: 'mehl zucker puderzucker brauner backpulver natron hefe stärke speisestärke nudeln pasta spaghetti reis couscous linsen kichererbsen haferflocken öl olivenöl essig honig senf ketchup sojasauce brühe gemüsebrühe tomatenmark passierte dosentomaten kakao schokolade nüsse mandeln walnüsse haselnüsse kokosmilch flour sugar baking powder soda yeast starch cornstarch noodles pasta spaghetti rice couscous lentils chickpeas oats oil olive vinegar honey mustard ketchup soy stock broth paste cocoa chocolate nuts almonds walnuts hazelnuts coconut farine sucre levure pâtes riz lentilles huile vinaigre miel moutarde chocolat amandes farina zucchero lievito riso lenticchie olio aceto miele cioccolato mandorle harina azúcar levadura arroz lentejas aceite vinagre miel chocolate almendras bloem suiker gist rijst linzen olie azijn honing chocolade amandelen',
};
const CATEGORY_SETS = Object.fromEntries(Object.entries(CATEGORY_WORDS).map(([k, v]) => [k, new Set(v.split(' '))]));
const CATEGORY_ORDER = ['produce', 'bakery', 'meat', 'dairy', 'frozen', 'pantry', 'spices', 'drinks', 'other'];

function categorize(name) {
  const words = String(name).toLowerCase().match(/\p{L}+/gu) || [];
  // Later words usually name the thing ("gehackte Petersilie", "olive oil"), so check from the end.
  const has = (cat, w) => CATEGORY_SETS[cat]?.has(w) || CATEGORY_SETS[cat]?.has(shoppingKey(w));
  for (let i = words.length - 1; i >= 0; i--) {
    for (const cat of CATEGORY_ORDER) if (has(cat, words[i])) return cat;
  }
  // German compounds: "Weizenmehl", "Rinderhackfleisch" (ends with it), "Knoblauchzehen" (starts with it)
  const last = words[words.length - 1] || '';
  for (const test of [(w) => w.length >= 4 && last.endsWith(w), (w) => w.length >= 5 && last.startsWith(w)]) {
    for (const cat of CATEGORY_ORDER) {
      if (!CATEGORY_SETS[cat]) continue;
      for (const w of CATEGORY_SETS[cat]) if (test(w)) return cat;
    }
  }
  return 'other';
}

// ---------- Countries (Germany, Austria, Switzerland) ----------
const COUNTRIES = {
  DE: { currency: 'EUR', example: '10115 Berlin',
    chains: ['Aldi', 'Lidl', 'REWE', 'EDEKA', 'Kaufland', 'Netto', 'Penny'],
    sources: 'rewe.de, edeka.de, kaufland.de, lidl.de, aldi-nord.de / aldi-sued.de, netto-online.de, penny.de, and leaflet sites such as kaufDA or marktguru.de' },
  AT: { currency: 'EUR', example: '1010 Wien',
    chains: ['Hofer', 'Lidl', 'Billa', 'Spar', 'Penny', 'Interspar'],
    sources: 'billa.at, spar.at, hofer.at, lidl.at, penny.at, and leaflet sites such as aktionsfinder.at or marktguru.at' },
  CH: { currency: 'CHF', example: '8001 Zürich',
    chains: ['Migros', 'Coop', 'Denner', 'Aldi Suisse', 'Lidl', 'Volg', 'Spar'],
    sources: 'migros.ch, coop.ch, denner.ch, aldi-suisse.ch, lidl.ch, volg.ch, and price comparison sites for Swiss supermarkets' },
};

// ---------- Languages ----------
const LANGUAGES = {
  de: { name: 'Deutsch', english: 'German' },
  en: { name: 'English', english: 'English' },
  fr: { name: 'Français', english: 'French' },
  it: { name: 'Italiano', english: 'Italian' },
  es: { name: 'Español', english: 'Spanish' },
  nl: { name: 'Nederlands', english: 'Dutch' },
};

// Words that are common in recipes and (mostly) belong to one language.
const LANG_WORDS = {
  de: 'und mit für den dem der das die ein eine einen auf aus bis etwas mehl zucker eier ei butter milch salz pfeffer backen ofen minuten minute stunde std teig schüssel geben rühren verrühren hinzufügen vorheizen el tl prise zwiebel knoblauch sahne öl wasser etwa ca dann darauf danach lassen',
  en: 'and with the for of into until then flour sugar eggs egg butter milk salt pepper bake oven minutes minute hour bowl add stir mix preheat cup cups tbsp tsp pinch onion garlic cream oil water about let over',
  fr: 'et avec les des une pour dans puis farine sucre oeufs œufs oeuf beurre lait sel poivre cuire four minutes bol ajouter mélanger préchauffer cuillère pincée oignon ail crème huile eau environ laisser jusqu',
  it: 'e con il gli della dello delle per nel nella poi farina zucchero uova uovo burro latte sale pepe cuocere forno minuti ciotola aggiungere mescolare preriscaldare cucchiaio cucchiaini pizzico cipolla aglio panna olio acqua circa lasciare fino',
  es: 'y con los las del una para en luego harina azúcar huevos huevo mantequilla leche sal pimienta hornear horno minutos bol añadir mezclar precalentar cucharada cucharadita pizca cebolla ajo nata aceite agua aproximadamente dejar hasta',
  nl: 'en met het een voor van tot dan bloem suiker eieren ei boter melk zout peper bakken oven minuten kom toevoegen roeren mengen voorverwarmen eetlepel theelepel snufje ui knoflook room olie water ongeveer laten',
};
const LANG_SETS = Object.fromEntries(Object.entries(LANG_WORDS).map(([k, v]) => [k, new Set(v.split(' '))]));

// Best guess at the language of a recipe's text, or null when unsure.
function detectLang(r) {
  const text = [r.title, r.description, ...(r.ingredients || []), ...(r.instructions || []), r.notes].join(' ').toLowerCase();
  const words = text.match(/\p{L}+/gu) || [];
  if (words.length < 3) return null;
  const score = {};
  for (const w of words) for (const [k, set] of Object.entries(LANG_SETS)) if (set.has(w)) score[k] = (score[k] || 0) + 1;
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < 2) return null;
  if (ranked[1] && ranked[1][1] * 1.3 > ranked[0][1]) return null;
  return ranked[0][0];
}

return {
  QTY, toNum, fmtQty, niceAmount, scaleIngredient, cleanTags,
  normIngredient, normStep, normTime, normServings, parseServings, servingsUnit, normTitle, normalizeRecipe,
  findDurations, fmtDur, fmtClock,
  LANGUAGES, detectLang,
  parseIngredientLine, shoppingKey, toBase, formatAmount, categorize, CATEGORY_ORDER,
  COUNTRIES,
};
});
