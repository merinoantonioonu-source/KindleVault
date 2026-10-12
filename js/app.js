import { Library } from './store.js';
import { parseClippings, readVocabDb } from './parser.js';
import { SyncManager, syncSupported } from './sync.js';
import { pickKindleFolder, readKindleFiles, folderAccessSupported } from './kindle.js';
import { findCover } from './covers.js';
import { buildExport, PRESETS, DEFAULT_OPTIONS, vocamasterBlocks } from './export.js';

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const state = {
  tab: 'highlights',
  selectedBooks: new Set(),
  selectedLangs: new Set(),
  selectedTypes: new Set(['highlight', 'note', 'bookmark']),
  selectedStatuses: new Set(['new', 'sent']),
  search: '',
  results: [],
};

let lib;
let sync;

// ============================================================
//  Utilidades
// ============================================================
const esc = s => (s === null || s === undefined ? '' : String(s)).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = n => n.toLocaleString('es-ES');
const fmtWhen = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const LANG_NAMES = { es: 'Español', en: 'Inglés', fr: 'Francés', de: 'Alemán', it: 'Italiano', pt: 'Portugués', '?': 'Sin detectar' };
const langName = l => LANG_NAMES[l] || String(l).toUpperCase();

const STATUS_LABELS = { new: 'Nuevas', sent: 'Enviadas a VocaMaster', known: 'Me la sé', ignored: 'Ignoradas' };
const STATUS_TAGS = { sent: 'Enviada', known: 'Me la sé', ignored: 'Ignorada' };

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

function showBanner({ title, message, failures, actions = [], kind = 'warning' }) {
  const b = $('#banner');
  b.className = `banner${kind === 'error' ? ' error' : kind === 'success' ? ' success' : ''}`;
  let html = '<button class="close-banner" data-banner-close>×</button>';
  html += `<h3>${esc(title)}</h3>`;
  if (message) html += `<div class="banner-msg">${esc(message)}</div>`;
  if (failures && failures.length) {
    html += '<div class="banner-sub">Bloques que no se pudieron leer:</div>';
    failures.forEach(f => {
      html += `<div class="banner-fail"><strong>Bloque #${f.block_index}</strong> — ${esc(f.reason)}</div>`;
      if (f.first_lines) html += `<pre>${esc(f.first_lines)}</pre>`;
    });
  }
  if (actions.length) {
    html += '<div class="banner-actions">' +
      actions.map((a, i) => `<button class="btn ${i === 0 ? 'btn-primary' : 'btn-ghost'}" data-banner-action="${i}">${esc(a.label)}</button>`).join('') +
      '</div>';
  }
  b.innerHTML = html;
  b.querySelector('[data-banner-close]').onclick = hideBanner;
  b.querySelectorAll('[data-banner-action]').forEach(btn => {
    btn.onclick = () => actions[+btn.dataset.bannerAction].run();
  });
}
function hideBanner() { $('#banner').className = 'banner hidden'; }

function openDialog(id) { $(`#${id}`).classList.remove('hidden'); }
function closeDialog(id) { $(`#${id}`).classList.add('hidden'); }

// ============================================================
//  Cabecera y sincronización
// ============================================================
function renderStats() {
  const s = lib.stats();
  $('#stats-line').textContent =
    `${fmtNum(s.books)} libros · ${fmtNum(s.highlights)} subrayados · ${fmtNum(s.vocab)} palabras`;
}

function renderSyncPill() {
  const p = $('#sync-pill');
  const st = sync.state;
  const labels = {
    unsupported: 'Sin sincronización',
    none: 'Sin archivo de sincronización',
    'needs-permission': 'Pulsa para sincronizar',
    syncing: 'Sincronizando…',
    ok: `Sincronizado · ${fmtWhen(sync.meta.lastSync)}`,
    error: 'Error de sincronización',
  };
  p.textContent = labels[st] || st;
  p.className = 'status-pill sync-pill ' + ({
    ok: 'connected', 'needs-permission': 'attention', error: 'failed', syncing: 'busy',
  }[st] || '');
  if (!$('#sync-dialog').classList.contains('hidden')) renderSyncDialog();
}

async function syncInteractive() {
  hideBanner();
  const r = await sync.syncNow({ interactive: true });
  if (r.ok) toast(r.changedHere ? '✓ Sincronizado: datos de tu otro equipo cargados' : '✓ Sincronizado');
  else if (r.error) showBanner({ title: 'No se pudo sincronizar', message: r.error, kind: 'error' });
}

function renderSyncDialog() {
  const body = $('#sync-body');
  const st = sync.state;
  let html = '';
  if (st === 'unsupported') {
    html += `<p>Este navegador no permite que una web lea y guarde un archivo de tu ordenador, así que aquí no hay sincronización automática. Funciona en <strong>Chrome</strong> y <strong>Edge</strong> de escritorio.</p>
      <p>Puedes <em>consultar</em> tus datos abriendo una copia de tu archivo de sincronización (por ejemplo, desde OneDrive en el móvil).</p>
      <div class="dialog-actions-col">
        <button class="btn btn-primary" data-act="open-readonly">Abrir archivo de sincronización (solo lectura)</button>
        <button class="btn btn-ghost" data-act="backup">Descargar una copia de mis datos</button>
      </div>`;
  } else if (!sync.handle) {
    html += `<p>Guarda tus datos en un archivo dentro de una carpeta que se sincronice sola, como <strong>OneDrive</strong> o <strong>Dropbox</strong>. Así tendrás lo mismo en todos tus ordenadores.</p>
      <ul class="plain-list">
        <li><strong>Primer ordenador:</strong> crea el archivo.</li>
        <li><strong>Los demás:</strong> vincula ese mismo archivo.</li>
      </ul>
      <div class="dialog-actions-col">
        <button class="btn btn-primary" data-act="create">Crear archivo de sincronización…</button>
        <button class="btn btn-ghost" data-act="link">Vincular un archivo existente…</button>
      </div>`;
  } else {
    const stateText = {
      ok: `Sincronizado por última vez: <strong>${esc(fmtWhen(sync.meta.lastSync))}</strong>.`,
      'needs-permission': 'El navegador necesita tu permiso para usar el archivo en esta sesión (es una medida de seguridad de Chrome).',
      syncing: 'Sincronizando…',
      error: `<span class="text-danger">${esc(sync.error)}</span>`,
    }[st] || '';
    html += `<div class="sync-file"><div class="sync-file-name">${esc(sync.meta.name || sync.handle.name)}</div><div class="hint">${stateText}</div></div>
      <p class="hint">Se sincroniza solo al abrir la web, al volver a ella y después de cada importación. El navegador solo nos deja ver el nombre del archivo, no su carpeta.</p>
      <div class="dialog-actions-col">
        <button class="btn btn-primary" data-act="sync">Sincronizar ahora</button>
        <button class="btn btn-ghost" data-act="link">Vincular otro archivo…</button>
        <button class="btn btn-ghost" data-act="unlink">Dejar de sincronizar</button>
      </div>`;
  }
  if (st !== 'unsupported') {
    html += `<details class="sync-more"><summary>Más opciones</summary>
      <div class="dialog-actions-col">
        <button class="btn btn-ghost" data-act="backup">Descargar una copia de mis datos</button>
        <button class="btn btn-ghost danger" data-act="wipe">Borrar los datos de este navegador</button>
      </div></details>`;
  }
  body.innerHTML = html;
  body.querySelectorAll('[data-act]').forEach(btn => { btn.onclick = () => syncAction(btn.dataset.act); });
}

async function syncAction(act) {
  try {
    if (act === 'create') { await sync.create(); toast('✓ Archivo creado y sincronizado'); }
    else if (act === 'link') {
      const r = await sync.link();
      if (r.ok) toast(r.changedHere ? '✓ Archivo vinculado: datos cargados' : '✓ Archivo vinculado');
    }
    else if (act === 'sync') await syncInteractive();
    else if (act === 'unlink') { await sync.unlink(); toast('Sincronización desactivada en este navegador'); }
    else if (act === 'open-readonly') $('#sync-readonly-file').click();
    else if (act === 'backup') {
      const blob = new Blob([JSON.stringify(lib.toJSON())], { type: 'application/json' });
      download(blob, `kindlevault-copia-${new Date().toISOString().slice(0, 10)}.json`);
    } else if (act === 'wipe') {
      if (!confirm('Se borrarán los libros, subrayados y vocabulario guardados en este navegador. Tu archivo de sincronización y tu Kindle no se tocan. ¿Continuar?')) return;
      lib.clear();
      await lib.save();
      refreshAll();
      toast('Datos de este navegador borrados');
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return; // el usuario cerró el selector
    showBanner({ title: 'No se pudo completar', message: e.message || String(e), kind: 'error' });
  }
  renderSyncDialog();
}

// ============================================================
//  Importar del Kindle
// ============================================================
async function processImport(r) {
  closeDialog('import-dialog');
  if (!r.clippings && !r.vocab) {
    showBanner({
      title: 'No he encontrado los archivos del Kindle',
      message: r.folderName
        ? `En «${r.folderName}» no están My Clippings.txt ni vocab.db. Elige la unidad del Kindle completa (por ejemplo D:), no una carpeta de dentro.`
        : 'Elige My Clippings.txt y/o vocab.db.',
      kind: 'error',
    });
    return;
  }
  const lines = [];
  let diag = null;
  let kind = 'success';
  if (r.clippings) {
    const parsed = parseClippings(r.clippings.bytes, r.clippings.name);
    diag = parsed.diagnosis;
    const { added, dup } = lib.importHighlights(parsed.items);
    lines.push(`Subrayados, notas y marcadores: ${fmtNum(added)} nuevos · ${fmtNum(dup)} ya estaban.`);
    lines.push(`Archivo: ${fmtNum(diag.total_blocks)} bloques · ${fmtNum(diag.parsed_ok)} leídos${diag.parsed_failed ? ` · ${diag.parsed_failed} sin leer` : ''}.`);
    if (diag.parsed_failed) kind = 'warning';
    const sup = lib.supersededCount();
    if (sup) lines.push(sup === 1
      ? 'Oculta 1 versión anterior de un subrayado que luego ampliaste (filtro «Versiones anteriores»).'
      : `Ocultas ${fmtNum(sup)} versiones anteriores de subrayados que luego ampliaste (filtro «Versiones anteriores»).`);
  } else {
    lines.push('No se encontró My Clippings.txt (subrayados).');
    kind = 'warning';
  }
  if (r.vocab) {
    try {
      const entries = readVocabDb(r.vocab.db.bytes, r.vocab.wal && r.vocab.wal.bytes);
      const added = lib.importVocab(entries);
      lines.push(`Vocabulario: ${fmtNum(added)} palabras nuevas de ${fmtNum(entries.length)}.`);
    } catch (e) {
      lines.push(`No se pudo leer vocab.db: ${e.message}`);
      kind = 'warning';
    }
  } else {
    lines.push(r.folderName
      ? 'No se encontró vocab.db (vocabulario). Si quieres el vocabulario, elige la unidad del Kindle completa.'
      : 'Sin vocab.db: no se ha importado vocabulario.');
  }
  lib.guessMissingLanguages();
  await lib.save();
  refreshAll();
  const s = lib.stats();
  lines.push(`Ahora tienes ${fmtNum(s.books)} libros, ${fmtNum(s.highlights)} subrayados con texto y ${fmtNum(s.vocab)} palabras.`);
  showBanner({ title: 'Importación completada', message: lines.join('\n'), failures: diag && diag.failures, kind });
  sync.schedule();
  fetchCovers();
}

async function importFromKindleFolder() {
  try {
    processImport(await pickKindleFolder());
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    showBanner({
      title: 'No se pudo abrir la carpeta',
      message: `${e.message || e}\n\nSi el navegador no te deja elegir la unidad entera, usa “Elegir los archivos a mano”.`,
      kind: 'error',
    });
  }
}

// ============================================================
//  Portadas (en segundo plano)
// ============================================================
let coversRunning = false;
async function fetchCovers() {
  if (coversRunning) return;
  coversRunning = true;
  let changed = false;
  try {
    const pending = lib.booksWithoutCover();
    for (let i = 0; i < pending.length; i += 3) {
      const batch = pending.slice(i, i + 3);
      const urls = await Promise.all(batch.map(b => findCover(b.title, b.author)));
      batch.forEach((b, j) => {
        if (urls[j] === undefined) return; // sin conexión: se reintentará
        b.cover_url = urls[j] || '__not_found__';
        changed = true;
      });
      if (state.tab === 'books') renderBooks();
      await new Promise(r => setTimeout(r, 250));
    }
  } finally {
    coversRunning = false;
    if (changed) { await lib.save(); sync.schedule(); }
  }
}

// ============================================================
//  Filtros
// ============================================================
function renderLangFilters() {
  const c = $('#lang-filters');
  const langs = lib.listLanguages();
  if (!langs.length) { c.innerHTML = '<div class="filter-empty">Sin datos.</div>'; return; }
  c.innerHTML = langs.map(l => `<label>
      <input type="checkbox" class="lang-cb" value="${esc(l.lang)}" ${state.selectedLangs.has(l.lang) ? 'checked' : ''}>
      <span>${esc(langName(l.lang))}</span>
      <span class="count">${l.count}</span>
    </label>`).join('');
  $$('.lang-cb').forEach(cb => cb.addEventListener('change', () => {
    cb.checked ? state.selectedLangs.add(cb.value) : state.selectedLangs.delete(cb.value);
    reload();
  }));
}

function renderBookFilters() {
  const c = $('#book-filters');
  const q = ($('#book-search').value || '').toLowerCase();
  const books = lib.listBooks().filter(b =>
    !q || b.title.toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q));
  if (!books.length) { c.innerHTML = '<div class="filter-empty">Sin libros.</div>'; return; }
  const vocabMode = state.tab === 'vocab';
  c.innerHTML = books.map(b => {
    const n = vocabMode ? b.vocab_count : b.highlights_count;
    return `<label title="${esc(b.title)}">
      <input type="checkbox" class="book-cb" value="${esc(b.key)}" ${state.selectedBooks.has(b.key) ? 'checked' : ''}>
      <span>${esc(b.title)}</span>
      <span class="count">${n}</span>
    </label>`;
  }).join('');
  $$('.book-cb').forEach(cb => cb.addEventListener('change', () => {
    cb.checked ? state.selectedBooks.add(cb.value) : state.selectedBooks.delete(cb.value);
    reload();
  }));
}

function renderStatusFilters() {
  const counts = lib.vocabStatusCounts();
  $('#status-filters').innerHTML = Object.entries(STATUS_LABELS).map(([st, label]) => `<label>
      <input type="checkbox" class="status-cb" value="${st}" ${state.selectedStatuses.has(st) ? 'checked' : ''}>
      <span>${esc(label)}</span>
      <span class="count">${fmtNum(counts[st])}</span>
    </label>`).join('');
  $$('.status-cb').forEach(cb => cb.addEventListener('change', () => {
    cb.checked ? state.selectedStatuses.add(cb.value) : state.selectedStatuses.delete(cb.value);
    reload();
  }));
}

function renderSupersededCount() {
  const n = lib.supersededCount();
  $('#superseded-count').textContent = n ? fmtNum(n) : '';
}

function currentFilters() {
  return {
    bookKeys: state.selectedBooks,
    languages: state.selectedLangs,
    types: state.selectedTypes,
    statuses: state.selectedStatuses,
    search: state.search,
  };
}

// ============================================================
//  Vistas
// ============================================================
function setTab(tab) {
  state.tab = tab;
  $$('.tab[data-tab]').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('#type-section').classList.toggle('hidden', tab !== 'highlights');
  $('#status-section').classList.toggle('hidden', tab !== 'vocab');
  $('#btn-export').classList.toggle('hidden', tab === 'books');
  $('#btn-vocamaster').classList.toggle('hidden', tab !== 'vocab');
  renderBookFilters();
  reload();
}

function refreshAll() {
  renderStats();
  renderSupersededCount();
  renderStatusFilters();
  renderLangFilters();
  renderBookFilters();
  reload();
}

function reload() {
  if (!lib.books.size && !lib.vocab.size) { renderWelcome(); return; }
  if (state.tab === 'books') { renderBooks(); return; }
  if (state.tab === 'highlights') {
    state.results = lib.filterHighlights(currentFilters());
    renderHighlights();
  } else {
    state.results = lib.filterVocab(currentFilters());
    renderVocab();
  }
}

function setCount(n, one, many) {
  $('#result-count').textContent = `${fmtNum(n)} ${n === 1 ? one : many}`;
}

function renderWelcome() {
  $('#result-count').textContent = '';
  const c = $('#results');
  c.classList.remove('books-grid');
  const canSync = syncSupported;
  c.innerHTML = `<div class="welcome">
    <h2>Tus lecturas, en un solo sitio</h2>
    <p>Importa los subrayados, notas, marcadores y vocabulario de tu Kindle. Todo se guarda en este navegador y, si quieres, en un archivo de sincronización para usarlo en tus otros ordenadores.</p>
    <div class="welcome-actions">
      <button class="btn btn-primary" id="w-import">Importar del Kindle</button>
      ${canSync ? '<button class="btn btn-ghost" id="w-link">Ya lo uso en otro ordenador: vincular mi archivo</button>'
        : '<button class="btn btn-ghost" id="w-open">Abrir mi archivo de sincronización</button>'}
    </div>
  </div>`;
  $('#w-import').onclick = () => openDialog('import-dialog');
  if ($('#w-link')) $('#w-link').onclick = () => syncAction('link');
  if ($('#w-open')) $('#w-open').onclick = () => $('#sync-readonly-file').click();
}

function locLabel(h) {
  if (h.location_start) {
    return `loc. ${h.location_start}${h.location_end && h.location_end !== h.location_start ? '–' + h.location_end : ''}`;
  }
  return h.page ? `pág. ${h.page}` : '';
}

const RENDER_LIMIT = 400;
let renderedCount = 0;

function renderHighlights(append = false) {
  const c = $('#results');
  c.classList.remove('books-grid');
  const items = state.results;
  setCount(items.length, 'resultado', 'resultados');
  if (!items.length) { c.innerHTML = '<div class="empty"><p>Sin resultados con los filtros actuales.</p></div>'; return; }
  const start = append ? renderedCount : 0;
  const end = Math.min(items.length, start + RENDER_LIMIT);
  const html = items.slice(start, end).map(h => {
    const meta = [`<strong>${esc(h.title)}</strong>`];
    if (h.author) meta.push(esc(h.author));
    const loc = locLabel(h);
    if (loc) meta.push(esc(loc));
    const tags = [];
    if (h.type === 'note') tags.push('<span class="h-tag note-tag">Nota</span>');
    if (h.type === 'bookmark') tags.push('<span class="h-tag bookmark-tag">Marcador</span>');
    if (h.type === 'empty') tags.push('<span class="h-tag empty-tag">Sin texto</span>');
    if (h.type === 'dropped') tags.push('<span class="h-tag dropped-tag">Bloqueado</span>');
    if (h.superseded) tags.push('<span class="h-tag empty-tag" title="Luego ampliaste este subrayado en el Kindle">Versión anterior</span>');
    if (h.language) tags.push(`<span class="h-tag">${esc(h.language.toUpperCase())}</span>`);
    let body;
    if (h.type === 'bookmark') body = '<p class="h-content empty-content">Marcador colocado en esta posición.</p>';
    else if (h.type === 'empty') body = '<p class="h-content empty-content">Subrayado sin texto extraíble (imagen, tabla o pie de página).</p>';
    else if (h.type === 'dropped') body = '<p class="h-content empty-content">Texto bloqueado por el límite de recortes de Amazon: el Kindle no lo exportó.</p>';
    else body = `<p class="h-content">${esc(h.content)}</p>`;
    if (h.parent) {
      const p = h.parent.length > 220 ? h.parent.slice(0, 220) + '…' : h.parent;
      body = `<blockquote class="h-parent">${esc(p)}</blockquote>${body}`;
    }
    for (const n of h.notes || []) {
      body += `<div class="h-note"><span class="h-note-label">Tu nota</span>${esc(n.content)}</div>`;
    }
    return `<article class="h-card ${h.type === 'highlight' ? '' : h.type}${h.superseded ? ' superseded' : ''}">
      <div class="h-meta"><div class="h-meta-book">${meta.join('<span class="sep">·</span>')}</div><div class="h-meta-tags">${tags.join('')}</div></div>
      ${body}</article>`;
  }).join('');
  if (append) { c.querySelector('.load-more')?.remove(); c.insertAdjacentHTML('beforeend', html); }
  else { c.innerHTML = html; c.scrollTop = 0; }
  renderedCount = end;
  if (end < items.length) addLoadMore(c, items.length - end, () => renderHighlights(true));
}

function renderVocab(append = false) {
  const c = $('#results');
  c.classList.remove('books-grid');
  const items = state.results;
  setCount(items.length, 'palabra', 'palabras');
  if (!items.length) { c.innerHTML = '<div class="empty"><p>Sin vocabulario con los filtros actuales.</p></div>'; return; }
  const start = append ? renderedCount : 0;
  const end = Math.min(items.length, start + RENDER_LIMIT);
  const html = items.slice(start, end).map(v => `
    <article class="v-card" data-wkey="${esc(v.wkey)}">
      <div>
        <span class="v-word">${esc(v.word)}</span>${v.language ? `<span class="v-word-lang">${esc(v.language)}</span>` : ''}
        ${v.stem && v.stem.toLowerCase() !== v.word.toLowerCase() ? `<div class="v-stem">forma base: ${esc(v.stem)}</div>` : ''}
      </div>
      <div>
        ${v.context ? `<div class="v-context">${highlightWord(v.context, v.word)}</div>` : ''}
        ${v.book_title ? `<div class="v-source">de ${esc(v.book_title)}${v.looked_up_at ? ' · ' + esc(fmtWhen(v.looked_up_at)) : ''}</div>` : ''}
        <div class="v-actions">${wordActionsHtml(v.status)}</div>
      </div>
    </article>`).join('');
  if (append) { c.querySelector('.load-more')?.remove(); c.insertAdjacentHTML('beforeend', html); }
  else { c.innerHTML = html; c.scrollTop = 0; }
  renderedCount = end;
  if (end < items.length) addLoadMore(c, items.length - end, () => renderVocab(true));
}

function wordActionsHtml(status) {
  const out = [];
  if (status) out.push(`<span class="v-status v-status-${status}">${esc(STATUS_TAGS[status])}</span>`);
  if (status !== 'known') out.push('<button class="link-btn" data-word-act="known">Me la sé</button>');
  if (status !== 'ignored') out.push('<button class="link-btn" data-word-act="ignored">Ignorar</button>');
  if (status) out.push('<button class="link-btn" data-word-act="clear">Quitar marca</button>');
  return out.join('');
}

/** Cambia el estado de una palabra y repinta sus tarjetas sin perder el sitio en la lista. */
async function setWordStatus(keys, status) {
  for (const k of keys) lib.setWordStatus(k, status);
  for (const k of keys) {
    $$('.v-card').filter(c => c.dataset.wkey === k).forEach(c => {
      c.querySelector('.v-actions').innerHTML = wordActionsHtml(status);
    });
  }
  renderStatusFilters();
  await lib.save();
  sync.schedule();
}

function highlightWord(context, word) {
  const safe = esc(context);
  if (!word) return safe;
  const w = esc(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return safe.replace(new RegExp(`(^|[^\\p{L}])(${w})(?=$|[^\\p{L}])`, 'iu'), '$1<mark>$2</mark>');
  } catch { return safe; }
}

function addLoadMore(container, remaining, onClick) {
  const btn = document.createElement('button');
  btn.className = 'btn btn-ghost load-more';
  btn.textContent = `Mostrar más (${fmtNum(remaining)} restantes)`;
  btn.onclick = onClick;
  container.appendChild(btn);
}

function renderBooks() {
  const c = $('#results');
  c.classList.add('books-grid');
  let books = lib.listBooks();
  if (state.selectedLangs.size) books = books.filter(b => state.selectedLangs.has(b.language || '?'));
  if (state.search) {
    const q = state.search.toLowerCase();
    books = books.filter(b => b.title.toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q));
  }
  setCount(books.length, 'libro', 'libros');
  if (!books.length) { c.innerHTML = '<div class="empty"><p>Ningún libro coincide.</p></div>'; return; }
  c.innerHTML = books.map(b => {
    const hasCover = b.cover_url && b.cover_url !== '__not_found__';
    const fallback = `<div class="book-cover-fallback"${hasCover ? ' style="display:none"' : ''}><div class="fallback-title">${esc(b.title)}</div></div>`;
    const img = hasCover ? `<img src="${esc(b.cover_url)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : '';
    const parts = [];
    if (b.highlights_count) parts.push(`${b.highlights_count} subrayado${b.highlights_count === 1 ? '' : 's'}`);
    if (b.vocab_count) parts.push(`${b.vocab_count} palabra${b.vocab_count === 1 ? '' : 's'}`);
    return `<div class="book-card" data-key="${esc(b.key)}" tabindex="0">
      <div class="book-cover">${img}${fallback}</div>
      <div class="book-info">
        <div class="b-title">${esc(b.title)}</div>
        <div class="b-author">${esc(b.author || '—')}</div>
        <div class="b-stats">${parts.join(' · ') || 'Sin subrayados'}</div>
      </div></div>`;
  }).join('');
  $$('.book-card').forEach(card => {
    const open = () => {
      state.selectedBooks = new Set([card.dataset.key]);
      setTab(lib.listBooks().find(b => b.key === card.dataset.key)?.highlights_count ? 'highlights' : 'vocab');
    };
    card.onclick = open;
    card.onkeydown = e => { if (e.key === 'Enter') open(); };
  });
}

// ============================================================
//  Exportar
// ============================================================
function exportKind() { return state.tab === 'vocab' ? 'vocab' : 'highlights'; }

function getExportOptions() {
  const o = { ...DEFAULT_OPTIONS };
  $$('#export-dialog input[data-opt]').forEach(cb => { o[cb.dataset.opt] = cb.checked; });
  return o;
}

function setPreset(name) {
  $$('.btn-preset').forEach(b => b.classList.toggle('active', b.dataset.preset === name));
  const p = PRESETS[name];
  $$('#export-dialog input[data-opt]').forEach(cb => { cb.checked = p[cb.dataset.opt]; });
  refreshPreview();
}

function currentExport() {
  const kind = exportKind();
  const items = kind === 'vocab' ? lib.filterVocab(currentFilters()) : lib.filterHighlights(currentFilters());
  return { ...buildExport(kind, $('#export-format').value, items, getExportOptions()), count: items.length, kind };
}

function refreshPreview() {
  const ex = currentExport();
  $('#export-preview').textContent = ex.content.slice(0, 2500) + (ex.content.length > 2500 ? '\n…' : '');
  $('#export-count').textContent = `· ${fmtNum(ex.count)} ${ex.kind === 'vocab' ? 'palabras' : 'elementos'}`;
}

function refreshFormatHints() {
  const kind = exportKind(), fmt = $('#export-format').value;
  $('#format-hint-ultramind').classList.toggle('hidden', fmt !== 'ultramind');
  $('#format-hint-vocab').classList.toggle('hidden', !(kind === 'vocab' && fmt === 'csv'));
}

function openExport() {
  const kind = exportKind();
  $('#export-title').textContent = kind === 'vocab' ? 'Exportar vocabulario' : 'Exportar subrayados y notas';
  $('#opt-highlights').classList.toggle('hidden', kind === 'vocab');
  $('#opt-vocab').classList.toggle('hidden', kind !== 'vocab');
  // El mapa mental es para subrayados; el vocabulario va a VocaMaster.
  $('#opt-format-ultramind').hidden = kind === 'vocab';
  $('#opt-format-ultramind').disabled = kind === 'vocab';
  if (kind === 'vocab' && $('#export-format').value === 'ultramind') $('#export-format').value = 'markdown';
  refreshFormatHints();
  if (!$('.btn-preset.active')) setPreset('full'); else refreshPreview();
  openDialog('export-dialog');
}

// ============================================================
//  Enviar a VocaMaster
// ============================================================
let vmBlocks = [];

function renderVocaMaster() {
  const items = lib.filterVocab({ ...currentFilters(), statuses: null });
  vmBlocks = vocamasterBlocks(items, {
    baseForm: $('#vm-base-form').checked,
    includeSent: $('#vm-include-sent').checked,
  });
  const c = $('#vm-blocks');
  if (!vmBlocks.length) {
    c.innerHTML = `<div class="empty"><p>No hay palabras nuevas que enviar con estos filtros.${$('#vm-include-sent').checked ? '' : ' Si quieres repetir las ya enviadas, marca «Incluir las ya enviadas».'}</p></div>`;
    return;
  }
  const langs = new Set(vmBlocks.map(b => b.lang));
  const words = vmBlocks.reduce((n, b) => n + b.terms.length, 0);
  let html = `<p class="vm-summary">${fmtNum(words)} palabras en ${fmtNum(vmBlocks.length)} bloque${vmBlocks.length === 1 ? '' : 's'}${langs.size > 1 ? `, separadas por idioma (cada idioma va a su lista de VocaMaster)` : ''}.</p>`;
  html += vmBlocks.map((b, i) => {
    const preview = b.terms.slice(0, 12).join(', ') + (b.terms.length > 12 ? '…' : '');
    return `<div class="vm-block" data-i="${i}">
      <div class="vm-block-head">
        <div><strong>${esc(langName(b.lang))}</strong>${b.total > 1 ? ` · bloque ${b.index} de ${b.total}` : ''} · ${fmtNum(b.terms.length)} palabras</div>
        <button class="btn btn-primary" data-vm-copy="${i}">Copiar</button>
      </div>
      <div class="vm-preview">${esc(preview)}</div>
      <textarea class="vm-fallback hidden" readonly rows="6">${esc(b.text)}</textarea>
    </div>`;
  }).join('');
  c.innerHTML = html;
  c.querySelectorAll('[data-vm-copy]').forEach(btn => { btn.onclick = () => copyVocaMasterBlock(+btn.dataset.vmCopy, btn); });
}

async function copyVocaMasterBlock(i, btn) {
  const b = vmBlocks[i];
  const box = btn.closest('.vm-block');
  try {
    await navigator.clipboard.writeText(b.text);
  } catch {
    // Sin permiso de portapapeles: se enseña el texto seleccionado para copiarlo a mano.
    const ta = box.querySelector('.vm-fallback');
    ta.classList.remove('hidden');
    ta.select();
    toast('No pude copiar solo: pulsa Ctrl+C para copiar el texto seleccionado');
  }
  btn.textContent = '✓ Copiado';
  btn.classList.replace('btn-primary', 'btn-ghost');
  box.classList.add('done');
  const keys = b.keys.filter(k => {
    const st = lib.wordStatus.get(k);
    return !st || !st.status;
  });
  if (keys.length) await setWordStatus(keys, 'sent');
  toast(`✓ ${fmtNum(b.terms.length)} palabras copiadas: pégalas en VocaMaster → + → Vocabulario → Pegar Texto`);
}

function openVocaMaster() {
  renderVocaMaster();
  openDialog('vocamaster-dialog');
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ============================================================
//  Arranque
// ============================================================
function wire() {
  $$('.tab[data-tab]').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));
  $('#btn-toggle-filters').onclick = () => $('#sidebar').classList.toggle('open');
  $('#search').addEventListener('input', e => {
    state.search = e.target.value.trim();
    clearTimeout(wire._t);
    wire._t = setTimeout(reload, 200);
  });
  $('#book-search').addEventListener('input', renderBookFilters);
  $('#btn-select-all').onclick = () => { lib.listBooks().forEach(b => state.selectedBooks.add(b.key)); renderBookFilters(); reload(); };
  $('#btn-select-none').onclick = () => { state.selectedBooks.clear(); renderBookFilters(); reload(); };
  $$('.type-filter').forEach(cb => cb.addEventListener('change', () => {
    cb.checked ? state.selectedTypes.add(cb.value) : state.selectedTypes.delete(cb.value);
    reload();
  }));

  $('#btn-import').onclick = () => openDialog('import-dialog');
  $('#btn-pick-kindle').onclick = importFromKindleFolder;
  if (!folderAccessSupported) {
    $('#btn-pick-kindle').classList.add('hidden');
    $('#btn-pick-files').classList.replace('btn-ghost', 'btn-primary');
  }
  $('#btn-pick-files').onclick = () => $('#kindle-files').click();
  $('#kindle-files').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) processImport(await readKindleFiles(files));
  });

  $('#sync-pill').onclick = () => {
    if (sync.state === 'needs-permission') syncInteractive();
    else { renderSyncDialog(); openDialog('sync-dialog'); }
  };
  $('#sync-readonly-file').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const changed = await sync.importFromFile(f);
      closeDialog('sync-dialog');
      toast(changed ? '✓ Datos cargados del archivo' : 'No había nada nuevo en el archivo');
    } catch (err) {
      showBanner({ title: 'No se pudo abrir el archivo', message: err.message, kind: 'error' });
    }
  });

  $('#btn-export').onclick = openExport;
  $('#export-format').onchange = () => { refreshFormatHints(); refreshPreview(); };
  $('#btn-vocamaster').onclick = openVocaMaster;
  $('#vm-base-form').onchange = renderVocaMaster;
  $('#vm-include-sent').onchange = renderVocaMaster;
  $('#results').addEventListener('click', e => {
    const btn = e.target.closest('[data-word-act]');
    if (!btn) return;
    const card = btn.closest('.v-card');
    const act = btn.dataset.wordAct;
    setWordStatus([card.dataset.wkey], act === 'clear' ? null : act);
  });
  $$('.btn-preset').forEach(b => { b.onclick = () => setPreset(b.dataset.preset); });
  $$('#export-dialog input[data-opt]').forEach(cb => cb.addEventListener('change', () => {
    $$('.btn-preset').forEach(b => b.classList.remove('active'));
    refreshPreview();
  }));
  $('#btn-do-export').onclick = () => {
    const ex = currentExport();
    download(new Blob([ex.content], { type: ex.mime }), ex.filename);
    toast(`Descargado: ${ex.filename}`);
  };
  $('#btn-copy-export').onclick = async () => {
    try { await navigator.clipboard.writeText(currentExport().content); toast('✓ Copiado al portapapeles'); }
    catch { toast('No se pudo copiar; usa “Descargar archivo”'); }
  };

  $$('[data-close]').forEach(b => { b.onclick = () => closeDialog(b.dataset.close); });
  $$('.dialog-backdrop').forEach(d => d.addEventListener('mousedown', e => { if (e.target === d) d.classList.add('hidden'); }));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $$('.dialog-backdrop').forEach(d => d.classList.add('hidden'));
  });

  // Al volver a la pestaña, traer lo que se haya hecho en otro ordenador.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !sync.handle) return;
    const last = sync.meta.lastSync ? Date.parse(sync.meta.lastSync) : 0;
    if (Date.now() - last < 20000) return;
    if ((await sync.handle.queryPermission({ mode: 'readwrite' })) === 'granted') sync.syncNow();
  });
}

async function main() {
  lib = await Library.load();
  sync = new SyncManager(lib, {
    onStatus: renderSyncPill,
    onMerged: () => { refreshAll(); fetchCovers(); },
  });
  wire();
  setTab('highlights');
  refreshAll();
  await sync.init();
  if (sync.state === 'needs-permission') {
    showBanner({
      title: '¿Cargar tus datos más recientes?',
      message: `Tu archivo de sincronización (${sync.meta.name || 'vinculado'}) puede tener cambios hechos en otro ordenador. El navegador necesita un clic tuyo para abrirlo.`,
      actions: [
        { label: 'Sí, sincronizar', run: syncInteractive },
        { label: 'Ahora no', run: hideBanner },
      ],
    });
  } else if (sync.state === 'error') {
    showBanner({ title: 'No se pudo sincronizar', message: sync.error, kind: 'error' });
  }
  if (lib.booksWithoutCover().length) fetchCovers();
}

main().catch(e => {
  console.error(e);
  showBanner({ title: 'Error al arrancar', message: e.message || String(e), kind: 'error' });
});
