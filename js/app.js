import { Library } from './store.js';
import { parseClippings, readVocabDbDetailed } from './parser.js';
import { parseNotebookHtml, parseAmazonExport } from './notebook.js';
import { SyncManager, syncSupported } from './sync.js';
import { pickKindleFolder, readKindleFiles, readKindleFolder, folderAccessSupported, rescanSavedKindle, hasSavedKindle } from './kindle.js';
import { findCover } from './covers.js';
import { buildExport, PRESETS, DEFAULT_OPTIONS, vocamasterBlocks, ultramindMaps } from './export.js';
import { speak, speechSupported } from './speech.js';
import { translate, googleTranslateUrl, needsTranslation, builtInTranslator, SAME_LANGUAGE } from './translate.js';
import { amazonBookmarkletHref, AMAZON_NOTEBOOK_ORIGIN } from './amazon.js';

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const state = {
  tab: 'highlights',
  selectedBooks: new Set(),
  selectedLangs: new Set(),
  selectedTypes: new Set(['highlight', 'note', 'bookmark']),
  // Se ven todas salvo las que tú ignoras (al enviar a VocaMaster ya se saltan las que te sabes).
  selectedStatuses: new Set(['new', 'sent', 'known']),
  selectedWords: new Set(), // wordKey de las palabras elegidas con su casilla
  lastChecked: null,
  bookView: 'all',          // Biblioteca: all | device | missing        // índice de la última casilla pulsada (Mayús+clic elige el tramo)
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
let lastReport = '';

/** Informe de lo que se encontró, para copiarlo y entender una importación rara. */
function buildReport(r, info) {
  const out = [`Informe de importación de KindleVault — ${new Date().toLocaleString('es-ES')}`];
  if (r.folderName) out.push(`Carpeta elegida: ${r.folderName}`, `Contenido: ${(r.rootEntries || []).join(', ') || '(vacía)'}`);
  else out.push('Archivos elegidos a mano: ' + (r.fileNames || []).join(', '));
  if (info.diag) {
    const d = info.diag;
    out.push(`My Clippings.txt: ${d.size} bytes, ${d.encoding}, ${d.total_blocks} bloques, ${d.parsed_ok} leídos, ${d.parsed_failed} sin leer`);
  } else out.push('My Clippings.txt: no encontrado');
  if (info.clipBooks) out.push(`Libros en My Clippings.txt (${info.clipBooks.length}):`, ...info.clipBooks.map(([t, n]) => `  · ${t} — ${n}`));
  if (r.vocab) {
    const v = info.vocab || {};
    out.push(`vocab.db: ${r.vocab.db.bytes.byteLength} bytes${info.vocabCount != null ? `, ${info.vocabCount} búsquedas` : ' (no se pudo leer)'}` +
      `${v.walMode ? ', modo WAL' : ''} · vocab.db-wal: ${r.vocab.wal ? `${r.vocab.wal.bytes.byteLength} bytes, ${v.walFrames || 0} cambios leídos (${v.walPages || 0} páginas)` : 'no'}` +
      ` · vocab.db-shm: ${r.vocab.shm ? 'sí' : 'no'}`);
    if (v.latest && v.latest.length) out.push('Últimas búsquedas en vocab.db:', ...v.latest.map(e => `  · ${e.looked_up_at || '(sin fecha)'} — ${e.word} — ${e.book_title || '(sin libro)'}`));
    if (v.perBook && v.perBook.length) out.push(`Libros en vocab.db (${v.perBook.length}):`, ...v.perBook.map(([t, n, at]) => `  · ${t} — ${n} búsquedas, la última ${at || '(sin fecha)'}`));
    if (r.vocab.db.modified) out.push(`vocab.db modificado por última vez: ${new Date(r.vocab.db.modified).toISOString()}`);
    if (r.vocab.folder) out.push(`Carpeta de vocab.db: ${r.vocab.folder.join(', ')}`);
    if (v.header) out.push(`Cabecera: páginas de ${v.header.pageSize} bytes, ${v.header.pages} en el archivo (${v.header.pagesInHeader} según la cabecera), ${v.header.freelistPages} libres, contador de cambios ${v.header.changeCounter}`);
    if (v.stats) {
      const st = v.stats;
      out.push(`Filas: LOOKUPS ${st.lookups}, WORDS ${st.words}, BOOK_INFO ${st.bookInfo} · búsquedas sin su palabra en WORDS: ${st.withoutWord} · sin su libro en BOOK_INFO: ${st.withoutBook}`);
      out.push('BOOK_INFO:', ...st.books.map(b => `  · ${b.id} · ${b.asin || '-'} · ${b.title}`));
      out.push('Búsquedas por book_key:', ...[...st.bookKeys.entries()].map(([k, n]) => `  · ${k || '(vacío)'} — ${n}`));
      for (const [name, sql] of Object.entries(st.tables)) out.push(`Tabla ${name}: ${sql.replace(/\s+/g, ' ')}`);
    }
    if (v.orphans) {
      const o = v.orphans;
      if (o.error) out.push(`Restos de búsquedas: no se pudo mirar (${o.error})`);
      else {
        out.push(`Restos de búsquedas fuera de las tablas (borradas o no alcanzadas): ${o.total}`);
        out.push(...o.perBook.map(([t, n]) => `  · ${t} — ${n}`));
        out.push(...o.sample.map(x => `  · ej.: ${x.at || '(sin fecha)'} — ${x.word} — ${x.book} — «${x.usage || ''}»`));
      }
    }
  } else out.push('vocab.db: no encontrado');
  if (r.deviceBooks) {
    out.push(`Libros en el Kindle (${r.deviceBooks.length} archivos):`);
    for (const f of r.deviceBooks.slice(0, 300)) {
      out.push(`  · ${f.file} → ${f.title || '(sin título)'}${f.asin ? ` [${f.asin}]` : ''}` +
        (f.sidecarFiles && f.sidecarFiles.length ? ` · .sdr: ${f.sidecarFiles.join(', ')}` : ' · sin .sdr'));
    }
  } else if (r.folderName) out.push('No encontré la carpeta documents: no se pudo listar los libros del Kindle.');
  out.push('', 'Por libro (subrayados aquí / en el Kindle según .sdr · palabras · ¿en el Kindle?):');
  for (const b of lib.listBooks()) {
    const dc = b.device_counts;
    out.push(`  · ${b.title}${b.author ? ` — ${b.author}` : ''}: ${b.hl_count}${dc ? ` / ${dc.highlights} (notas ${dc.notes}, marcadores ${dc.bookmarks})` : ''} · ${b.vocab_count} palabras · ${b.on_device ? 'sí' : 'no'}${b.in_cloud ? ' · en la nube' : ''}`);
  }
  for (const n of info.notebooks || []) out.push(`Cuaderno: ${n}`);
  for (const n of info.amazon || []) out.push(`Nube de Amazon: ${n}`);
  return out.join('\n');
}

async function processImport(r, { rescan = false } = {}) {
  closeDialog('import-dialog');
  const hasAny = r.clippings || r.vocab || r.walAlone || (r.notebooks && r.notebooks.length) || (r.amazon && r.amazon.length) || (r.syncFiles && r.syncFiles.length) || (r.deviceBooks && r.deviceBooks.length);
  if (!hasAny) {
    showBanner({
      title: 'No he encontrado los archivos del Kindle',
      message: r.folderName
        ? `En «${r.folderName}» no están My Clippings.txt ni vocab.db. Elige la unidad del Kindle completa (por ejemplo D:), no una carpeta de dentro.`
        : 'Elige My Clippings.txt, vocab.db, un cuaderno exportado (.html) o el archivo de la nube de Amazon (.json).',
      kind: 'error',
    });
    return;
  }
  const lines = [];
  if (r.folderName) lines.push(`Leído de «${r.folderName}».`);
  const info = {};
  let diag = null;
  let kind = 'success';
  if (r.clippings) {
    const parsed = parseClippings(r.clippings.bytes, r.clippings.name);
    diag = info.diag = parsed.diagnosis;
    const perBook = new Map();
    for (const h of parsed.items) if (h.type === 'highlight' || h.type === 'note') perBook.set(h.bookTitle, (perBook.get(h.bookTitle) || 0) + 1);
    info.clipBooks = [...perBook.entries()].sort((a, b) => b[1] - a[1]);
    const { added, dup, moved } = lib.importHighlights(parsed.items);
    lines.push(`My Clippings.txt (subrayados, notas y marcadores): ${fmtNum(added)} nuevo${added === 1 ? '' : 's'} · ${fmtNum(dup)} ya estaba${dup === 1 ? '' : 'n'} · de ${fmtNum(perBook.size)} libro${perBook.size === 1 ? '' : 's'}.`);
    if (moved) lines.push(`Corregidos ${fmtNum(moved)} subrayados que estaban en otro libro de título parecido.`);
    const dropped = parsed.items.filter(h => h.type === 'dropped');
    if (dropped.length) {
      const nb = new Set(dropped.map(h => h.bookTitle)).size;
      lines.push(`${fmtNum(dropped.length)} subrayados de ${fmtNum(nb)} libro${nb === 1 ? '' : 's'} están bloqueados por el límite de recortes de Amazon: el Kindle no guardó su texto (se ven con el filtro «Bloqueados»).`);
    }
    if (diag.parsed_failed) { lines.push(`${fmtNum(diag.parsed_failed)} bloques del archivo no se pudieron leer.`); kind = 'warning'; }
  } else if (r.folderName) {
    lines.push('No se encontró My Clippings.txt (subrayados).');
    kind = 'warning';
  }
  // Primero los libros del Kindle, para casar por ASIN las palabras cuyo libro
  // no tiene ficha en vocab.db.
  const inv = r.deviceBooks ? lib.applyDeviceInventory(r.deviceBooks) : null;
  if (r.vocab) {
    try {
      const res = readVocabDbDetailed(r.vocab.db.bytes, r.vocab.wal && r.vocab.wal.bytes);
      const entries = res.entries;
      info.vocabCount = entries.length;
      const perBook = new Map();
      for (const e of entries) {
        const t = e.book_title || (e.book_asin && lib.findBookByAsin(e.book_asin) || {}).title || '(sin libro)';
        const pb = perBook.get(t) || [t, 0, e.looked_up_at];
        pb[1]++;
        perBook.set(t, pb);
      }
      info.vocab = { ...res, entries: undefined, latest: entries.slice(0, 10), perBook: [...perBook.values()] };
      const added = lib.importVocab(entries);
      const books = [...perBook.keys()].filter(t => t !== '(sin libro)').length;
      lines.push(`Vocabulario: ${fmtNum(added)} palabra${added === 1 ? '' : 's'} nueva${added === 1 ? '' : 's'} de ${fmtNum(entries.length)} búsqueda${entries.length === 1 ? '' : 's'}, en ${fmtNum(books)} libro${books === 1 ? '' : 's'}.`);
      // Para ver de un vistazo si lo leído está al día.
      const last = entries[0];
      if (last) {
        const lastBook = last.book_title || (last.book_asin && (lib.findBookByAsin(last.book_asin) || {}).title);
        lines.push(`La última palabra buscada que hay en vocab.db es «${last.word}»${lastBook ? `, en «${lastBook}»` : ''}${last.looked_up_at ? ` (${fmtWhen(last.looked_up_at)})` : ''}.` +
          (r.vocab.db.modified ? ` El Kindle guardó vocab.db por última vez: ${fmtWhen(new Date(r.vocab.db.modified).toISOString())}.` : ''));
      }
      if (res.walFrames) lines.push(`(${fmtNum(res.walFrames)} cambios aún sin volcar leídos de vocab.db-wal.)`);
      // Elegido a mano sin su -wal: pueden faltar justo las búsquedas más recientes.
      if (res.walMode && !r.vocab.wal && !r.folderName) {
        lines.push('Has elegido vocab.db sin vocab.db-wal. El Kindle guarda primero las palabras que buscas en vocab.db-wal y tarda en pasarlas a vocab.db, así que pueden faltar las más recientes. Si en system/vocabulary hay un vocab.db-wal, elige los dos archivos a la vez (o arrastra aquí la carpeta vocabulary entera).');
        kind = 'warning';
      }
    } catch (e) {
      lines.push(`No se pudo leer vocab.db: ${e.message}`);
      kind = 'warning';
    }
  } else if (r.walAlone) {
    lines.push('Has elegido vocab.db-wal sin vocab.db: elige los dos archivos a la vez (están en system/vocabulary).');
    kind = 'warning';
  } else if (r.folderName) {
    lines.push('No se encontró vocab.db (vocabulario). Si quieres el vocabulario, elige la unidad del Kindle completa.');
  }
  for (const nb of r.notebooks || []) {
    const res = parseNotebookHtml(new TextDecoder().decode(nb.bytes));
    info.notebooks = info.notebooks || [];
    if (!res.items.length) { lines.push(`«${nb.name}»: no parece un cuaderno exportado de Kindle.`); kind = 'warning'; info.notebooks.push(`${nb.name}: no reconocido`); continue; }
    const { added, dup } = lib.importHighlights(res.items);
    lines.push(`Cuaderno de «${res.title}»: ${fmtNum(added)} nuevos · ${fmtNum(dup)} ya estaban.`);
    info.notebooks.push(`${nb.name}: «${res.title}», ${res.items.length} elementos`);
  }
  for (const am of r.amazon || []) {
    try {
      const res = parseAmazonExport(JSON.parse(new TextDecoder().decode(am.bytes)));
      const { added, dup } = lib.importHighlights(res.items);
      for (const b of res.books) {
        const book = lib.findOrCreateBook(b.title, b.author, null, b.asin);
        book.in_cloud = true;
      }
      lines.push(`Nube de Amazon: ${fmtNum(res.books.length)} libros con subrayados · ${fmtNum(added)} subrayados y notas nuevos · ${fmtNum(dup)} ya estaban.`);
      if (res.failed) { lines.push(res.failed === 1 ? '1 libro no se pudo leer en Amazon.' : `${fmtNum(res.failed)} libros no se pudieron leer en Amazon.`); kind = 'warning'; }
      (info.amazon = info.amazon || []).push(`${am.name}: ${res.books.length} libros, ${res.items.length} elementos, ${res.failed} fallidos`);
    } catch (e) {
      lines.push(`«${am.name}» no se pudo leer: ${e.message}`);
      kind = 'warning';
    }
  }
  for (const sf of r.syncFiles || []) {
    try {
      const changed = lib.merge(JSON.parse(new TextDecoder().decode(sf.bytes)));
      lines.push(changed ? `«${sf.name}»: datos combinados.` : `«${sf.name}»: no había nada nuevo.`);
    } catch (e) { lines.push(`«${sf.name}» no se pudo leer: ${e.message}`); kind = 'warning'; }
  }
  if (inv) {
    const onDevice = lib.listBooks().filter(b => b.on_device);
    const withHl = onDevice.filter(b => b.highlights_count).length;
    const withVocab = onDevice.filter(b => b.vocab_count).length;
    lines.push(`En el Kindle hay ${fmtNum(inv.books)} libro${inv.books === 1 ? '' : 's'}${inv.unresolved ? ` (y ${fmtNum(inv.unresolved)} archivo${inv.unresolved === 1 ? '' : 's'} sin título legible)` : ''}: ${fmtNum(withHl)} con subrayados y ${fmtNum(withVocab)} con palabras buscadas. Todos aparecen en la Biblioteca.`);
    const titleOf = k => (lib.books.get(k) || {}).title || '?';
    const list = keys => keys.slice(0, 8).map(k => `«${titleOf(k)}»`).join(', ') + (keys.length > 8 ? ` y ${keys.length - 8} más` : '');
    if (inv.arrived.length) lines.push(`Libros nuevos en el Kindle desde el último escaneo: ${list(inv.arrived)}.`);
    if (inv.left.length) lines.push(`Ya no están en el Kindle: ${list(inv.left)} (se conservan aquí).`);
    // El Kindle sabe cuántas anotaciones tiene cada libro (carpeta .sdr), vengan de donde vengan.
    const lacking = onDevice.filter(b => b.device_counts && b.device_counts.highlights > b.hl_count);
    if (lacking.length) {
      const missing = lacking.reduce((n, b) => n + b.device_counts.highlights - b.hl_count, 0);
      lines.push(`En ${fmtNum(lacking.length)} libro${lacking.length === 1 ? '' : 's'} el Kindle tiene ${fmtNum(missing)} subrayado${missing === 1 ? '' : 's'} más de los que hay aquí (p. ej. ${list(lacking.map(b => b.key))}). Son subrayados hechos en otro aparato que el Kindle recibió al descargar el libro: los guarda sin su texto y no los escribe en My Clippings.txt. Tráelos con Importar → «Nube de Amazon».`);
      kind = 'warning';
    } else if (inv.books - withHl > 0 && !onDevice.some(b => b.device_counts)) {
      lines.push('El Kindle solo guarda en My Clippings.txt lo que subrayas en ese mismo aparato. Lo subrayado en el móvil, el ordenador u otro Kindle está en la nube de Amazon: Importar → «Nube de Amazon».');
    }
  }
  lib.guessMissingLanguages();
  await lib.save();
  refreshAll();
  const s = lib.stats();
  lines.push(`Ahora tienes ${fmtNum(s.books)} libros, ${fmtNum(s.highlights)} subrayados con texto y ${fmtNum(s.vocab)} palabras.`);
  const sup = lib.supersededCount();
  if (sup) lines.push(sup === 1
    ? 'Oculta 1 versión repetida o anterior de un subrayado (filtro «Versiones anteriores»).'
    : `Ocultas ${fmtNum(sup)} versiones repetidas o anteriores de subrayados (filtro «Versiones anteriores»).`);
  lastReport = buildReport(r, info);
  renderRescanButtons();
  showBanner({
    title: rescan ? 'Kindle escaneado de nuevo' : 'Importación completada', message: lines.join('\n'), failures: diag && diag.failures, kind,
    actions: [{ label: 'Copiar informe detallado', run: copyReport }],
  });
  sync.schedule();
  fetchCovers();
}

async function copyReport() {
  try { await navigator.clipboard.writeText(lastReport); toast('✓ Informe copiado: puedes pegarlo en el chat con Claude'); }
  catch { download(new Blob([lastReport], { type: 'text/plain;charset=utf-8' }), 'kindlevault-informe.txt'); }
}

async function rescanKindle() {
  hideBanner();
  toast('Leyendo el Kindle…');
  let r = await rescanSavedKindle();
  if (!r) {
    try {
      r = await pickKindleFolder();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      showBanner({
        title: 'No encuentro el Kindle de la última vez',
        message: '¿Está conectado por USB? Si ha cambiado de letra de unidad, elígelo de nuevo.',
        actions: [{ label: 'Elegir el Kindle', run: importFromKindleFolder }],
      });
      return;
    }
  }
  processImport(r, { rescan: true });
}

async function renderRescanButtons() {
  const show = folderAccessSupported && (!!lib.device || await hasSavedKindle());
  $('#btn-rescan').classList.toggle('hidden', !show);
  $('#btn-rescan-dialog').classList.toggle('hidden', !show);
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
  renderSelectionBar();
}

function refreshAll() {
  renderStats();
  renderSupersededCount();
  renderStatusFilters();
  renderLangFilters();
  renderBookFilters();
  reload();
}

/** Recuerda a la vista que hay un filtro puesto (p. ej. tras abrir un libro desde la Biblioteca). */
function renderActiveFilters() {
  const el = $('#active-filters');
  const parts = [];
  if (state.selectedBooks.size) {
    const titles = [...state.selectedBooks].map(k => (lib.books.get(k) || {}).title).filter(Boolean);
    parts.push(titles.length === 1 ? `«${titles[0]}»` : `${fmtNum(titles.length)} libros`);
  }
  if (state.selectedLangs.size) parts.push([...state.selectedLangs].map(langName).join(', '));
  if (!parts.length || state.tab === 'books') { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `Mostrando solo: <strong>${esc(parts.join(' · '))}</strong> <button class="link-btn" id="clear-filters">Ver todo</button>`;
  $('#clear-filters').onclick = () => {
    state.selectedBooks.clear(); state.selectedLangs.clear();
    renderLangFilters(); renderBookFilters(); reload();
  };
}

function reload() {
  renderActiveFilters();
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
      <button class="btn btn-primary" id="w-import">Importar</button>
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
  const html = items.slice(start, end).map((h, j) => {
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
    if (h.type === 'highlight' || h.type === 'note') body += langToolsHtml(h.language, 'h');
    return `<article class="h-card ${h.type === 'highlight' ? '' : h.type}${h.superseded ? ' superseded' : ''}" data-i="${start + j}">
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
  const html = items.slice(start, end).map((v, j) => `
    <article class="v-card${state.selectedWords.has(v.wkey) ? ' selected' : ''}" data-wkey="${esc(v.wkey)}" data-i="${start + j}">
      <div>
        <input type="checkbox" class="v-cb" data-i="${start + j}" aria-label="Elegir ${esc(v.word)}" title="Elegir esta palabra (Mayús+clic: elegir un tramo)"${state.selectedWords.has(v.wkey) ? ' checked' : ''}>
        <span class="v-word">${esc(v.word)}</span>${speechSupported ? '<button class="icon-btn" data-speak="word" title="Escuchar la palabra" aria-label="Escuchar la palabra">🔊</button>' : ''}${v.language ? `<span class="v-word-lang">${esc(v.language)}</span>` : ''}
        ${v.stem && v.stem.toLowerCase() !== v.word.toLowerCase() ? `<div class="v-stem">forma base: ${esc(v.stem)}</div>` : ''}
      </div>
      <div>
        ${v.context ? `<div class="v-context">${highlightWord(v.context, v.word)}${speechSupported ? ' <button class="icon-btn" data-speak="context" title="Escuchar la frase" aria-label="Escuchar la frase">🔊</button>' : ''}</div>` : ''}
        ${v.book_title ? `<div class="v-source">de ${esc(v.book_title)}${v.looked_up_at ? ' · ' + esc(fmtWhen(v.looked_up_at)) : ''}</div>` : ''}
        <div class="v-translation hidden"></div>
        <div class="v-actions">${wordActionsHtml(v.status)}${needsTranslation(v.language) ? '<button class="link-btn" data-translate>Traducir</button>' : ''}</div>
      </div>
    </article>`).join('');
  if (append) { c.querySelector('.load-more')?.remove(); c.insertAdjacentHTML('beforeend', html); }
  else { c.innerHTML = html; c.scrollTop = 0; state.lastChecked = null; }
  renderedCount = end;
  if (end < items.length) addLoadMore(c, items.length - end, () => renderVocab(true));
  renderSelectionBar();
}

// ----- Elegir palabras con su casilla -----
function renderSelectionBar() {
  const bar = $('#selection-bar');
  if (state.tab !== 'vocab' || !lib.vocab.size) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const n = state.selectedWords.size;
  bar.classList.toggle('active', n > 0);
  bar.innerHTML = n
    ? `<strong>${fmtNum(n)} palabra${n === 1 ? '' : 's'} elegida${n === 1 ? '' : 's'}</strong>
       <button class="btn btn-primary btn-sm" data-sel-act="send">Enviar a VocaMaster</button>
       <button class="link-btn" data-sel-act="known">Me las sé</button>
       <button class="link-btn" data-sel-act="ignored">Ignorar</button>
       <button class="link-btn" data-sel-act="all">Elegir todas las de la lista</button>
       <button class="link-btn" data-sel-act="none">Quitar selección</button>`
    : `<span class="muted">Marca la casilla de cada palabra para elegir cuáles enviar (Mayús+clic elige un tramo).</span>
       <button class="link-btn" data-sel-act="all">Elegir todas las de la lista</button>`;
}

function paintSelection(keys) {
  const set = keys ? new Set(keys) : null;
  $$('.v-card').forEach(c => {
    if (set && !set.has(c.dataset.wkey)) return;
    const on = state.selectedWords.has(c.dataset.wkey);
    c.classList.toggle('selected', on);
    c.querySelector('.v-cb').checked = on;
  });
  renderSelectionBar();
}

function toggleWordCheckbox(cb, shift) {
  const i = +cb.dataset.i;
  const on = cb.checked;
  let from = i, to = i;
  if (shift && state.lastChecked !== null) { from = Math.min(i, state.lastChecked); to = Math.max(i, state.lastChecked); }
  const keys = state.results.slice(from, to + 1).map(v => v.wkey);
  for (const k of keys) on ? state.selectedWords.add(k) : state.selectedWords.delete(k);
  state.lastChecked = i;
  paintSelection(keys);
}

async function selectionAction(act) {
  if (act === 'all') { state.results.forEach(v => state.selectedWords.add(v.wkey)); paintSelection(); }
  else if (act === 'none') { state.selectedWords.clear(); state.lastChecked = null; paintSelection(); }
  else if (act === 'send') openVocaMaster();
  else if (act === 'known' || act === 'ignored') {
    const keys = [...state.selectedWords];
    await setWordStatus(keys, act);
    state.selectedWords.clear();
    paintSelection();
    toast(`✓ ${fmtNum(keys.length)} palabra${keys.length === 1 ? '' : 's'} marcada${keys.length === 1 ? '' : 's'} como «${STATUS_TAGS[act]}»`);
  }
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
      const tr = c.querySelector('[data-translate]');
      c.querySelector('.v-actions').innerHTML = wordActionsHtml(status) + (tr ? tr.outerHTML : '');
    });
  }
  renderStatusFilters();
  await lib.save();
  sync.schedule();
}

// ----- Escuchar y traducir con el navegador -----
function langToolsHtml(lang, prefix) {
  const tools = [];
  if (speechSupported) tools.push('<button class="link-btn" data-speak="content">🔊 Escuchar</button>');
  if (needsTranslation(lang)) tools.push('<button class="link-btn" data-translate>Traducir</button>');
  if (!tools.length) return '';
  return `<div class="${prefix}-translation hidden"></div><div class="${prefix}-actions">${tools.join('')}</div>`;
}

async function speakFromCard(btn) {
  const card = btn.closest('[data-i]');
  const item = state.results[+card.dataset.i];
  if (!item) return;
  const what = btn.dataset.speak;
  const text = what === 'word' ? item.word : what === 'context' ? item.context : item.content;
  const ok = await speak(text, item.language, { rate: what === 'word' ? 0.85 : 1 });
  if (!ok) toast(`No hay ninguna voz de ${langName(item.language)} instalada en este equipo: se lee con la voz por defecto. En Windows se añaden en Configuración → Hora e idioma → Voz.`);
}

async function translateFromCard(btn) {
  const card = btn.closest('[data-i]');
  const item = state.results[+card.dataset.i];
  const box = card.querySelector('.v-translation, .h-translation');
  if (!item || !box) return;
  if (!box.classList.contains('hidden') && box.dataset.done) { box.classList.add('hidden'); return; }
  const isWord = card.classList.contains('v-card');
  const texts = isWord ? [item.word, item.context].filter(Boolean) : [item.content];
  box.classList.remove('hidden');
  box.textContent = 'Traduciendo…';
  const out = await translate(texts, item.language,
    p => { box.textContent = `Descargando el traductor del navegador para este idioma… ${Math.round(p * 100)} %`; });
  box.dataset.done = '1';
  if (out === SAME_LANGUAGE) { box.textContent = 'Este texto ya está en español.'; return; }
  if (!out) {
    const why = builtInTranslator ? 'El traductor de este navegador no sabe este idioma.' : 'Este navegador no trae traductor propio (Chrome de escritorio sí).';
    box.innerHTML = `${esc(why)} <a href="${esc(googleTranslateUrl(texts.join('\n'), item.language))}" target="_blank" rel="noopener">Abrir en Google Traductor ↗</a>`;
    return;
  }
  box.innerHTML = isWord
    ? `<strong>${esc(item.word)}</strong> → ${esc(out[0])}${out[1] ? `<div class="tr-sentence">${esc(out[1])}</div>` : ''}`
    : `<div class="tr-sentence">${esc(out[0])}</div>`;
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
  // Con un inventario del Kindle se puede ver qué hay en él y qué no.
  const known = !!lib.device;
  const missing = b => !b.on_device && (b.highlights_count || b.vocab_count || b.in_cloud);
  let chips = '';
  if (known) {
    const all = books.length, dev = books.filter(b => b.on_device).length, miss = books.filter(missing).length;
    chips = `<div class="book-views">
      ${[['all', `Todos (${all})`], ['device', `En el Kindle (${dev})`], ['missing', `No descargados (${miss})`]].map(([v, l]) =>
        `<button class="btn-preset${state.bookView === v ? ' active' : ''}" data-book-view="${v}">${l}</button>`).join('')}
      <span class="hint">Inventario del Kindle: ${esc(fmtWhen(lib.device.scannedAt))}</span>
    </div>`;
    if (state.bookView === 'device') books = books.filter(b => b.on_device);
    if (state.bookView === 'missing') books = books.filter(missing);
  }
  setCount(books.length, 'libro', 'libros');
  if (!books.length) {
    c.innerHTML = chips + '<div class="empty"><p>Ningún libro coincide.</p></div>';
    c.querySelectorAll('[data-book-view]').forEach(btn => { btn.onclick = () => { state.bookView = btn.dataset.bookView; renderBooks(); }; });
    return;
  }
  c.innerHTML = chips + books.map(b => {
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
        ${b.device_counts && b.device_counts.highlights > b.hl_count
          ? `<div class="b-lack" title="El Kindle tiene ${b.device_counts.highlights} subrayados de este libro; los que faltan se hicieron en otro aparato: tráelos con Importar → Nube de Amazon">El Kindle tiene ${b.device_counts.highlights}: faltan ${b.device_counts.highlights - b.hl_count}</div>` : ''}
        ${known ? (b.on_device ? '<div class="b-badge on">En el Kindle</div>' : missing(b) ? '<div class="b-badge off">No descargado</div>' : '') : ''}
      </div></div>`;
  }).join('');
  c.querySelectorAll('[data-book-view]').forEach(btn => { btn.onclick = () => { state.bookView = btn.dataset.bookView; renderBooks(); }; });
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

const isUltraMind = () => exportKind() === 'highlights' && $('#export-format').value === 'ultramind';

function currentExport() {
  const kind = exportKind();
  const items = kind === 'vocab' ? lib.filterVocab(currentFilters()) : lib.filterHighlights(currentFilters());
  const ex = { ...buildExport(kind, $('#export-format').value, items, getExportOptions()), count: items.length, kind };
  if (isUltraMind()) ex.maps = ultramindMaps(items);
  return ex;
}

function refreshPreview() {
  const ex = currentExport();
  if (ex.maps) {
    const first = ex.maps[0] ? ex.maps[0].content : '(nada que exportar con estos filtros)';
    const more = ex.maps.length - 1;
    $('#export-preview').textContent = first.slice(0, 2500) + (first.length > 2500 ? '\n…' : '') +
      (more > 0 ? `\n… y ${fmtNum(more)} mapa${more === 1 ? '' : 's'} más (uno por libro)` : '');
    $('#export-count').textContent = `· ${fmtNum(ex.maps.length)} mapa${ex.maps.length === 1 ? '' : 's'}`;
    $('#btn-do-export').textContent = ex.maps.length > 1 ? `Descargar ${fmtNum(ex.maps.length)} mapas` : 'Descargar archivo';
    return;
  }
  $('#btn-do-export').textContent = 'Descargar archivo';
  $('#export-preview').textContent = ex.content.slice(0, 2500) + (ex.content.length > 2500 ? '\n…' : '');
  $('#export-count').textContent = `· ${fmtNum(ex.count)} ${ex.kind === 'vocab' ? 'palabras' : 'elementos'}`;
}

function refreshFormatHints() {
  const kind = exportKind(), fmt = $('#export-format').value;
  const um = isUltraMind();
  $('#format-hint-ultramind').classList.toggle('hidden', !um);
  // El mapa lleva solo los subrayados: las opciones de datos no aplican.
  $('#row-presets').classList.toggle('hidden', um);
  $('#opt-structure').classList.toggle('hidden', um);
  $('#opt-highlights').classList.toggle('hidden', um || kind === 'vocab');
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
  const chosen = state.selectedWords.size > 0 && document.querySelector('input[name="vm-scope"]:checked').value === 'selected';
  $('#vm-scope').classList.toggle('hidden', !state.selectedWords.size);
  $('#vm-scope-selected').textContent = `Solo las ${fmtNum(state.selectedWords.size)} palabra${state.selectedWords.size === 1 ? '' : 's'} que he elegido`;
  $('#vm-include-sent-row').classList.toggle('hidden', chosen);
  $('#vm-hint').textContent = chosen
    ? 'Van exactamente las palabras que has elegido, cada una una sola vez. Al copiar un bloque, sus palabras quedan marcadas como «Enviada».'
    : 'Se usan los filtros de libro e idioma de la izquierda. No van las palabras marcadas como «Me la sé» ni «Ignorar», y cada palabra va una sola vez. Al copiar un bloque, sus palabras quedan marcadas como «Enviada» para no repetirlas la próxima vez.';
  const items = chosen
    ? lib.filterVocab({}).filter(v => state.selectedWords.has(v.wkey))
    : lib.filterVocab({ ...currentFilters(), statuses: null });
  vmBlocks = vocamasterBlocks(items, {
    baseForm: $('#vm-base-form').checked,
    includeSent: $('#vm-include-sent').checked,
    withContext: $('#vm-with-context').checked,
    explicit: chosen,
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
  const sel = document.querySelector('input[name="vm-scope"][value="selected"]');
  sel.checked = true;
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
  $('#btn-rescan').onclick = rescanKindle;
  $('#btn-rescan-dialog').onclick = rescanKindle;
  if (!folderAccessSupported) {
    $('#btn-pick-kindle').classList.add('hidden');
    $('#btn-pick-files').classList.replace('btn-ghost', 'btn-primary');
  }
  $('#btn-pick-files').onclick = () => $('#kindle-files').click();
  const bm = $('#amazon-bookmarklet');
  bm.href = amazonBookmarkletHref(location.origin + location.pathname);
  // Datos que el marcador pasa directamente desde el cuaderno de Amazon.
  const received = new Set();
  window.addEventListener('message', e => {
    if (!AMAZON_NOTEBOOK_ORIGIN.test(e.origin) || !e.data || e.data.type !== 'kindlevault-amazon') return;
    const data = e.data.data;
    if (!data || data.format !== 'kindlevault-amazon' || !Array.isArray(data.books)) return;
    try { e.source.postMessage({ type: 'kindlevault-amazon-ok' }, e.origin); } catch { /* la pestaña de Amazon ya no está */ }
    if (received.has(data.exportedAt)) return; // el marcador lo reenvía hasta recibir respuesta
    received.add(data.exportedAt);
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    processImport({ folderName: null, clippings: null, vocab: null, notebooks: [], syncFiles: [], fileNames: [`nube de Amazon (${e.origin})`], amazon: [{ name: 'nube de Amazon', bytes }] });
  });
  bm.addEventListener('click', e => { e.preventDefault(); toast('Arrástralo a la barra de marcadores; luego púlsalo en tu cuaderno de Amazon'); });
  // Soltar archivos en cualquier parte de la página.
  document.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', async e => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    // Una carpeta soltada (la del Kindle, o system/vocabulary copiada) se lee
    // como el Kindle, con vocab.db-wal incluido. Hay que pedir los manejadores
    // antes de esperar nada: después el navegador ya no los da.
    const files = [...e.dataTransfer.files];
    const pending = [...e.dataTransfer.items]
      .filter(i => i.kind === 'file' && typeof i.getAsFileSystemHandle === 'function')
      .map(i => i.getAsFileSystemHandle().catch(() => null));
    const handles = (await Promise.all(pending)).filter(Boolean);
    const dir = handles.find(h => h.kind === 'directory');
    if (!dir) { processImport(await readKindleFiles(files)); return; }
    // Carpeta y archivos sueltos a la vez (p. ej. vocabulary y My Clippings.txt).
    const r = await readKindleFolder(dir);
    const loose = await readKindleFiles(await Promise.all(handles.filter(h => h.kind === 'file').map(h => h.getFile())));
    r.clippings = r.clippings || loose.clippings;
    r.vocab = r.vocab || loose.vocab;
    for (const k of ['notebooks', 'amazon', 'syncFiles']) r[k] = loose[k];
    processImport(r);
  });
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
  $('#vm-with-context').onchange = renderVocaMaster;
  $$('input[name="vm-scope"]').forEach(r => { r.onchange = renderVocaMaster; });
  $('#selection-bar').addEventListener('click', e => {
    const btn = e.target.closest('[data-sel-act]');
    if (btn) selectionAction(btn.dataset.selAct);
  });
  $('#results').addEventListener('click', e => {
    const cb = e.target.closest('.v-cb');
    if (cb) toggleWordCheckbox(cb, e.shiftKey);
    const sp = e.target.closest('[data-speak]');
    if (sp) speakFromCard(sp);
    const tr = e.target.closest('[data-translate]');
    if (tr) translateFromCard(tr);
  });
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
  $('#btn-do-export').onclick = async () => {
    const ex = currentExport();
    if (ex.maps) {
      if (!ex.maps.length) { toast('No hay subrayados que exportar con estos filtros'); return; }
      // Un archivo por libro. Chrome puede preguntar una vez si permites varias descargas.
      for (const [i, m] of ex.maps.entries()) {
        download(new Blob([m.content], { type: 'text/markdown;charset=utf-8' }), m.filename);
        if (i < ex.maps.length - 1) await new Promise(r => setTimeout(r, 400));
      }
      toast(ex.maps.length === 1 ? `Descargado: ${ex.maps[0].filename}` : `✓ Descargados ${fmtNum(ex.maps.length)} mapas, uno por libro`);
      return;
    }
    download(new Blob([ex.content], { type: ex.mime }), ex.filename);
    toast(`Descargado: ${ex.filename}`);
  };
  $('#btn-copy-export').onclick = async () => {
    const ex = currentExport();
    if (ex.maps && ex.maps.length > 1) {
      toast('Para copiar un mapa, filtra un solo libro a la izquierda (o usa «Descargar»: un archivo por libro)');
      return;
    }
    try { await navigator.clipboard.writeText(ex.maps ? (ex.maps[0] ? ex.maps[0].content : '') : ex.content); toast('✓ Copiado al portapapeles'); }
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
  renderRescanButtons();
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
