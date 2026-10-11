(() => {

const state = {
  tab: 'highlights',
  books: [],
  languages: [],
  selectedBooks: new Set(),
  selectedLangs: new Set(),
  selectedTypes: new Set(['highlight', 'note', 'bookmark']),
  search: '',
  results: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));


// ------- API -------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}


// ------- Status -------
async function refreshStatus() {
  const s = await api('/api/status');
  $('#stats-line').textContent =
    `${s.stats.books} libros · ${s.stats.highlights} subrayados · ${s.stats.vocab} palabras`;
  const badge = $('#kindle-status');
  if (s.kindle_connected) {
    badge.className = 'status-pill connected';
    badge.textContent = 'Kindle conectado';
  } else {
    badge.className = 'status-pill';
    badge.textContent = 'Sin Kindle';
  }
}


// ------- Sync -------
async function doSync() {
  const btn = $('#btn-sync');
  btn.disabled = true; btn.textContent = 'Sincronizando…';
  hideBanner();
  try {
    const res = await api('/api/sync', { method: 'POST', body: '{}' });
    if (!res.ok) {
      toast(res.error || 'Error de sincronización');
      showBanner({ title: 'No se pudo sincronizar', message: res.error, hint: res.hint, kind: 'error' });
    } else {
      if (res.stats) {
        $('#stats-line').textContent =
          `${res.stats.books} libros · ${res.stats.highlights} subrayados · ${res.stats.vocab} palabras`;
      }
      const parts = [];
      parts.push(`+${res.highlights_new} subrayados`);
      if (res.highlights_dup > 0) parts.push(`${res.highlights_dup} duplicados`);
      if (res.vocab_new > 0) parts.push(`+${res.vocab_new} palabras`);
      toast('Sincronizado: ' + parts.join(' · '));

      const diag = res.clippings_diagnosis;
      const lines = [];
      if (diag) {
        lines.push(`Bloques en archivo: ${diag.total_blocks} totales · ${diag.parsed_ok} OK · ${diag.parsed_failed} fallidos`);
      }
      lines.push(`Insertados: ${res.highlights_new} nuevos · ${res.highlights_dup} duplicados`);
      lines.push(`Total en biblioteca: ${res.stats.books} libros · ${res.stats.highlights} subrayados`);
      let kind = 'success';
      if (res.highlights_failed_insert > 0 || (diag && diag.parsed_failed > 0)) kind = 'warning';
      showBanner({
        title: 'Sincronización completada',
        message: lines.join('\n'),
        failures: res.insert_errors && res.insert_errors.length
          ? res.insert_errors.map((e, i) => ({ block_index: i, reason: e, first_lines: '' }))
          : (diag && diag.parsed_failed > 0 ? diag.failures : null),
        kind,
      });
    }
    await Promise.all([refreshStatus(), loadFilters(), reload()]);
    fetchCoversInBackground();
  } catch (e) {
    toast('Error: ' + e.message);
    showBanner({ title: 'Error inesperado', message: e.message, kind: 'error' });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sincronizar';
  }
}

async function doDiagnose() {
  hideBanner();
  try {
    const res = await api('/api/diagnose');
    if (!res.ok) {
      showBanner({
        title: 'No se pudo diagnosticar',
        message: res.error + (res.tried ? '\n\nRutas probadas:\n' + res.tried.join('\n') : ''),
        kind: 'error',
      });
      return;
    }
    const d = res.diagnosis;
    showBanner({
      title: 'Diagnóstico de My Clippings.txt',
      message: `Archivo: ${d.file_path}\nTamaño: ${d.file_size} bytes · Codificación: ${d.file_encoding}\nBloques: ${d.total_blocks} totales · ${d.parsed_ok} OK · ${d.parsed_failed} fallidos`,
      failures: d.failures,
      samples: d.sample_blocks,
      kind: d.parsed_failed > 0 ? 'warning' : 'success',
    });
  } catch (e) {
    toast('Error: ' + e.message);
  }
}


// ------- Banner -------
function showBanner({ title, message, failures, samples, hint, kind = 'warning' }) {
  const banner = $('#diagnostic-banner');
  let cls = 'banner';
  if (kind === 'error') cls += ' error';
  else if (kind === 'success') cls += ' success';
  banner.className = cls;
  let html = `<button class="close-banner" onclick="document.getElementById('diagnostic-banner').classList.add('hidden')">×</button>`;
  html += `<h3>${escapeHtml(title)}</h3>`;
  if (message) html += `<div style="white-space:pre-wrap">${escapeHtml(message)}</div>`;
  if (hint) html += `<div style="margin-top:6px;opacity:0.85">${escapeHtml(hint)}</div>`;
  if (failures && failures.length) {
    html += `<div style="margin-top:10px;font-weight:600">Detalle de bloques con problemas:</div>`;
    failures.forEach(f => {
      html += `<div style="margin-top:6px"><strong>Bloque #${f.block_index}</strong> — ${escapeHtml(f.reason)}</div>`;
      if (f.first_lines) html += `<pre>${escapeHtml(f.first_lines)}</pre>`;
    });
  } else if (samples && samples.length) {
    html += `<div style="margin-top:10px;font-weight:600">Primer bloque del archivo (muestra):</div>`;
    html += `<pre>${escapeHtml(samples[0].slice(0, 500))}</pre>`;
  }
  banner.innerHTML = html;
  banner.classList.remove('hidden');
}
function hideBanner() { $('#diagnostic-banner').classList.add('hidden'); }


// ------- Portadas (background) -------
let coversFetching = false;
async function fetchCoversInBackground() {
  if (coversFetching) return;
  coversFetching = true;
  try {
    // Hacer en lotes pequeños para que la UI siga responsiva
    while (true) {
      const res = await api('/api/fetch-covers', { method: 'POST', body: JSON.stringify({ limit: 5 }) });
      if (!res.ok || res.checked === 0) break;
      // Refrescar la biblioteca si el usuario está en esa pestaña
      if (state.tab === 'books') {
        state.books = await api('/api/books');
        renderBooks();
      } else {
        state.books = await api('/api/books');
      }
      // Pausa entre lotes (no hostigar la API)
      await new Promise(r => setTimeout(r, 300));
    }
  } catch (e) { /* silencio */ }
  finally { coversFetching = false; }
}


// ------- Filtros -------
async function loadFilters() {
  state.books = await api('/api/books');
  state.languages = await api('/api/languages');
  renderLangFilters();
  renderBookFilters();
}

function renderLangFilters() {
  const c = $('#lang-filters');
  if (!state.languages.length) {
    c.innerHTML = '<div style="font-size:12px;color:var(--text-3);padding:6px">Sin datos.</div>';
    return;
  }
  c.innerHTML = state.languages.map(l => {
    const checked = state.selectedLangs.has(l.lang) ? 'checked' : '';
    return `<label>
      <input type="checkbox" class="lang-cb" value="${escapeAttr(l.lang)}" ${checked}>
      <span>${escapeHtml(l.lang.toUpperCase())}</span>
      <span class="count">${l.count}</span>
    </label>`;
  }).join('');
  $$('.lang-cb').forEach(cb => cb.addEventListener('change', () => {
    cb.checked ? state.selectedLangs.add(cb.value) : state.selectedLangs.delete(cb.value);
    reload();
  }));
}

function renderBookFilters() {
  const c = $('#book-filters');
  const q = ($('#book-search').value || '').toLowerCase();
  const filtered = state.books.filter(b =>
    !q || b.title.toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q)
  );
  if (!filtered.length) {
    c.innerHTML = '<div style="font-size:12px;color:var(--text-3);padding:6px">Sin libros.</div>';
    return;
  }
  c.innerHTML = filtered.map(b => {
    const checked = state.selectedBooks.has(b.id) ? 'checked' : '';
    const totalNote = b.total_count > b.highlights_count
      ? ` <span title="${b.total_count - b.highlights_count} marcadores/vacíos/bloqueados" style="color: var(--text-3);">(+${b.total_count - b.highlights_count})</span>`
      : '';
    return `<label>
      <input type="checkbox" class="book-cb" value="${b.id}" ${checked}>
      <span>${escapeHtml(b.title)}</span>
      <span class="count">${b.highlights_count}${totalNote}</span>
    </label>`;
  }).join('');
  $$('.book-cb').forEach(cb => cb.addEventListener('change', () => {
    const id = parseInt(cb.value, 10);
    cb.checked ? state.selectedBooks.add(id) : state.selectedBooks.delete(id);
    reload();
  }));
}


// ------- Tabs + Render -------
function setTab(tab) {
  state.tab = tab;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  // Botón "Buscar portadas" solo visible en biblioteca
  $('#btn-fetch-covers').classList.toggle('hidden', tab !== 'books');
  reload();
}

async function reload() {
  if (state.tab === 'books') {
    renderBooks();
    return;
  }
  const params = new URLSearchParams();
  if (state.selectedBooks.size) params.set('book_ids', [...state.selectedBooks].join(','));
  if (state.selectedLangs.size) params.set('languages', [...state.selectedLangs].join(','));
  if (state.search) params.set('search', state.search);

  if (state.tab === 'highlights') {
    if (state.selectedTypes.size) params.set('types', [...state.selectedTypes].join(','));
    state.results = await api('/api/highlights?' + params.toString());
    renderHighlights();
  } else if (state.tab === 'vocab') {
    state.results = await api('/api/vocab?' + params.toString());
    renderVocab();
  }
}

function setResultCount(n, label) {
  $('#result-count').textContent = `${n} ${label}`;
}

function renderHighlights() {
  const c = $('#results');
  c.classList.remove('books-grid');
  setResultCount(state.results.length, state.results.length === 1 ? 'subrayado' : 'subrayados');
  if (!state.results.length) {
    c.innerHTML = '<div class="empty"><p>Sin resultados con los filtros actuales.</p></div>';
    return;
  }
  c.innerHTML = state.results.map(h => {
    const isNote = h.type === 'note';
    const isBookmark = h.type === 'bookmark';
    const isEmpty = h.type === 'empty';
    const isDropped = h.type === 'dropped';
    const loc = h.location_start
      ? `loc. ${h.location_start}${h.location_end && h.location_end !== h.location_start ? '–' + h.location_end : ''}`
      : (h.page ? `pág. ${h.page}` : '');

    const metaParts = [`<strong>${escapeHtml(h.title)}</strong>`];
    if (h.author) metaParts.push(escapeHtml(h.author));
    if (loc) metaParts.push(escapeHtml(loc));

    let typeTag = '';
    if (isNote) typeTag = '<span class="h-tag note-tag">Nota</span>';
    else if (isBookmark) typeTag = '<span class="h-tag bookmark-tag">Marcador</span>';
    else if (isEmpty) typeTag = '<span class="h-tag empty-tag">Sin texto</span>';
    else if (isDropped) typeTag = '<span class="h-tag dropped-tag">DRM</span>';
    const langTag = h.language ? `<span class="h-tag">${escapeHtml(h.language.toUpperCase())}</span>` : '';

    let cardClass = 'h-card';
    if (isNote) cardClass += ' note';
    else if (isBookmark) cardClass += ' bookmark';
    else if (isEmpty) cardClass += ' empty';
    else if (isDropped) cardClass += ' dropped';

    let contentHtml;
    if (isBookmark) {
      contentHtml = '<p class="h-content empty-content">Marcador colocado en esta posición.</p>';
    } else if (isEmpty) {
      contentHtml = '<p class="h-content empty-content">Subrayado sin texto extraíble (imagen, tabla o pie de página).</p>';
    } else if (isDropped) {
      contentHtml = '<p class="h-content empty-content">Texto bloqueado por DRM de Amazon. El Kindle no exportó el contenido.</p>';
    } else {
      contentHtml = `<p class="h-content">${escapeHtml(h.content)}</p>`;
    }

    return `<div class="${cardClass}">
      <div class="h-meta">
        <div class="h-meta-book">${metaParts.join('<span class="sep">·</span>')}</div>
        <div class="h-meta-tags">${typeTag}${langTag}</div>
      </div>
      ${contentHtml}
    </div>`;
  }).join('');
}

function renderVocab() {
  const c = $('#results');
  c.classList.remove('books-grid');
  setResultCount(state.results.length, state.results.length === 1 ? 'palabra' : 'palabras');
  if (!state.results.length) {
    c.innerHTML = '<div class="empty"><p>Sin vocabulario con los filtros actuales.</p></div>';
    return;
  }
  c.innerHTML = state.results.map(v => `
    <div class="v-card">
      <div>
        <span class="v-word">${escapeHtml(v.word)}</span>
        ${v.language ? `<span class="v-word-lang">${escapeHtml(v.language)}</span>` : ''}
      </div>
      <div>
        ${v.context ? `<div class="v-context">${escapeHtml(v.context)}</div>` : ''}
        ${v.book_title ? `<div class="v-source">de ${escapeHtml(v.book_title)}</div>` : ''}
      </div>
    </div>
  `).join('');
}

function renderBooks() {
  const c = $('#results');
  c.classList.add('books-grid');
  setResultCount(state.books.length, state.books.length === 1 ? 'libro' : 'libros');
  if (!state.books.length) {
    c.innerHTML = '<div class="empty"><p>Aún no hay libros. Sincroniza tu Kindle.</p></div>';
    return;
  }
  c.innerHTML = state.books.map(b => {
    const hasCover = b.cover_url && b.cover_url !== '__not_found__';
    const cover = hasCover
      ? `<img src="${escapeAttr(b.cover_url)}" alt="${escapeAttr(b.title)}" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
         <div class="book-cover-fallback" style="display:none"><div class="fallback-title">${escapeHtml(b.title)}</div></div>`
      : `<div class="book-cover-fallback"><div class="fallback-title">${escapeHtml(b.title)}</div></div>`;

    const useful = b.highlights_count;
    const extras = b.total_count - useful;
    const countLabel = useful === 1 ? '1 subrayado' : `${useful} subrayados`;
    const extrasLabel = extras > 0 ? ` <span style="color: var(--text-3);" title="Marcadores, sin texto o bloqueados por DRM">+${extras}</span>` : '';

    return `<div class="book-card" data-book-id="${b.id}">
      <div class="book-cover">${cover}</div>
      <div class="book-info">
        <div class="b-title">${escapeHtml(b.title)}</div>
        <div class="b-author">${escapeHtml(b.author || '—')}</div>
        <div class="b-stats">${countLabel}${extrasLabel}</div>
      </div>
    </div>`;
  }).join('');

  $$('.book-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = parseInt(card.dataset.bookId, 10);
      state.selectedBooks.clear();
      state.selectedBooks.add(id);
      setTab('highlights');
      renderBookFilters();
    });
  });
}


// ------- Export dialog (sin cambios funcionales) -------
function getExportOptions() {
  const opts = {};
  $$('#export-dialog input[data-opt]').forEach(cb => { opts[cb.dataset.opt] = cb.checked; });
  return opts;
}
function setExportOptions(opts) {
  $$('#export-dialog input[data-opt]').forEach(cb => {
    if (cb.dataset.opt in opts) cb.checked = opts[cb.dataset.opt];
  });
  refreshPreview();
}

const PRESETS = {
  full: {
    include_book_title: true, include_author: true, include_language: true,
    include_location: true, include_date: true, include_type: true,
    include_context: true, include_word_language: true,
    include_source_book: true, include_lookup_date: true,
    group_by_book: true, include_front_matter: true, include_main_heading: true,
  },
  'text-only': {
    include_book_title: false, include_author: false, include_language: false,
    include_location: false, include_date: false, include_type: false,
    include_context: false, include_word_language: false,
    include_source_book: false, include_lookup_date: false,
    group_by_book: false, include_front_matter: false, include_main_heading: false,
  },
  study: {
    include_book_title: true, include_author: false, include_language: true,
    include_location: false, include_date: false, include_type: false,
    include_context: true, include_word_language: true,
    include_source_book: true, include_lookup_date: false,
    group_by_book: true, include_front_matter: false, include_main_heading: true,
  },
};

function openExportDialog() {
  $('#export-dialog').classList.remove('hidden');
  setActivePreset('full');
  refreshPreview();
}
function closeExportDialog() { $('#export-dialog').classList.add('hidden'); }
function setActivePreset(name) {
  $$('.btn-preset').forEach(b => b.classList.toggle('active', b.dataset.preset === name));
  setExportOptions(PRESETS[name]);
}

let previewTimer = null;
async function refreshPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const kind = state.tab === 'vocab' ? 'vocab' : 'highlights';
    const fmt = $('#export-format').value;
    try {
      const res = await api('/api/export', {
        method: 'POST',
        body: JSON.stringify({
          kind, format: fmt,
          filters: buildFilters(kind),
          options: getExportOptions(),
        }),
      });
      $('#export-preview').textContent = res.preview || '(vacío)';
    } catch (e) {
      $('#export-preview').textContent = 'Error: ' + e.message;
    }
  }, 250);
}

function buildFilters(kind) {
  const f = {};
  if (state.selectedLangs.size) f.languages = [...state.selectedLangs];
  if (state.search) f.search = state.search;
  if (kind === 'highlights') {
    if (state.selectedBooks.size) f.book_ids = [...state.selectedBooks];
    if (state.selectedTypes.size) f.types = [...state.selectedTypes];
  } else {
    if (state.selectedBooks.size) {
      f.book_titles = state.books.filter(b => state.selectedBooks.has(b.id)).map(b => b.title);
    }
  }
  return f;
}

async function doExport() {
  const kind = state.tab === 'vocab' ? 'vocab' : 'highlights';
  const fmt = $('#export-format').value;
  try {
    const res = await api('/api/export', {
      method: 'POST',
      body: JSON.stringify({ kind, format: fmt, filters: buildFilters(kind), options: getExportOptions() }),
    });
    if (!res.ok) { toast('Error: ' + (res.error || 'desconocido')); return; }
    toast(`Exportado a ${res.filename} (${res.items} elementos).`);
    closeExportDialog();
    await api('/api/open-exports');
  } catch (e) { toast('Error: ' + e.message); }
}


// ------- Helpers -------
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}


// ------- Wire up -------
document.addEventListener('DOMContentLoaded', async () => {
  $('#btn-sync').addEventListener('click', doSync);
  $('#btn-diagnose').addEventListener('click', doDiagnose);
  $('#btn-fetch-covers').addEventListener('click', async () => {
    toast('Buscando portadas en segundo plano…');
    fetchCoversInBackground();
  });
  $$('.tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    clearTimeout(window._srchT);
    window._srchT = setTimeout(reload, 200);
  });
  $('#book-search').addEventListener('input', renderBookFilters);
  $('#btn-select-all').addEventListener('click', () => {
    state.books.forEach(b => state.selectedBooks.add(b.id));
    renderBookFilters(); reload();
  });
  $('#btn-select-none').addEventListener('click', () => {
    state.selectedBooks.clear();
    renderBookFilters(); reload();
  });
  $$('.type-filter').forEach(cb => cb.addEventListener('change', () => {
    cb.checked ? state.selectedTypes.add(cb.value) : state.selectedTypes.delete(cb.value);
    reload();
  }));
  $('#btn-export').addEventListener('click', openExportDialog);
  $('#btn-cancel-export').addEventListener('click', closeExportDialog);
  $('#btn-close-dialog').addEventListener('click', closeExportDialog);
  $('#btn-do-export').addEventListener('click', doExport);
  $('#export-format').addEventListener('change', refreshPreview);
  $$('.btn-preset').forEach(b => b.addEventListener('click', () => setActivePreset(b.dataset.preset)));
  $$('#export-dialog input[data-opt]').forEach(cb => cb.addEventListener('change', refreshPreview));

  // Cerrar dialog con Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#export-dialog').classList.contains('hidden')) closeExportDialog();
  });

  await refreshStatus();
  await loadFilters();
  await reload();
});

})();
