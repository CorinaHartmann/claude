// Recipe Box front end. Plain JS, no build step.

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const view = $('#view');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// ---------- API ----------

async function request(method, path, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (body instanceof Blob || typeof body === 'string') opts.body = body;
    else {
      opts.body = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
    }
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error('Could not reach the Recipe Box server. Is it running?');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const api = {
  list: (params) => request('GET', `/api/recipes?${new URLSearchParams(params)}`),
  tags: () => request('GET', '/api/tags'),
  get: (id) => request('GET', `/api/recipes/${id}`),
  create: (r) => request('POST', '/api/recipes', r),
  update: (id, r) => request('PUT', `/api/recipes/${id}`, r),
  remove: (id) => request('DELETE', `/api/recipes/${id}`),
  importUrl: (url) => request('POST', '/api/import/url', { url }),
  importText: (text) => request('POST', '/api/import/text', { text }),
  config: () => request('GET', '/api/config'),
  aiExtract: (body) => request('POST', '/api/ai/extract', body),
  importBackup: (text) => request('POST', '/api/import/backup', text, { 'Content-Type': 'application/json' }),
  upload: (id, file) => request('POST', `/api/recipes/${id}/files`, file, {
    'Content-Type': file.type || 'application/octet-stream',
    'X-Filename': encodeURIComponent(file.name || 'file'),
  }),
  removeFile: (id, fileId) => request('DELETE', `/api/recipes/${id}/files/${fileId}`),
};

// ---------- State ----------

const state = {
  q: '',
  tag: '',
  favorite: false,
  draft: null, // unsaved recipe being created
  pendingFiles: [], // files to upload once the draft is saved
  ai: false, // Claude reading is available (server has an API key)
  cook: null, // recipe open in cooking mode
};

// ---------- Helpers ----------

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3200);
}

function fileUrl(a) {
  return `/files/${a.id}`;
}

function isImage(a) {
  return /^image\//.test(a.type);
}

function fileIcon(a) {
  const t = a.type || '';
  const n = (a.name || '').toLowerCase();
  if (t.startsWith('image/')) return '🖼️';
  if (t === 'application/pdf' || n.endsWith('.pdf')) return '📄';
  if (t.startsWith('video/')) return '🎬';
  if (t.startsWith('audio/')) return '🎙️';
  if (/\.(docx?|odt|rtf|pages)$/.test(n)) return '📝';
  if (/\.(xlsx?|csv|numbers|ods)$/.test(n)) return '📊';
  if (/\.(txt|md)$/.test(n) || t.startsWith('text/')) return '📃';
  return '📎';
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// What kind of thing is this recipe, mostly? Used for badges and placeholders.
function kindOf(r) {
  const files = r.attachments || [];
  if (r.source?.type === 'video' || r.videoUrl) return { icon: '🎬', label: 'Video' };
  if (r.source?.type === 'url') return { icon: '🔗', label: 'Web' };
  if (files.some((a) => a.type === 'application/pdf')) return { icon: '📄', label: 'PDF' };
  if (files.some(isImage)) return { icon: '📷', label: 'Photo' };
  if (files.length) return { icon: fileIcon(files[0]), label: 'File' };
  if (r.source?.type === 'text') return { icon: '📋', label: 'Text' };
  return { icon: '✍️', label: 'Written' };
}

function coverOf(r) {
  if (r.imageUrl) return r.imageUrl;
  const img = (r.attachments || []).find(isImage);
  if (img) return fileUrl(img);
  // YouTube publishes a thumbnail for every video; use it for video-only recipes.
  const yt = /youtube-nocookie\.com\/embed\/([\w-]+)/.exec(videoEmbed(r.videoUrl || '')?.src || '');
  return yt ? `https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg` : '';
}

function titleFromFilename(name) {
  const base = String(name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  // Camera names like "IMG 2041" aren't useful titles.
  return /^(img|dsc|pxl|photo|image|scan|screenshot)\b/i.test(base) || !base ? '' : base;
}

function findUrl(text) {
  const m = /https?:\/\/[^\s<>"']+/i.exec(text || '');
  return m ? m[0].replace(/[).,;!?]+$/, '') : '';
}

// ---------- Video embeds ----------

function videoEmbed(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m)\./, '');
  let m;
  if (host === 'youtu.be') {
    return { src: `https://www.youtube-nocookie.com/embed/${u.pathname.slice(1)}`, tall: false };
  }
  if (host.endsWith('youtube.com')) {
    const id = u.searchParams.get('v') || (m = /^\/(shorts|embed|live)\/([\w-]+)/.exec(u.pathname)) && m[2];
    if (id) return { src: `https://www.youtube-nocookie.com/embed/${id}`, tall: u.pathname.startsWith('/shorts') };
  }
  if (host.endsWith('vimeo.com') && (m = /\/(\d+)/.exec(u.pathname))) {
    return { src: `https://player.vimeo.com/video/${m[1]}`, tall: false };
  }
  if (host.endsWith('tiktok.com') && (m = /\/video\/(\d+)/.exec(u.pathname))) {
    return { src: `https://www.tiktok.com/embed/v2/${m[1]}`, tall: true };
  }
  if (host.endsWith('instagram.com') && (m = /^\/(p|reel|reels|tv)\/([\w-]+)/.exec(u.pathname))) {
    return { src: `https://www.instagram.com/${m[1] === 'reels' ? 'reel' : m[1]}/${m[2]}/embed`, tall: true };
  }
  return null;
}

// ---------- Amounts, formatting and timers (shared with the server: recipe-kit.js) ----------

const Kit = window.RecipeKit;

function ingredientHtml(line, factor) {
  const s = Kit.scaleIngredient(line, factor);
  return s ? `<b>${esc(s.qty)}</b>${esc(s.rest)}` : esc(line);
}

// Step text with each duration as a tappable "start timer" chip.
function stepWithTimers(text, label) {
  let html = '', at = 0;
  for (const d of Kit.findDurations(text)) {
    html += esc(text.slice(at, d.start));
    html += `<button class="tchip" data-tstart="${d.secs}" data-tlabel="${esc(label)}" title="Start a ${esc(Kit.fmtDur(d.secs))} timer">${esc(text.slice(d.start, d.end))} ⏱</button>`;
    at = d.end;
  }
  return html + esc(text.slice(at));
}

// Servings stepper: count in the recipe's own unit ("10 slices", "4 people"), or batches if none is given.
const servingsPick = new Map();
function servingsBase(r) {
  const p = Kit.parseServings(r.servings);
  return p ? { n: p.n, unit: p.unit, step: p.n >= 2 ? 1 : 0.5, batch: false } : { n: 1, unit: 'batch', step: 0.5, batch: true };
}
const pickedServings = (r) => servingsPick.get(r.id) ?? servingsBase(r).n;
const servingsFactor = (r) => pickedServings(r) / servingsBase(r).n;
function amountLabel(r, n = pickedServings(r)) {
  const b = servingsBase(r);
  if (b.batch) return `${Kit.fmtQty(n)} ${n === 1 ? 'batch' : 'batches'}`;
  return `${Kit.fmtQty(n)} ${Kit.servingsUnit(b.unit, n)}`;
}
function servingsStepper(r) {
  const b = servingsBase(r);
  const n = pickedServings(r);
  return `<div class="servings" role="group" aria-label="Amount to make">
      <button data-serv="-1" aria-label="Make less" ${n - b.step < b.step ? 'disabled' : ''}>−</button>
      <span class="sv" aria-live="polite">${esc(amountLabel(r, n))}</span>
      <button data-serv="1" aria-label="Make more">+</button>
    </div>
    ${n !== b.n ? `<button class="btn ghost small" data-servreset>Back to ${esc(amountLabel(r, b.n))}</button>` : ''}
    ${b.batch ? '<small class="muted" style="flex-basis:100%">Add servings (e.g. "4 people" or "20 slices") under Edit to scale by people or pieces.</small>' : ''}`;
}

// ---------- Router ----------

function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  render();
}

async function render() {
  $('#menu').hidden = true;
  view.onclick = null;
  view.onchange = null;
  const path = location.pathname;
  let m;
  try {
    if (path === '/share') return handleShare();
    if (path === '/new') return renderEditor(null);
    if ((m = /^\/recipe\/([a-f0-9]+)\/edit$/.exec(path))) return renderEditor(Kit.normalizeRecipe(await api.get(m[1])));
    if ((m = /^\/recipe\/([a-f0-9]+)$/.exec(path))) return renderRecipe(Kit.normalizeRecipe(await api.get(m[1])));
    return renderLibrary();
  } catch (err) {
    view.innerHTML = `
      <div class="empty">
        <div class="big">🥄</div>
        <h2>${esc(err.message)}</h2>
        <p><a href="/" data-link>Back to all recipes</a></p>
      </div>`;
  }
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', render);

// ---------- Library ----------

async function renderLibrary() {
  document.title = 'Recipe Box';
  const [recipes, tags] = await Promise.all([
    api.list({ q: state.q, tag: state.tag, favorite: state.favorite ? '1' : '' }),
    api.tags(),
  ]);
  if (location.pathname !== '/') return; // navigated away while loading

  const filtering = state.q || state.tag || state.favorite;
  const chips = `
    <div class="filters" role="toolbar" aria-label="Filter recipes">
      <button class="chip" data-filter="all" aria-pressed="${!state.tag && !state.favorite}">All</button>
      <button class="chip" data-filter="fav" aria-pressed="${state.favorite}">★ Favorites</button>
      ${tags.map((t) => `<button class="chip" data-tag="${esc(t.name)}" aria-pressed="${state.tag === t.name}">${esc(t.name)}<span class="count">${t.count}</span></button>`).join('')}
    </div>`;

  if (!recipes.length && !filtering) {
    view.innerHTML = `
      <div class="empty">
        <div class="big">📖</div>
        <h2>Your recipe box is empty</h2>
        <p>Save recipes from anywhere, in any format — they all end up here, searchable and in one place.</p>
        <div class="formats">
          <span class="badge kind">🔗 Websites</span>
          <span class="badge kind">🎬 YouTube · TikTok · Instagram</span>
          <span class="badge kind">📷 Photos & scans</span>
          <span class="badge kind">📄 PDFs & documents</span>
          <span class="badge kind">📋 Pasted text</span>
          <span class="badge kind">✍️ Typed by hand</span>
        </div>
        <button class="btn primary" data-open-add>Add your first recipe</button>
        <p class="muted" style="font-size:14px;margin-top:18px">Tip: you can also drag files or links onto this page, or paste with Ctrl/⌘+V.</p>
      </div>`;
    return;
  }

  view.innerHTML = `${chips}
    ${recipes.length ? `<div class="grid">${recipes.map(card).join('')}</div>`
    : `<div class="empty"><div class="big">🔍</div><h2>No matches</h2><p>Try a different search or filter.</p></div>`}`;
  hideBrokenImages(view);
}

function card(r) {
  const kind = kindOf(r);
  const cover = coverOf(r);
  return `
    <a class="card" href="/recipe/${r.id}" data-link>
      <div class="thumb">
        ${kind.icon}
        ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
        ${r.favorite ? '<span class="fav" aria-label="Favorite">⭐</span>' : ''}
      </div>
      <div class="card-body">
        <div class="card-title">${esc(r.title)}</div>
        <div class="card-meta">
          <span class="badge kind">${kind.icon} ${kind.label}</span>
          ${r.totalTime ? `<span class="badge">⏱ ${esc(r.totalTime)}</span>` : ''}
          ${(r.tags || []).slice(0, 2).map((t) => `<span class="badge">${esc(t)}</span>`).join('')}
        </div>
      </div>
    </a>`;
}

function hideBrokenImages(root) {
  $$('img', root).forEach((img) => {
    img.addEventListener('error', () => img.remove(), { once: true });
  });
}

view.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip && location.pathname === '/') {
    if (chip.dataset.filter === 'all') {
      state.tag = '';
      state.favorite = false;
    } else if (chip.dataset.filter === 'fav') {
      state.favorite = !state.favorite;
    } else {
      state.tag = state.tag === chip.dataset.tag ? '' : chip.dataset.tag;
    }
    renderLibrary();
  }
  if (e.target.closest('[data-open-add]')) openAdd();
});

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    if (location.pathname !== '/') navigate('/');
    else renderLibrary();
  }, 180);
});

// ---------- Recipe detail ----------

function listHtml(items, kind, factor = 1, title = '') {
  let n = 0;
  return items.map((line) => {
    if (line.startsWith('## ')) return `<li class="group">${esc(line.slice(3))}</li>`;
    if (kind === 'ingredients') {
      return `<li><label><input type="checkbox"><span>${ingredientHtml(line, factor)}</span></label></li>`;
    }
    n++;
    return `<li class="step">${stepWithTimers(line, `Step ${n} · ${title}`)}</li>`;
  }).join('');
}

function attachmentHtml(r, a) {
  const url = fileUrl(a);
  const remove = `<button class="btn ghost small" data-remove-file="${a.id}" aria-label="Remove ${esc(a.name)}">✕</button>`;
  const cover = isImage(a) && r.imageUrl !== url
    ? `<button class="btn ghost small" data-cover="${a.id}" title="Use as cover photo">Cover</button>` : '';
  const name = `<div class="name"><span title="${esc(a.name)}">${esc(a.name)}</span><span class="row">${cover}${remove}</span></div>`;
  if (a.type === 'application/pdf') {
    return `<div class="file wide"><iframe src="${url}" title="${esc(a.name)}" loading="lazy"></iframe>${name}</div>`;
  }
  if (a.type.startsWith('video/')) {
    return `<div class="file wide"><video src="${url}" controls preload="metadata" playsinline></video>${name}</div>`;
  }
  if (a.type.startsWith('audio/')) {
    return `<div class="file"><audio src="${url}" controls preload="metadata"></audio>${name}</div>`;
  }
  return `
    <div class="file">
      <a class="preview" href="${url}" target="_blank" rel="noopener">
        ${fileIcon(a)}
        ${isImage(a) ? `<img src="${url}" alt="${esc(a.name)}" loading="lazy">` : ''}
      </a>
      ${name}
    </div>`;
}

function renderRecipe(r) {
  document.title = `${r.title} · Recipe Box`;
  const embed = r.videoUrl ? videoEmbed(r.videoUrl) : null;
  const cover = r.imageUrl && !(embed && r.source?.type === 'video') ? r.imageUrl : '';
  const scalable = r.ingredients.some((l) => Kit.QTY.test(l));
  const facts = [['Makes', scalable ? '' : r.servings], ['Prep', r.prepTime], ['Cook', r.cookTime], ['Total', r.totalTime]]
    .filter(([, v]) => v);
  const hasBody = r.ingredients.length || r.instructions.length;
  const factor = servingsFactor(r);

  view.innerHTML = `
    <article class="recipe">
      <a href="/" class="back" data-link>← All recipes</a>
      ${cover ? `<img class="hero" src="${esc(cover)}" alt="" referrerpolicy="no-referrer">` : ''}
      <div class="recipe-head">
        <h1>${esc(r.title)}</h1>
        <div class="actions">
          <button class="btn icon ghost" data-action="fav" aria-pressed="${r.favorite}" title="${r.favorite ? 'Remove from favorites' : 'Add to favorites'}">${r.favorite ? '⭐' : '☆'}</button>
          <a class="btn" href="/recipe/${r.id}/edit" data-link>Edit</a>
          <button class="btn" data-action="print">Print</button>
          <button class="btn danger" data-action="delete">Delete</button>
        </div>
      </div>
      <div class="stars" role="group" aria-label="Rating">
        ${[1, 2, 3, 4, 5].map((n) => `<button data-rate="${n}" class="${n <= r.rating ? 'on' : ''}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}
      </div>
      ${r.source?.url ? `<div class="source">From <a href="${esc(r.source.url)}" target="_blank" rel="noopener">${esc(hostOf(r.source.url))}</a></div>` : ''}
      ${r.tags.length ? `<div class="tags">${r.tags.map((t) => `<span class="badge">${esc(t)}</span>`).join('')}</div>` : ''}
      ${r.description ? `<p class="description">${esc(r.description)}</p>` : ''}
      ${facts.length ? `<div class="facts">${facts.map(([k, v]) => `<div class="fact"><small>${k}</small>${esc(v)}</div>`).join('')}</div>` : ''}

      ${embed ? `<div class="video${embed.tall ? ' tall' : ''}"><iframe src="${esc(embed.src)}" title="Recipe video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe></div>`
      : r.videoUrl ? `<a class="video-link" href="${esc(r.videoUrl)}" target="_blank" rel="noopener"><span class="play">▶</span><span><strong>Watch the video</strong><small>${esc(hostOf(r.videoUrl))}</small></span></a>` : ''}

      ${r.instructions.some((l) => !l.startsWith('## ')) ? '<button class="btn primary cook-start" data-cook>▶ Start cooking</button>' : ''}
      ${hasBody ? `
      <div class="columns">
        <section>
          <div class="section-title">
            <h2>Ingredients</h2>
            ${scalable ? servingsStepper(r) : ''}
          </div>
          ${r.ingredients.length ? `<ul class="ingredients">${listHtml(r.ingredients, 'ingredients', factor)}</ul>` : '<p class="muted">No ingredients listed.</p>'}
        </section>
        <section>
          <div class="section-title"><h2>Steps</h2></div>
          ${r.instructions.length ? `<ol class="steps">${listHtml(r.instructions, 'steps', 1, r.title)}</ol>` : '<p class="muted">No steps listed.</p>'}
        </section>
      </div>` : ''}

      ${r.notes ? `<div class="notes"><strong>Notes</strong><br>${esc(r.notes)}</div>` : ''}

      <section class="attachments">
        <div class="section-title">
          <h2>Files & photos</h2>
          <label class="btn small">
            <input type="file" multiple hidden data-add-files>
            + Add files
          </label>
        </div>
        ${r.attachments.length ? `<div class="files">${r.attachments.map((a) => attachmentHtml(r, a)).join('')}</div>`
        : `<p class="muted">${hasBody ? 'Attach photos of the finished dish, a scan of the original, or anything else.' : 'Nothing here yet. Add a photo, PDF or any file — or edit the recipe to type out the ingredients and steps.'}</p>`}
      </section>
    </article>`;
  hideBrokenImages(view);
  const hero = $('.hero', view);
  hero?.addEventListener('error', () => hero.remove(), { once: true });

  const save = async (patch, msg) => {
    try {
      Object.assign(r, Kit.normalizeRecipe(await api.update(r.id, patch)));
      if (msg) toast(msg);
      renderRecipe(r);
    } catch (err) {
      toast(err.message);
    }
  };

  view.onclick = async (e) => {
    const t = e.target;
    if (t.closest('[data-tstart]')) return; // timers are handled globally
    if (t.closest('[data-cook]')) return openCook(r);
    const serv = t.closest('[data-serv]');
    if (serv) {
      const b = servingsBase(r);
      servingsPick.set(r.id, Math.max(b.step, pickedServings(r) + Number(serv.dataset.serv) * b.step));
      return renderRecipe(r);
    }
    if (t.closest('[data-servreset]')) { servingsPick.delete(r.id); return renderRecipe(r); }
    const action = t.closest('[data-action]')?.dataset.action;
    if (action === 'fav') return save({ favorite: !r.favorite }, r.favorite ? 'Removed from favorites' : 'Added to favorites');
    if (action === 'print') return window.print();
    if (action === 'delete') {
      if (!confirm(`Delete "${r.title}" and all its files? This can't be undone.`)) return;
      await api.remove(r.id);
      toast('Recipe deleted');
      return navigate('/', { replace: true });
    }
    const rate = t.closest('[data-rate]');
    if (rate) {
      const n = Number(rate.dataset.rate);
      return save({ rating: n === r.rating ? 0 : n });
    }
    const step = t.closest('li.step');
    if (step) return step.classList.toggle('done');
    const rm = t.closest('[data-remove-file]');
    if (rm) {
      if (!confirm('Remove this file?')) return;
      const fileId = rm.dataset.removeFile;
      await api.removeFile(r.id, fileId);
      const wasCover = r.imageUrl === `/files/${fileId}`;
      if (wasCover) await api.update(r.id, { imageUrl: '' });
      return renderRecipe(Kit.normalizeRecipe(await api.get(r.id)));
    }
    const cov = t.closest('[data-cover]');
    if (cov) return save({ imageUrl: `/files/${cov.dataset.cover}` }, 'Cover photo updated');
  };

  view.onchange = async (e) => {
    if (!e.target.matches('[data-add-files]')) return;
    const files = [...e.target.files];
    if (!files.length) return;
    await uploadAll(r.id, files);
    renderRecipe(Kit.normalizeRecipe(await api.get(r.id)));
  };
}

async function uploadAll(id, files, onProgress) {
  let done = 0;
  for (const file of files) {
    onProgress?.(done, files.length, file);
    try {
      await api.upload(id, file);
    } catch (err) {
      toast(`${file.name}: ${err.message}`);
    }
    done++;
  }
  if (!onProgress) toast(`Added ${files.length} file${files.length > 1 ? 's' : ''}`);
}

// ---------- Editor ----------

function renderEditor(existing) {
  const isNew = !existing;
  if (isNew && !state.draft) {
    state.draft = {};
    state.pendingFiles = [];
  }
  const r = existing || state.draft;
  document.title = `${isNew ? 'New recipe' : `Edit ${r.title}`} · Recipe Box`;
  const lines = (v) => esc((v || []).join('\n'));
  const val = (v) => esc(v ?? '');

  const empty = !r.ingredients?.length && !r.instructions?.length;
  const photos = () => (isNew ? state.pendingFiles.filter((f) => /^image\//.test(f.type)) : (r.attachments || []).filter(isImage));
  const pasteBox = (lead) => `<div class="import-note paste-note"><span>${lead}</span>
      <textarea id="paste-in" rows="5" placeholder="Paste the recipe here" aria-label="Recipe text"></textarea>
      <div class="row wrap"><button type="button" class="btn primary small" data-readtext>${state.ai ? '✨ Fill in with Claude' : 'Fill in'}</button>
      ${state.ai ? '<button type="button" class="btn small" data-readphotos hidden>✨ Read from photos instead</button>' : ''}</div></div>`;
  let note = '';
  if (isNew && r.source?.type === 'url' && r.structured === false && empty) {
    note = pasteBox(`This page didn't include a structured recipe, so only the title and picture were saved. Copy the recipe from <a href="${esc(r.source.url)}" target="_blank" rel="noopener">the page</a> and paste it here${state.ai ? ', or add a screenshot below and let Claude read it' : ''}.`);
  } else if (isNew && r.source?.type === 'video' && empty) {
    note = pasteBox('Video saved. If the recipe is in the caption or description, copy it and paste it here.');
  } else if (isNew && !empty && !r.filled) {
    note = `<div class="import-note">Found ${r.ingredients?.length || 0} ingredients and ${r.instructions?.length || 0} steps. Check them over, then save.</div>`;
  } else if (empty) {
    note = pasteBox(`Have the recipe as text${state.ai ? ' or photos' : ''}? Paste the text here${state.ai ? ' and Claude will sort it into ingredients and steps' : ''}, or fill in the fields below.`);
  }

  view.innerHTML = `
    <form class="editor" id="editor" novalidate>
      <a href="${isNew ? '/' : `/recipe/${r.id}`}" class="back" data-link>← ${isNew ? 'Cancel' : 'Back to recipe'}</a>
      <h1>${isNew ? 'New recipe' : 'Edit recipe'}</h1>
      ${note}
      <label class="field"><span>Title</span>
        <input name="title" value="${val(r.title)}" placeholder="Recipe name" required></label>
      <label class="field"><span>Description</span>
        <textarea name="description" rows="2" placeholder="A few words about this recipe">${val(r.description)}</textarea></label>
      <div class="grid-2">
        <label class="field"><span>Ingredients</span>
          <textarea name="ingredients" rows="10" placeholder="One ingredient per line">${lines(r.ingredients)}</textarea>
          <small>One per line. Start a line with ## to make a group heading.</small></label>
        <label class="field"><span>Steps</span>
          <textarea name="instructions" rows="10" placeholder="One step per line">${lines(r.instructions)}</textarea>
          <small>One step per line.</small></label>
      </div>
      <div class="grid-3">
        <label class="field"><span>Makes</span><input name="servings" value="${val(r.servings)}" placeholder="e.g. 4 people, 20 slices"></label>
        <label class="field"><span>Prep time</span><input name="prepTime" value="${val(r.prepTime)}" placeholder="e.g. 15 min"></label>
        <label class="field"><span>Cook time</span><input name="cookTime" value="${val(r.cookTime)}" placeholder="e.g. 30 min"></label>
        <label class="field"><span>Total time</span><input name="totalTime" value="${val(r.totalTime)}" placeholder="e.g. 45 min"></label>
      </div>
      <label class="field"><span>Tags</span>
        <input name="tags" value="${val((r.tags || []).join(', '))}" placeholder="e.g. dessert, baking" list="tag-list">
        <small>Separate with commas.</small></label>
      <label class="field"><span>Notes</span>
        <textarea name="notes" rows="3" placeholder="Substitutions, tweaks, who loved it…">${val(r.notes)}</textarea></label>
      <div class="grid-2">
        <label class="field"><span>Source link</span><input name="sourceUrl" type="url" value="${val(r.source?.url)}" placeholder="https://…"></label>
        <label class="field"><span>Video link</span><input name="videoUrl" type="url" value="${val(r.videoUrl)}" placeholder="YouTube, TikTok, Instagram…"></label>
      </div>
      <label class="field"><span>Cover image link</span><input name="imageUrl" value="${val(r.imageUrl)}" placeholder="https://… (or pick a cover from attached photos)"></label>
      ${isNew ? `
      <div class="field"><span>Files & photos</span>
        <div class="pending-files" id="pending"></div>
        <div><label class="btn small"><input type="file" multiple hidden id="pending-input">+ Add files</label></div>
      </div>` : ''}
      <div class="editor-actions">
        <a class="btn ghost" href="${isNew ? '/' : `/recipe/${r.id}`}" data-link>Cancel</a>
        <button class="btn primary" type="submit" id="save-btn">Save recipe</button>
      </div>
    </form>`;

  const form = $('#editor');
  const title = form.elements.title;
  if (!title.value) title.focus();

  const drawPending = () => {
    const box = $('#pending');
    if (!box) return;
    box.innerHTML = state.pendingFiles.map((f, i) => `
      <span class="badge">${fileIcon({ type: f.type, name: f.name })} ${esc(f.name)} · ${formatSize(f.size)}
        <button type="button" data-unpend="${i}" aria-label="Remove ${esc(f.name)}">✕</button></span>`).join('')
      || '<span class="muted" style="font-size:14px">No files attached.</span>';
    const rp = $('[data-readphotos]');
    if (rp) rp.hidden = !photos().length;
  };
  drawPending();
  if (!isNew) { const rp = $('[data-readphotos]'); if (rp) rp.hidden = !photos().length; }

  // Put extracted fields into the form; anything already typed stays.
  const fill = (d, message) => {
    const f = form.elements;
    const keep = (name, value) => { if (!f[name].value.trim() && value) f[name].value = value; };
    const typed = f.title.value.trim();
    if (!typed || typed === r.autoTitle || /^untitled/i.test(typed)) f.title.value = d.title || typed;
    keep('description', d.description);
    keep('ingredients', (d.ingredients || []).join('\n'));
    keep('instructions', (d.instructions || []).join('\n'));
    for (const k of ['servings', 'prepTime', 'cookTime', 'totalTime', 'notes']) keep(k, d[k]);
    keep('tags', (d.tags || []).join(', '));
    const n = $('.paste-note');
    if (n) n.outerHTML = `<div class="import-note">${esc(message)}</div>`;
  };
  const busy = (btn, label) => { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>${label}`; };
  const idle = (btn, label) => { btn.disabled = false; btn.textContent = label; };

  form.onclick = async (e) => {
    const un = e.target.closest('[data-unpend]');
    if (un) {
      state.pendingFiles.splice(Number(un.dataset.unpend), 1);
      drawPending();
    }
    const rt = e.target.closest('[data-readtext]');
    if (rt) {
      const text = $('#paste-in').value.trim();
      if (!text) { toast('Paste the recipe text into the box first.'); return $('#paste-in').focus(); }
      busy(rt, 'Reading…');
      try {
        const d = state.ai ? await api.aiExtract({ text }).catch(() => api.importText(text)) : await api.importText(text);
        if (!d.ingredients?.length && !d.instructions?.length) { toast('No recipe found in that text. Copy the part with the ingredients and steps.'); return idle(rt, 'Try again'); }
        fill(d, 'Filled in from the text. Check it over, then save.');
      } catch (err) { toast(err.message); idle(rt, 'Try again'); }
    }
    const rp = e.target.closest('[data-readphotos]');
    if (rp) {
      busy(rp, 'Reading… this can take up to a minute');
      try {
        const blobs = isNew ? photos() : await Promise.all(photos().map(async (a) => (await fetch(fileUrl(a))).blob()));
        const images = [];
        for (const b of blobs.slice(0, 6)) images.push(await imageForClaude(b));
        const d = await api.aiExtract({ images });
        if (!d.ingredients?.length && !d.instructions?.length) { toast('Claude couldn\u2019t find a recipe in those photos.'); return idle(rp, 'Try again'); }
        fill(d, 'Filled in from your photos. Check it over, then save.');
      } catch (err) { toast(err.message); idle(rp, '✨ Try again'); }
    }
  };
  form.onchange = (e) => {
    if (e.target.id === 'pending-input') {
      state.pendingFiles.push(...e.target.files);
      e.target.value = '';
      drawPending();
    }
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    const body = {
      title: f.title.value,
      description: f.description.value,
      ingredients: f.ingredients.value.split('\n'),
      instructions: f.instructions.value.split('\n'),
      servings: f.servings.value,
      prepTime: f.prepTime.value,
      cookTime: f.cookTime.value,
      totalTime: f.totalTime.value,
      tags: f.tags.value,
      notes: f.notes.value,
      videoUrl: f.videoUrl.value.trim(),
      imageUrl: f.imageUrl.value.trim(),
      source: {
        type: r.source?.type || (f.videoUrl.value ? 'video' : f.sourceUrl.value ? 'url' : 'manual'),
        url: f.sourceUrl.value.trim(),
      },
    };
    const btn = $('#save-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Saving…';
    try {
      if (isNew) {
        const created = await api.create(body);
        const files = state.pendingFiles;
        if (files.length) {
          await uploadAll(created.id, files, (done, total) => {
            btn.innerHTML = `<span class="spinner"></span>Uploading ${done + 1} of ${total}…`;
          });
        }
        state.draft = null;
        state.pendingFiles = [];
        toast('Recipe saved');
        navigate(`/recipe/${created.id}`, { replace: true });
      } else {
        await api.update(r.id, body);
        toast('Changes saved');
        navigate(`/recipe/${r.id}`, { replace: true });
      }
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = 'Save recipe';
    }
  };
}

// ---------- Adding recipes ----------

const dialog = $('#add-dialog');
const status = $('#add-status');

function setStatus(msg, { error = false, busy = false, html = false } = {}) {
  status.classList.toggle('error', error);
  const text = html ? msg : esc(msg);
  status.innerHTML = busy ? `<span class="spinner"></span>${text}` : text;
}

function selectTab(name) {
  $$('.tabs [role="tab"]', dialog).forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $$('.tab-panel', dialog).forEach((p) => { p.hidden = p.dataset.panel !== name; });
  setStatus('');
}

function openAdd(tab = 'link') {
  selectTab(tab);
  if (!dialog.open) dialog.showModal();
  const focusable = { link: '#link-input', text: '#text-input', manual: '#manual-btn' }[tab];
  if (focusable) setTimeout(() => $(focusable).focus(), 30);
}

function startDraft(draft, files = []) {
  state.draft = draft;
  state.pendingFiles = files;
  if (dialog.open) dialog.close();
  $('#link-input').value = '';
  $('#text-input').value = '';
  navigate('/new');
}

$('#add-btn').addEventListener('click', () => openAdd());
$$('.tabs [role="tab"]', dialog).forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
// Clicking the backdrop closes the dialog.
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

async function importLink(url) {
  openAdd('link');
  $('#link-input').value = url;
  setStatus('Fetching the recipe…', { busy: true });
  try {
    const draft = await api.importUrl(url);
    startDraft(draft);
  } catch (err) {
    setStatus(`${esc(err.message)}. <button class="btn small" id="save-link-anyway">Save the link anyway</button>`, { error: true, html: true });
    $('#save-link-anyway').onclick = () => {
      const video = Boolean(videoEmbed(url)) || /tiktok|instagram|youtu|vimeo|facebook/i.test(url);
      startDraft({
        title: hostOf(url),
        source: { type: video ? 'video' : 'url', url },
        videoUrl: video ? url : '',
      });
    };
  }
}

$('#link-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('#link-input').value.trim();
  if (url) importLink(/^https?:\/\//i.test(url) ? url : `https://${url}`);
});

async function importText(text) {
  openAdd('text');
  $('#text-input').value = text;
  setStatus(state.ai ? 'Claude is reading your recipe…' : 'Reading your recipe…', { busy: true });
  try {
    let draft = null;
    if (state.ai) {
      // Claude copes with messy page text; the built-in splitter is the fallback.
      draft = await api.aiExtract({ text }).catch(() => null);
      if (draft && !draft.ingredients?.length && !draft.instructions?.length) draft = null;
      if (draft) draft.filled = true;
    }
    startDraft(draft || await api.importText(text));
  } catch (err) {
    setStatus(err.message, { error: true });
  }
}

// Photos are shrunk to JPEG before going to Claude.
async function imageForClaude(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.85);
  return { type: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
}

$('#text-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#text-input').value.trim();
  if (text) importText(text);
});

$('#manual-btn').addEventListener('click', () => startDraft({ source: { type: 'manual', url: '' } }));

const TEXT_FILE = /\.(txt|md|markdown|text)$/i;

// Files become a new draft. A single text file is read and parsed instead.
async function handleFiles(fileList) {
  const files = [...fileList].filter((f) => f.size > 0 || f.type);
  if (!files.length) return;
  if (files.length === 1 && (TEXT_FILE.test(files[0].name) || files[0].type === 'text/plain')) {
    const text = await files[0].text();
    return importText(text);
  }
  const title = titleFromFilename(files[0].name);
  startDraft({ title, source: { type: 'file', url: '' } }, files);
}

$('#file-input').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
$('#camera-input').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });

const dropzone = $('#dropzone');
['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
  e.preventDefault();
  dropzone.classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, () => dropzone.classList.remove('over')));

// Drag & drop anywhere on the page: files, or a link dragged from another tab.
const overlay = $('#drop-overlay');
let dragDepth = 0;
const draggingSomethingUseful = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === 'Files' || t === 'text/uri-list');

window.addEventListener('dragenter', (e) => {
  if (!draggingSomethingUseful(e)) return;
  dragDepth++;
  if (!dialog.open) overlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) overlay.hidden = true;
});
window.addEventListener('dragover', (e) => { if (draggingSomethingUseful(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!draggingSomethingUseful(e)) return;
  e.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  // Dropping onto a recipe page adds the files to that recipe.
  const onRecipe = /^\/recipe\/([a-f0-9]+)$/.exec(location.pathname);
  if (e.dataTransfer.files.length) {
    if (onRecipe && !dialog.open) {
      const files = [...e.dataTransfer.files];
      return uploadAll(onRecipe[1], files).then(render);
    }
    return handleFiles(e.dataTransfer.files);
  }
  const url = findUrl(e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'));
  if (url) importLink(url);
});

// Paste anywhere outside a text field: images become a new recipe, links get imported.
document.addEventListener('paste', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || location.pathname === '/new' || location.pathname.endsWith('/edit')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    return handleFiles(files);
  }
  const text = e.clipboardData?.getData('text/plain')?.trim();
  if (!text) return;
  e.preventDefault();
  const url = findUrl(text);
  if (url && url.length > text.length - 5) importLink(url);
  else importText(text);
});

// Shared from another app via the installed PWA (Web Share Target).
function handleShare() {
  const p = new URLSearchParams(location.search);
  const text = [p.get('title'), p.get('text')].filter(Boolean).join('\n');
  const url = p.get('url') || findUrl(text);
  history.replaceState(null, '', '/');
  renderLibrary().catch(() => {});
  if (url) importLink(url);
  else if (text) importText(text);
}

// ---------- Timers ----------

let timers = [];
let tickHandle = null, ringHandle = null, actx = null;
const loadTimers = () => { try { timers = JSON.parse(localStorage.getItem('rb-timers') || '[]').filter((t) => t && t.id); } catch { timers = []; } };
const saveTimers = () => { try { localStorage.setItem('rb-timers', JSON.stringify(timers)); } catch { /* private mode */ } };
const timeLeft = (t) => (t.paused ? t.remaining : t.end - Date.now());

function ensureAudio() {
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch { actx = null; }
}

function beep() {
  if (!actx) return;
  try {
    const t0 = actx.currentTime;
    for (let i = 0; i < 3; i++) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = i === 2 ? 1175 : 880;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.3);
      g.gain.exponentialRampToValueAtTime(0.35, t0 + i * 0.3 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.3 + 0.25);
      o.connect(g).connect(actx.destination);
      o.start(t0 + i * 0.3); o.stop(t0 + i * 0.3 + 0.27);
    }
  } catch { /* audio not allowed */ }
}

function startTimer(secs, label) {
  ensureAudio();
  timers.push({ id: Math.random().toString(36).slice(2), label, end: Date.now() + secs * 1000, paused: false, remaining: 0, done: false });
  saveTimers();
  renderTimers();
  toast(`Timer started: ${Kit.fmtDur(secs)}`);
}

function timerAction(id, act) {
  const t = timers.find((x) => x.id === id);
  if (!t) return;
  ensureAudio();
  if (act === 'pause') {
    if (t.paused) { t.end = Date.now() + t.remaining; t.paused = false; } else { t.remaining = t.end - Date.now(); t.paused = true; }
  }
  if (act === 'add') {
    if (t.done) { t.done = false; t.paused = false; t.end = Date.now() + 60000; } else if (t.paused) t.remaining += 60000; else t.end += 60000;
  }
  if (act === 'cancel') timers = timers.filter((x) => x !== t);
  saveTimers();
  renderTimers();
}

function vibrate() {
  try { navigator.vibrate?.([400, 200, 400]); } catch { /* not allowed */ }
}

function renderTimers() {
  const html = timers.map((t) => `
    <div class="timer${t.paused ? ' paused' : ''}${t.done ? ' done' : ''}" data-tid="${t.id}">
      <span class="tinfo"><span class="tt">${t.done ? 'Done!' : Kit.fmtClock(timeLeft(t))}</span><span class="tl">${esc(t.label)}</span></span>
      ${t.done ? '' : `<button class="btn" data-tact="pause" aria-label="${t.paused ? 'Resume' : 'Pause'} timer">${t.paused ? '▶' : '❚❚'}</button>`}
      <button class="btn" data-tact="add" aria-label="Add one minute">+1 min</button>
      <button class="btn" data-tact="cancel" aria-label="${t.done ? 'Dismiss' : 'Cancel'} timer">${t.done ? 'OK' : '✕'}</button>
    </div>`).join('');
  $$('[data-timer-tray]').forEach((tray) => { tray.innerHTML = html; });
  $('#timer-float').hidden = !timers.length || !!state.cook;
  const running = timers.some((t) => !t.paused && !t.done);
  if (running && !tickHandle) tickHandle = setInterval(tick, 250);
  if (!running && tickHandle) { clearInterval(tickHandle); tickHandle = null; }
  const ringing = timers.some((t) => t.done);
  if (ringing && !ringHandle) { beep(); vibrate(); ringHandle = setInterval(() => { beep(); vibrate(); }, 1600); }
  if (!ringing && ringHandle) { clearInterval(ringHandle); ringHandle = null; }
}

function tick() {
  let changed = false;
  for (const t of timers) {
    if (!t.paused && !t.done && t.end <= Date.now()) { t.done = true; changed = true; }
  }
  if (changed) { saveTimers(); renderTimers(); return; }
  // Only update the numbers, so buttons aren't replaced under a finger.
  $$('.timer[data-tid]').forEach((el) => {
    const t = timers.find((x) => x.id === el.dataset.tid);
    if (t && !t.done) el.querySelector('.tt').textContent = Kit.fmtClock(timeLeft(t));
  });
}

// ---------- Cooking mode ----------

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (state.cook) keepAwake();
  tick();
});

function cookPages(r) {
  const pages = [];
  if (r.ingredients.length) pages.push({ kind: 'ing' });
  let section = '', n = 0;
  for (const line of r.instructions) {
    if (line.startsWith('## ')) { section = line.slice(3); continue; }
    pages.push({ kind: 'step', text: line, section, n: ++n });
  }
  pages.push({ kind: 'done' });
  return { pages, steps: n };
}

function openCook(r) {
  state.cook = { r, page: 0, checked: new Set() };
  ensureAudio();
  keepAwake();
  renderCook();
}

function closeCook() {
  const r = state.cook?.r;
  state.cook = null;
  $('#cook-root').innerHTML = '';
  try { wakeLock?.release(); } catch { /* already released */ }
  wakeLock = null;
  renderTimers();
  if (r && location.pathname === `/recipe/${r.id}`) renderRecipe(r);
}

function renderCook() {
  const { r } = state.cook;
  const { pages, steps } = cookPages(r);
  const i = Math.max(0, Math.min(state.cook.page, pages.length - 1));
  state.cook.page = i;
  const pg = pages[i];
  const factor = servingsFactor(r);
  const ingList = r.ingredients.map((l, k) => (l.startsWith('## ') ? `<li class="group">${esc(l.slice(3))}</li>`
    : `<li><label><input type="checkbox" data-cookcheck="${k}"${state.cook.checked.has(k) ? ' checked' : ''}><span>${ingredientHtml(l, factor)}</span></label></li>`)).join('');
  const label = (n) => `Step ${n} · ${r.title}`;
  let body;
  if (pg.kind === 'ing') {
    body = `<p class="cook-section">Get ready · for ${esc(amountLabel(r))}</p>
      <h2 class="cook-big">Ingredients</h2><ul class="ingredients">${ingList}</ul>`;
  } else if (pg.kind === 'step') {
    const ds = Kit.findDurations(pg.text);
    body = `<p class="cook-section">${esc(pg.section || `Step ${pg.n}`)}</p>
      <p class="cook-step">${stepWithTimers(pg.text, label(pg.n))}</p>
      ${ds.length ? `<div class="cook-timers">${ds.map((d) => `<button class="btn primary" data-tstart="${d.secs}" data-tlabel="${esc(label(pg.n))}">⏱ Start ${esc(Kit.fmtDur(d.secs))} timer</button>${d.max ? `<button class="btn" data-tstart="${d.max}" data-tlabel="${esc(label(pg.n))}">⏱ ${esc(Kit.fmtDur(d.max))}</button>` : ''}`).join('')}</div>` : ''}
      ${ingList ? `<details><summary>Show ingredients</summary><ul class="ingredients">${ingList}</ul></details>` : ''}`;
  } else {
    body = `<div class="cook-done">
      <div class="big" aria-hidden="true">🍽️</div><h2 class="cook-big">Enjoy your meal!</h2>
      <p class="muted">How did it turn out?</p>
      <div class="stars cook-stars" role="group" aria-label="Rating">${[1, 2, 3, 4, 5].map((n) => `<button data-cookrate="${n}" class="${n <= (r.rating || 0) ? 'on' : ''}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div></div>`;
  }
  const stepNo = pg.kind === 'step' ? pg.n : pg.kind === 'ing' ? 0 : steps;
  $('#cook-root').innerHTML = `
    <div class="cook" role="dialog" aria-modal="true" aria-label="Cooking ${esc(r.title)}">
      <div class="cook-top">
        <button class="btn" data-cookclose>✕ Close</button>
        <div class="cook-title">${esc(r.title)}</div>
        <span class="cook-count">${pg.kind === 'ing' ? 'Ingredients' : pg.kind === 'done' ? 'Finished' : `Step ${pg.n} of ${steps}`}</span>
      </div>
      <div class="cook-progress" aria-hidden="true"><span style="width:${steps ? Math.round((stepNo / steps) * 100) : 100}%"></span></div>
      <div class="tray" data-timer-tray aria-live="polite"></div>
      <div class="cook-body" id="cook-body">${body}</div>
      <div class="cook-nav">
        <button class="btn" data-cookprev ${i === 0 ? 'disabled style="visibility:hidden"' : ''}>← Back</button>
        ${pg.kind === 'done' ? '<button class="btn primary" data-cookclose>Close</button>' : `<button class="btn primary" data-cooknext>${i === pages.length - 2 ? 'Finish' : 'Next'} →</button>`}
      </div>
    </div>`;
  renderTimers();
  $('#cook-body').scrollTop = 0;
}

function cookGo(delta) {
  if (!state.cook) return;
  state.cook.page += delta;
  renderCook();
}

// Timer and cooking-mode buttons work on every page.
document.addEventListener('click', async (e) => {
  const t = e.target;
  let el;
  if ((el = t.closest('[data-tstart]'))) { e.preventDefault(); return startTimer(Number(el.dataset.tstart), el.dataset.tlabel || 'Timer'); }
  if ((el = t.closest('[data-tact]'))) return timerAction(el.closest('[data-tid]').dataset.tid, el.dataset.tact);
  if (!state.cook) return;
  if (t.closest('[data-cookclose]')) return closeCook();
  if (t.closest('[data-cooknext]')) return cookGo(1);
  if (t.closest('[data-cookprev]')) return cookGo(-1);
  if ((el = t.closest('[data-cookcheck]'))) {
    const k = Number(el.dataset.cookcheck);
    if (el.checked) state.cook.checked.add(k); else state.cook.checked.delete(k);
    return;
  }
  if ((el = t.closest('[data-cookrate]'))) {
    const n = Number(el.dataset.cookrate);
    $$('[data-cookrate]').forEach((b) => b.classList.toggle('on', Number(b.dataset.cookrate) <= n));
    try {
      Object.assign(state.cook.r, Kit.normalizeRecipe(await api.update(state.cook.r.id, { rating: n })));
      toast('Rating saved');
    } catch (err) { toast(err.message); }
  }
});

// Swipe between steps.
let touchX = null, touchY = null;
document.addEventListener('touchstart', (e) => {
  if (!state.cook || !e.target.closest('.cook-body')) return;
  touchX = e.touches[0].clientX;
  touchY = e.touches[0].clientY;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (!state.cook || touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX, dy = e.changedTouches[0].clientY - touchY;
  touchX = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) cookGo(dx < 0 ? 1 : -1);
}, { passive: true });

loadTimers();
renderTimers();
if (timers.some((t) => !t.paused && !t.done)) tick();
api.config().then((c) => { state.ai = Boolean(c.ai); if (location.pathname === '/new' || location.pathname.endsWith('/edit')) render(); }).catch(() => {});

// ---------- Menu & backups ----------

const menu = $('#menu');
$('#menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
});
document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
});
$('#import-backup-btn').addEventListener('click', () => $('#import-backup-input').click());
$('#import-backup-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  menu.hidden = true;
  if (!file) return;
  try {
    toast('Restoring backup…');
    const { imported } = await api.importBackup(await file.text());
    toast(`Restored ${imported} recipe${imported === 1 ? '' : 's'}`);
    navigate('/');
  } catch (err) {
    toast(err.message);
  }
});

document.addEventListener('keydown', (e) => {
  if (state.cook) {
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); cookGo(1); }
    else if (e.key === 'ArrowLeft') cookGo(-1);
    else if (e.key === 'Escape') closeCook();
    return;
  }
  if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && !dialog.open) {
    e.preventDefault();
    $('#search').focus();
  }
  if (e.key === 'Escape') menu.hidden = true;
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

render();
