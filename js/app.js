import { Library, wordKey as wordKeyOf } from './store.js';
import { parseClippings, readVocabDbDetailed, isKindleMateDb, readKindleMateDb } from './parser.js';
import { parseNotebookHtml, parseAmazonExport } from './notebook.js';
import { SyncManager, crearCerrojo } from './sync.js';
import { NubeSync } from './nubesync.js';
import { formatearCodigo, limpiarCodigo, codigoValido, LARGO_CODIGO, queEquipo } from './nube.js';
import { pickKindleFolder, readKindleFiles, readKindleFolder, folderAccessSupported, rescanSavedKindle, hasSavedKindle } from './kindle.js';
import { findCover } from './covers.js';
import { buildExport, PRESETS, DEFAULT_OPTIONS, vocamasterBlocks, vocamasterItems, ultramindMaps } from './export.js';
import { speak, speechSupported } from './speech.js';
import { translate, googleTranslateUrl, needsTranslation, builtInTranslator, SAME_LANGUAGE } from './translate.js';
import { amazonBookmarkletHref, AMAZON_NOTEBOOK_ORIGIN } from './amazon.js';
import { icon, hydrateIcons } from './icons.js';
import { coverHtml, generatedCover, coverColors, shortTitle, displayAuthor } from './bookcover.js';

const $ = sel => document.querySelector(sel);
/** En el móvil (no se puede conectar el Kindle; lo normal es traer los datos del ordenador con un código). */
const enMovil = queEquipo() === 'el móvil';
/** Pantalla táctil (sin ratón): sin Mayús+clic ni botones que aparezcan al pasar el ratón. */
const tactil = () => matchMedia('(pointer: coarse)').matches;
const $$ = sel => Array.from(document.querySelectorAll(sel));

const state = {
  tab: 'home',
  prevTab: 'books',         // de dónde se vino a la página de un libro
  bookKey: null,            // libro abierto (vista «book»)
  bookTab: 'highlights',    // pestaña de la página del libro: highlights | vocab
  flash: null,              // subrayado que se resalta al abrir el libro (desde el buscador)
  sort: { highlights: 'book', vocab: 'recent', books: 'title' },
  dailyOffset: 0,           // «Otro» en el subrayado del día
  selectedBooks: new Set(),
  selectedLangs: new Set(),
  selectedTypes: new Set(['highlight', 'note', 'bookmark']),
  // Se ven todas salvo las que tú ignoras (al enviar a VocaMaster ya se saltan las que te sabes).
  selectedStatuses: new Set(['new', 'sent', 'known']),
  selectedWords: new Set(), // wordKey de las palabras elegidas con su casilla
  repeatedOnly: false,      // Vocabulario: solo las que se te resisten (buscadas 2+ veces)
  wordKey: null,            // Vocabulario: todas las búsquedas de una palabra (desde el Historial)
  lastChecked: null,
  bookView: 'all',          // Biblioteca: all | device | missing | hl | words
  search: '',
  results: [],
};

let lib;
let sync;
let nube; // sincronización con un código (móvil y ordenador)
/** Lo que se ve en el apartado «Con un código» del diálogo. */
const nubeUI = { form: false, ver: false, ocupado: false, texto: '', foco: false };

// ============================================================
//  Utilidades
// ============================================================
const esc = s => (s === null || s === undefined ? '' : String(s)).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = n => n.toLocaleString('es-ES');
const fold = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
let canRescan = false; // ¿se puede volver a leer el Kindle de la última vez?
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
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4200);
}

/**
 * Aviso arriba de la lista: título, cifras clave (chips) y, si el mensaje es
 * largo, las primeras líneas con el resto plegado en «Ver detalles».
 */
function showBanner({ title, message, failures, actions = [], kind = 'warning', chips = [] }) {
  const b = $('#banner');
  b.className = `notice ${kind}`;
  const lines = String(message || '').split('\n').filter(Boolean);
  const head = lines.slice(0, chips.length ? 1 : 2), rest = lines.slice(head.length);
  let html = `<div class="notice-icon">${icon(kind === 'success' ? 'check' : kind === 'error' ? 'alert' : 'info')}</div><div class="notice-body">`;
  html += `<h3>${esc(title)}</h3>`;
  if (chips.length) html += `<div class="notice-chips">${chips.map(c => `<span class="stat-chip">${c}</span>`).join('')}</div>`;
  if (head.length) html += `<div class="notice-msg">${esc(head.join('\n'))}</div>`;
  if (rest.length || (failures && failures.length)) {
    html += `<details class="notice-more"><summary>Ver detalles</summary><div class="notice-msg">${esc(rest.join('\n'))}</div>`;
    (failures || []).forEach(f => {
      html += `<div class="notice-fail"><strong>Bloque #${f.block_index}</strong> — ${esc(f.reason)}</div>`;
      if (f.first_lines) html += `<pre>${esc(f.first_lines)}</pre>`;
    });
    html += '</details>';
  }
  if (actions.length) {
    html += '<div class="notice-actions">' +
      actions.map((a, i) => `<button class="btn btn-sm ${i === 0 && kind !== 'success' ? 'btn-primary' : ''}" data-banner-action="${i}">${esc(a.label)}</button>`).join('') +
      '</div>';
  }
  html += `</div><button class="icon-btn notice-close" data-banner-close aria-label="Cerrar">${icon('x')}</button>`;
  b.innerHTML = html;
  b.querySelector('[data-banner-close]').onclick = hideBanner;
  b.querySelectorAll('[data-banner-action]').forEach(btn => {
    btn.onclick = () => actions[+btn.dataset.bannerAction].run();
  });
}
function hideBanner() { $('#banner').className = 'notice hidden'; }

function openDialog(id) { $(`#${id}`).classList.remove('hidden'); }
function closeDialog(id) { $(`#${id}`).classList.add('hidden'); }

// ============================================================
//  Cabecera y sincronización
// ============================================================
function renderStats() {
  const s = lib.stats();
  $('#stats-line').textContent = s.books || s.vocab
    ? `${fmtNum(s.books)} libros · ${fmtNum(s.highlights)} subrayados`
    : 'Tu biblioteca del Kindle';
  const counts = { books: s.books, highlights: s.highlights, vocab: s.vocab };
  $$('[data-count]').forEach(el => { const n = counts[el.dataset.count]; el.textContent = n ? fmtNum(n) : ''; });
}

/** Estado de las dos sincronizaciones (archivo y código), en una sola píldora. */
function syncOverall() {
  const f = sync.state, c = nube.state;
  if (f === 'syncing' || c === 'syncing') return ['Sincronizando…', 'busy'];
  // Sin red no es un fallo: se reintenta solo en cuanto vuelve.
  const sinRed = c === 'error' && /Sin conexión/.test(nube.error || '');
  if (f === 'error' || (c === 'error' && !sinRed)) return ['Error de sincronización', 'failed'];
  if (f === 'needs-permission') return ['Pulsa para sincronizar', 'attention'];
  if (sinRed) return ['Sin conexión', 'attention'];
  const ultima = Math.max(c === 'ok' ? nube.lastSync || 0 : 0, f === 'ok' && sync.meta.lastSync ? Date.parse(sync.meta.lastSync) : 0);
  if (ultima) return [`Sincronizado · ${fmtWhen(ultima)}`, 'connected'];
  return ['Sin sincronizar', ''];
}

function renderSyncPill() {
  if (!sync || !nube) return;
  const p = $('#sync-pill');
  const [label, cls] = syncOverall();
  p.textContent = label;
  p.className = 'status-pill sync-pill ' + cls;
  if (!$('#sync-dialog').classList.contains('hidden')) renderSyncDialog();
  if (state.tab === 'home' && lib && (lib.books.size || lib.vocab.size)) { const y = $('#results').scrollTop; renderHome(); $('#results').scrollTop = y; }
}

async function syncInteractive() {
  hideBanner();
  const r = await sync.syncNow({ interactive: true });
  if (r.ok) toast(r.changedHere ? '✓ Sincronizado: datos de tu otro equipo cargados' : '✓ Sincronizado');
  else if (r.error) showBanner({ title: 'No se pudo sincronizar', message: r.error, kind: 'error' });
}

/** Abre el diálogo de sincronización (con el campo del código a la vista, si se pide). */
function openSyncDialog({ codigo = false } = {}) {
  if (codigo && !nube.codigo) { nubeUI.form = true; nubeUI.foco = true; }
  renderSyncDialog();
  openDialog('sync-dialog');
}

/** «hoy a las 10:32», «el 3 de noviembre a las 10:32». */
function cuandoLargo(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const hora = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `hoy a las ${hora}` : `el ${d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })} a las ${hora}`;
}

const fmtBytes = n => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

function nubeSectionHtml() {
  const st = nube.state;
  let h = `<section class="sync-sec">
    <div class="sync-sec-head"><span class="sync-sec-icon">${icon('phone')}</span><div><h3>Con un código</h3><p>Entre el móvil y el ordenador (o varios equipos). Sirve en cualquier navegador.</p></div></div>`;
  if (!nube.codigo) {
    if (nubeUI.form) {
      h += `<form id="nube-form" class="code-form" autocomplete="off">
        <label for="nube-codigo">El código de tu otro equipo (${LARGO_CODIGO} cifras)</label>
        <div class="code-row">
          <input id="nube-codigo" class="code-input" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="1234 5678 9012 3456" maxlength="24">
          <button class="btn btn-primary" type="submit" id="nube-vincular" disabled>${nubeUI.ocupado ? 'Vinculando…' : 'Vincular'}</button>
        </div>
        <p class="hint" id="nube-cifras">Se juntan los datos de los dos equipos: no se borra nada de ninguno.</p>
        <button type="button" class="link-btn" data-act="nube-cancelar">Cancelar</button>
      </form>`;
    } else {
      h += `<p class="sync-lead">En un equipo pulsa <strong>Crear código</strong>; en el otro, <strong>Tengo un código</strong> y escríbelo una vez. Desde entonces se sincronizan solos.</p>
      <div class="dialog-actions-row">
        <button class="btn btn-primary" data-act="nube-crear"${nubeUI.ocupado ? ' disabled' : ''}>${icon('sparkle')}${nubeUI.ocupado ? 'Creando…' : 'Crear código'}</button>
        <button class="btn" data-act="nube-tengo"${nubeUI.ocupado ? ' disabled' : ''}>${icon('link')}Tengo un código</button>
      </div>`;
    }
  } else {
    const estado = {
      syncing: 'Sincronizando…',
      ok: `Vinculado · última vez ${esc(cuandoLargo(nube.lastSync))}`,
      error: esc(nube.error || 'No se pudo sincronizar'),
    }[st] || 'Vinculado';
    const sinRed = st === 'error' && /Sin conexión/.test(nube.error || '');
    h += `<div class="sync-state ${sinRed ? 'offline' : st}"><span class="sync-dot"></span><span>${estado}</span></div>`;
    if (nube.tamano && nube.tamano.piezas) {
      h += `<p class="hint">En la nube: ${fmtBytes(nube.tamano.bytes)}, cifrados y comprimidos, en ${fmtNum(nube.tamano.piezas)} piezas.</p>`;
    }
    if (nubeUI.ver) {
      h += `<div class="code-box">
          <output class="code-digits" aria-label="Tu código">${formatearCodigo(nube.codigo)}</output>
          <button class="btn btn-sm" data-act="nube-copiar">${icon('copy')}Copiar</button>
        </div>
        <p class="hint">Escríbelo una vez en tu otro equipo: <em>Sincronización → Con un código → Tengo un código</em>. Guárdalo como una contraseña: con él se pueden leer tus datos.</p>`;
    }
    h += `<div class="dialog-actions-row">
        <button class="btn btn-primary" data-act="nube-sync"${st === 'syncing' ? ' disabled' : ''}>${icon('refresh')}Sincronizar ahora</button>
        <button class="btn" data-act="nube-ver">${icon('eye')}${nubeUI.ver ? 'Ocultar el código' : 'Ver el código'}</button>
        <button class="btn btn-ghost" data-act="nube-desvincular">${icon('unlink')}Desvincular</button>
      </div>`;
  }
  h += `<details class="sync-how"><summary>Cómo funciona</summary>
      <p>${icon('lock')}Tus datos se cifran con el código antes de salir de este equipo y esperan en una base de datos de Firebase (la misma que usan UltraMind y RepArena), que solo ve algo ilegible y no deja listar nada. Sin el código nadie puede encontrarlos ni leerlos.</p>
      <p>Para ocupar poco, van comprimidos y repartidos en piezas: al cambiar algo solo se sube la pieza de ese libro (o la de las marcas de las palabras), y el otro equipo solo baja lo que ha cambiado. Las piezas viejas se borran solas.</p>
      <p>Cada equipo sube sus cambios a los pocos segundos y trae los del otro al abrir KindleVault, al volver a la página y cada pocos minutos. No se pierde nada: lo de los dos se junta. En el ordenador puedes usar a la vez el código y el archivo de sincronización.</p>
    </details>
  </section>`;
  return h;
}

function fileSectionHtml() {
  const st = sync.state;
  const head = `<div class="sync-sec-head"><span class="sync-sec-icon">${icon('laptop')}</span><div><h3>Con un archivo</h3><p>Entre ordenadores, en una carpeta que se sincronice sola (OneDrive, Dropbox…).</p></div></div>`;
  // En el móvil es cosa de ordenadores: plegado, salvo que ya se use.
  let h = enMovil && !sync.handle
    ? `<section class="sync-sec"><details class="sync-fold"><summary>${head}</summary>`
    : `<section class="sync-sec">${head}`;
  if (st === 'unsupported') {
    h += `<p class="hint">Este navegador no deja que una web use un archivo de tu equipo (solo Chrome y Edge de ordenador). Aquí, usa el código.</p>
      <div class="dialog-actions-row"><button class="btn btn-ghost" data-act="open-readonly">${icon('file')}Abrir una copia del archivo (solo lectura)</button></div>`;
  } else if (!sync.handle) {
    h += `<p class="hint">En el primer ordenador, crea el archivo; en los demás, vincula ese mismo archivo.</p>
      <div class="dialog-actions-row">
        <button class="btn" data-act="create">${icon('plus')}Crear archivo…</button>
        <button class="btn btn-ghost" data-act="link">${icon('link')}Vincular un archivo…</button>
      </div>`;
  } else {
    const stateText = {
      ok: `Sincronizado por última vez: <strong>${esc(fmtWhen(sync.meta.lastSync))}</strong>.`,
      'needs-permission': 'El navegador necesita tu permiso para usar el archivo en esta sesión (es una medida de seguridad de Chrome).',
      syncing: 'Sincronizando…',
      error: `<span class="text-danger">${esc(sync.error)}</span>`,
    }[st] || '';
    h += `<div class="sync-file"><div class="sync-file-name">${esc(sync.meta.name || sync.handle.name)}</div><div class="hint">${stateText}</div></div>
      <p class="hint">Se sincroniza solo al abrir la web, al volver a ella y después de cada cambio. El navegador solo nos deja ver el nombre del archivo, no su carpeta.</p>
      <div class="dialog-actions-row">
        <button class="btn" data-act="sync">${icon('refresh')}Sincronizar ahora</button>
        <button class="btn btn-ghost" data-act="link">Vincular otro archivo…</button>
        <button class="btn btn-ghost" data-act="unlink">Dejar de usarlo</button>
      </div>`;
  }
  return h + (enMovil && !sync.handle ? '</details>' : '') + '</section>';
}

function renderSyncDialog() {
  const body = $('#sync-body');
  const prev = $('#nube-codigo');
  const tenia = prev && document.activeElement === prev;
  if (prev) nubeUI.texto = prev.value;
  body.innerHTML = nubeSectionHtml() + fileSectionHtml() + `<details class="sync-more"><summary>Más opciones</summary>
      <div class="dialog-actions-col">
        <button class="btn btn-ghost" data-act="backup">${icon('import')}Descargar una copia de mis datos</button>
        <button class="btn btn-ghost danger" data-act="wipe">Borrar los datos de este navegador</button>
      </div></details>`;
  body.querySelectorAll('[data-act]').forEach(btn => { btn.onclick = () => syncAction(btn.dataset.act); });
  const form = $('#nube-form');
  if (form) {
    const input = $('#nube-codigo');
    input.value = nubeUI.texto;
    const pintar = () => {
      const n = limpiarCodigo(input.value).length;
      $('#nube-vincular').disabled = nubeUI.ocupado || n !== LARGO_CODIGO;
      $('#nube-cifras').textContent = n && n !== LARGO_CODIGO
        ? `Llevas ${n} de ${LARGO_CODIGO} cifras.`
        : 'Se juntan los datos de los dos equipos: no se borra nada de ninguno.';
    };
    input.oninput = () => {
      input.value = formatearCodigo(input.value).slice(0, LARGO_CODIGO + 3);
      nubeUI.texto = input.value;
      pintar();
    };
    form.onsubmit = e => { e.preventDefault(); syncAction('nube-vincular'); };
    pintar();
    if (nubeUI.foco || tenia) {
      nubeUI.foco = false;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

async function nubeAction(act) {
  if (act === 'nube-tengo') { nubeUI.form = true; nubeUI.foco = true; nubeUI.texto = ''; }
  else if (act === 'nube-cancelar') { nubeUI.form = false; nubeUI.texto = ''; }
  else if (act === 'nube-ver') nubeUI.ver = !nubeUI.ver;
  else if (act === 'nube-copiar') copyText(formatearCodigo(nube.codigo), '✓ Código copiado');
  else if (act === 'nube-sync') {
    const r = await nube.syncNow();
    if (r.ok) toast(r.trajo ? '✓ Sincronizado: cambios de tu otro equipo cargados' : '✓ Sincronizado');
  } else if (act === 'nube-crear') {
    nubeUI.ocupado = true;
    renderSyncDialog();
    const r = await nube.crear();
    nubeUI.ocupado = false;
    if (r.ok) { nubeUI.ver = true; toast('Código creado: escríbelo en tu otro equipo'); }
    else showBanner({ title: 'No se pudo crear el código', message: r.mensaje || 'Inténtalo de nuevo con conexión.', kind: 'error' });
  } else if (act === 'nube-vincular') {
    const texto = nubeUI.texto || ($('#nube-codigo') || {}).value || '';
    if (!codigoValido(texto)) return;
    nubeUI.ocupado = true;
    renderSyncDialog();
    const r = await nube.vincular(texto);
    nubeUI.ocupado = false;
    if (r.ok) {
      nubeUI.form = false; nubeUI.texto = '';
      toast(r.trajo ? '✓ Vinculado: tus datos ya están aquí' : '✓ Equipo vinculado');
    } else {
      showBanner({ title: 'No se pudo vincular', message: r.mensaje || 'Comprueba el código y la conexión.', kind: 'error' });
    }
  } else if (act === 'nube-desvincular') {
    if (!confirm('Este equipo dejará de sincronizarse con el código. Tus datos se quedan aquí y lo de la nube sigue ahí: para volver, escribe el mismo código (lo ves en tu otro equipo, en «Ver el código»).')) return;
    nubeUI.ver = false;
    await nube.desvincular();
    toast('Este equipo ya no se sincroniza con el código');
  }
}

async function syncAction(act) {
  try {
    if (act.startsWith('nube-')) await nubeAction(act);
    else if (act === 'create') { await sync.create(); toast('✓ Archivo creado y sincronizado'); }
    else if (act === 'link') {
      const r = await sync.link();
      if (r.ok) toast(r.changedHere ? '✓ Archivo vinculado: datos cargados' : '✓ Archivo vinculado');
    }
    else if (act === 'sync') await syncInteractive();
    else if (act === 'unlink') { await sync.unlink(); toast('Este navegador ya no usa el archivo de sincronización'); }
    else if (act === 'open-readonly') $('#sync-readonly-file').click();
    else if (act === 'backup') {
      const blob = new Blob([JSON.stringify(lib.toJSON())], { type: 'application/json' });
      download(blob, `kindlevault-copia-${new Date().toISOString().slice(0, 10)}.json`);
    } else if (act === 'wipe') {
      if (!confirm('Se borrarán los libros, subrayados y vocabulario guardados en este navegador. Tu Kindle, tu archivo de sincronización y lo que hay en la nube con tu código no se tocan (si este equipo sigue sincronizado, tus datos volverán). ¿Continuar?')) return;
      lib.clear();
      await lib.save();
      await nube.olvidar();
      refreshAll();
      toast('Datos de este navegador borrados');
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return; // el usuario cerró el selector
    showBanner({ title: 'No se pudo completar', message: e.message || String(e), kind: 'error' });
  }
  renderSyncDialog();
}

/** Tras un cambio aquí: al archivo y a la nube, cada uno con su espera. */
function syncSoon() {
  sync.schedule();
  nube.schedule();
}

/**
 * Lo que traiga una sincronización, a la vista sin perder el sitio: si se está
 * leyendo una lista larga, se repinta al cambiar de vista (las cifras, ya).
 */
let refreshPending = false;
function refreshSoft() {
  renderStats();
  const r = $('#results');
  if (['highlights', 'vocab', 'book'].includes(state.tab) && r.scrollTop > 400) { refreshPending = true; return; }
  const y = r.scrollTop;
  renderChrome();
  reload();
  r.scrollTop = y;
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
  if (info.mate) {
    const m = info.mate;
    out.push(`Kindle Mate: ${r.vocab.db.name}, ${r.vocab.db.bytes.byteLength} bytes · ${m.lookups} búsquedas de ${m.books} libros (${m.added} nuevas) · ${m.words} palabras, ${m.lone} sin búsqueda · desfase horario: ${m.offset == null ? 'hora local' : `${m.offset / 3600000} h`}`);
  } else if (r.vocab) {
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
      out.push(`Palabras de WORDS sin ninguna búsqueda en LOOKUPS: ${st.lone.length}`);
      out.push('Palabras más recientes en WORDS (¿con búsqueda?):', ...st.latestWords.map(w => `  · ${w.at || '(sin fecha)'} — ${w.word} — ${w.lookup ? 'sí' : 'no'}`));
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
  if (r.databases) out.push(`Bases de datos en el Kindle fuera de documents (${r.databases.length}):`, ...r.databases.map(d => `  · ${d}`));
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
  const before = lib.stats();
  const lines = [];
  const actions = [{ label: 'Copiar informe detallado', run: copyReport }];
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
  if (r.vocab && isKindleMateDb(r.vocab.db.bytes)) {
    // Copia de Kindle Mate: guarda también las búsquedas que el Kindle ya borró.
    try {
      const mate = readKindleMateDb(r.vocab.db.bytes);
      const offset = lib.resolveNaiveTimes([...mate.entries, ...mate.lone]);
      const added = lib.importVocab(mate.entries);
      const books = new Set(mate.entries.map(e => e.book_title).filter(Boolean)).size;
      info.mate = { lookups: mate.entries.length, words: mate.words, lone: mate.lone.length, added, books, offset };
      lines.push(`Kindle Mate (${r.vocab.db.name}): ${fmtNum(mate.entries.length)} búsquedas con su frase, de ${fmtNum(books)} libros. ${fmtNum(added)} nuevas; las demás ya estaban y no se repiten. Cada una va a su libro de la Biblioteca.`);
      const lone = mate.lone.filter(v => !lib.vocab.has(v.key));
      if (lone.length) {
        pendingLoneWords = lone;
        lines.push(`Además, Kindle Mate guarda ${fmtNum(lone.length)} palabras sin frase ni libro. Puedes añadirlas con el botón de abajo.`);
        actions.push({ label: `Añadir también esas ${fmtNum(lone.length)} palabras`, run: importLoneWords });
      }
    } catch (e) {
      lines.push(`No se pudo leer la base de Kindle Mate: ${e.message}`);
      kind = 'warning';
    }
  } else if (r.vocab) {
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
      // Palabras sin frase ni libro: solo si se piden (pueden ser miles de búsquedas antiguas).
      const lone = res.stats.lone.filter(v => !lib.vocab.has(v.key));
      if (lone.length) {
        pendingLoneWords = lone;
        lines.push(`Además, vocab.db guarda ${fmtNum(lone.length)} palabra${lone.length === 1 ? '' : 's'} buscada${lone.length === 1 ? '' : 's'} sin su frase ni su libro: el Kindle ya no conserva el detalle de esas búsquedas. Puedes añadirlas con el botón de abajo.`);
        actions.push({ label: `Añadir también esas ${fmtNum(lone.length)} palabras`, run: importLoneWords });
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
  const delta = (n, one, many) => `<strong>${n > 0 ? '+' : ''}${fmtNum(n)}</strong> ${n === 1 || n === -1 ? one : many}`;
  const chips = [
    delta(s.highlights - before.highlights, 'subrayado', 'subrayados'),
    delta(s.vocab - before.vocab, 'palabra', 'palabras'),
    `<strong>${fmtNum(s.books)}</strong> libros en total`,
  ];
  if (inv) chips.push(`<strong>${fmtNum(inv.books)}</strong> en el Kindle`);
  showBanner({
    title: rescan ? 'Kindle escaneado de nuevo' : 'Importación completada', message: lines.join('\n'), failures: diag && diag.failures, kind,
    actions, chips,
  });
  syncSoon();
  fetchCovers();
}

let pendingLoneWords = null;
async function importLoneWords() {
  if (!pendingLoneWords) return;
  const added = lib.importVocab(pendingLoneWords);
  pendingLoneWords = null;
  await lib.save();
  refreshAll();
  syncSoon();
  showBanner({ title: 'Palabras añadidas', message: `${fmtNum(added)} palabras sin frase ni libro añadidas al vocabulario. Las verás sin libro en la lista.`, kind: 'success' });
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
  const changed = show !== canRescan;
  canRescan = show;
  $('#btn-rescan').classList.toggle('hidden', !show);
  $('#btn-rescan-dialog').classList.toggle('hidden', !show);
  if (changed && state.tab === 'home' && (lib.books.size || lib.vocab.size)) renderHome();
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
      else if (state.tab === 'home') { const y = $('#results').scrollTop; renderHome(); $('#results').scrollTop = y; }
      await new Promise(r => setTimeout(r, 250));
    }
  } finally {
    coversRunning = false;
    if (changed) { await lib.save(); syncSoon(); }
  }
}

// ============================================================
//  Navegación
// ============================================================
const VIEW_TITLES = { home: 'Inicio', books: 'Biblioteca', highlights: 'Subrayados', vocab: 'Vocabulario', history: 'Historial' };
const isWordList = () => state.tab === 'vocab' || (state.tab === 'book' && state.bookTab === 'vocab');
const isHighlightList = () => state.tab === 'highlights' || (state.tab === 'book' && state.bookTab === 'highlights');

function setTab(tab) {
  if (tab !== 'book' && state.tab !== tab) { setSearch(''); state.wordKey = state.tab === 'vocab' ? null : state.wordKey; }
  state.tab = tab;
  closePopover();
  $('#rail').classList.remove('open');
  renderChrome();
  reload();
  $('#results').scrollTop = 0;
}

/** Abre la página de un libro (desde la Biblioteca, el Inicio, el buscador…). */
function openBook(key, bookTab = 'highlights', { flash = null } = {}) {
  if (!lib.books.has(key)) return;
  if (state.tab !== 'book') state.prevTab = state.tab;
  state.bookKey = key;
  state.bookTab = bookTab;
  state.flash = flash;
  setSearch('');
  state.selectedWords.clear();
  setTab('book');
}

/** Cabecera, menú y barra de filtros según la vista. */
function renderChrome() {
  const tab = state.tab;
  const navTab = tab === 'book' ? 'books' : tab;
  $$('.nav-item, .tabbar-item').forEach(b => b.classList.toggle('active', b.dataset.tab === navTab));
  const book = tab === 'book' ? lib.books.get(state.bookKey) : null;
  $('#view-title').textContent = book ? shortTitle(book.title) : VIEW_TITLES[tab] || '';
  $('#btn-back').classList.toggle('hidden', tab !== 'book');
  $('#back-label').textContent = VIEW_TITLES[state.prevTab] || 'Biblioteca';
  const hasData = lib.books.size || lib.vocab.size;
  $('#toolbar').classList.toggle('hidden', !hasData || !['highlights', 'vocab', 'books'].includes(tab));
  $('#btn-export').classList.toggle('hidden', !hasData || !['highlights', 'vocab'].includes(tab));
  $('#btn-vocamaster').classList.toggle('hidden', !hasData || tab !== 'vocab');
  $('#search').placeholder = { highlights: 'Buscar en los subrayados…', vocab: 'Buscar palabras o frases…', books: 'Buscar por título o autor…' }[tab] || 'Buscar…';
  renderToolbar();
  renderSelectionBar();
}

function refreshAll() {
  renderStats();
  renderChrome();
  reload();
}

function reload() {
  refreshPending = false;
  renderActiveFilters();
  if (!lib.books.size && !lib.vocab.size) { renderWelcome(); return; }
  const t = state.tab;
  if (t === 'home') renderHome();
  else if (t === 'books') renderBooks();
  else if (t === 'book') renderBook();
  else if (t === 'history') renderHistory();
  else if (t === 'highlights') { freshList(); state.results = sortHighlights(lib.filterHighlights(currentFilters())); renderHighlights(); }
  else { freshList(); state.results = sortVocab(lib.filterVocab(currentFilters())); renderVocab(); }
}

function setCount(n, one, many) {
  $('#result-count').textContent = `${fmtNum(n)} ${n === 1 ? one : many}`;
}

function currentFilters() {
  if (state.tab === 'book') {
    return {
      bookKeys: new Set([state.bookKey]), languages: null, types: state.selectedTypes,
      statuses: state.selectedStatuses, repeated: false, wordKey: null, search: state.search,
    };
  }
  return {
    bookKeys: state.selectedBooks,
    languages: state.selectedLangs,
    types: state.selectedTypes,
    statuses: state.selectedStatuses,
    repeated: state.tab === 'vocab' && state.repeatedOnly,
    wordKey: state.tab === 'vocab' ? state.wordKey : null,
    search: state.search,
  };
}

// ----- Orden -----
const SORTS = {
  highlights: [['book', 'Por libro'], ['recent', 'Más recientes'], ['oldest', 'Más antiguos']],
  vocab: [['recent', 'Más recientes'], ['az', 'De la A a la Z'], ['times', 'Más buscadas']],
  books: [['title', 'Título'], ['author', 'Autor'], ['recent', 'Leídos hace poco'], ['highlights', 'Más subrayados'], ['words', 'Más palabras']],
};
const dateOf = h => h.highlighted_at || '';
function sortHighlights(list) {
  const s = state.sort.highlights;
  if (s === 'recent') return list.sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
  if (s === 'oldest') return list.sort((a, b) => (dateOf(a) || '9').localeCompare(dateOf(b) || '9'));
  return list;
}
function sortVocab(list) {
  if (state.repeatedOnly || state.wordKey) return list; // ya vienen agrupadas por palabra
  const s = state.sort.vocab;
  if (s === 'az') return list.sort((a, b) => a.word.localeCompare(b.word, 'es', { sensitivity: 'base' }));
  if (s === 'times') return list.sort((a, b) => b.times - a.times || a.wkey.localeCompare(b.wkey) || (b.looked_up_at || '').localeCompare(a.looked_up_at || ''));
  return list;
}

// ============================================================
//  Barra de filtros
// ============================================================
const TYPE_LABELS = { highlight: 'Subrayados', note: 'Notas', bookmark: 'Marcadores', empty: 'Sin texto', dropped: 'Bloqueados', superseded: 'Versiones anteriores' };
const DEFAULT_TYPES = ['highlight', 'note', 'bookmark'];
const DEFAULT_STATUSES = ['new', 'sent', 'known'];
const sameSet = (set, arr) => set.size === arr.length && arr.every(x => set.has(x));

function chip(id, label, { on = false, count = '', iconName = null, toggle = false } = {}) {
  return `<button class="chip${on ? ' on' : ''}${toggle ? ' toggle' : ''}" data-chip="${id}">${iconName ? icon(iconName) : ''}<span>${esc(label)}</span>${count !== '' ? `<span class="chip-count">${esc(count)}</span>` : ''}${toggle ? '' : icon('down')}</button>`;
}

function renderToolbar() {
  const t = state.tab;
  const f = $('#filters');
  if (!['highlights', 'vocab', 'books'].includes(t)) { f.innerHTML = ''; return; }
  const parts = [];
  if (t === 'books') {
    const known = !!lib.device;
    const views = [['all', 'Todos'], ...(known ? [['device', 'En el Kindle'], ['missing', 'No descargados']] : []), ['hl', 'Con subrayados'], ['words', 'Con palabras']];
    parts.push(views.map(([v, l]) => `<button class="chip${state.bookView === v ? ' on' : ''}" data-book-view="${v}">${esc(l)}</button>`).join(''));
    parts.push(chip('lang', state.selectedLangs.size ? `Idioma: ${[...state.selectedLangs].map(langName).join(', ')}` : 'Idioma', { on: state.selectedLangs.size > 0 }));
  } else {
    const nb = state.selectedBooks.size;
    const bookLabel = nb === 1 ? `Libro: ${shortTitle((lib.books.get([...state.selectedBooks][0]) || {}).title || '?')}` : nb ? `${fmtNum(nb)} libros` : 'Libro';
    parts.push(chip('book', bookLabel.length > 34 ? bookLabel.slice(0, 33) + '…' : bookLabel, { on: nb > 0, iconName: 'library' }));
    parts.push(chip('lang', state.selectedLangs.size ? [...state.selectedLangs].map(langName).join(', ') : 'Idioma', { on: state.selectedLangs.size > 0 }));
    if (t === 'highlights') {
      const def = sameSet(state.selectedTypes, DEFAULT_TYPES);
      parts.push(chip('type', def ? 'Tipo' : [...state.selectedTypes].map(x => TYPE_LABELS[x]).join(', '), { on: !def }));
    } else {
      const def = sameSet(state.selectedStatuses, DEFAULT_STATUSES);
      parts.push(chip('status', def ? 'Estado' : [...state.selectedStatuses].map(x => STATUS_LABELS[x]).join(', '), { on: !def }));
      parts.push(chip('repeated', 'Se te resisten', { on: state.repeatedOnly, count: fmtNum(lib.repeatedWordCount()), iconName: 'trending', toggle: true }));
    }
  }
  f.innerHTML = parts.join('');
  const sel = $('#sort');
  const opts = SORTS[t];
  const cur = state.sort[t];
  sel.innerHTML = opts.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('');
  sel.closest('.sort-wrap').classList.toggle('hidden', t === 'vocab' && (state.repeatedOnly || !!state.wordKey));
}

// ----- Desplegables -----
let popoverFor = null;
function closePopover() { $('#popover').classList.add('hidden'); popoverFor = null; }
function openPopover(anchor, id, html, bind) {
  const pop = $('#popover');
  if (popoverFor === id && !pop.classList.contains('hidden')) { closePopover(); return; }
  popoverFor = id;
  pop.innerHTML = html;
  pop.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 120)}px`;
  pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`;
  bind(pop);
}

function checkList(items, selected) {
  return items.map(it => `<label class="pop-item" title="${esc(it.title || it.label)}">
      <input type="checkbox" value="${esc(it.value)}"${selected.has(it.value) ? ' checked' : ''}>
      <span class="pop-label">${esc(it.label)}</span>
      ${it.count !== undefined ? `<span class="pop-count">${fmtNum(it.count)}</span>` : ''}
    </label>`).join('');
}

function bindChecks(pop, set, after) {
  pop.querySelectorAll('.pop-list input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => {
    cb.checked ? set.add(cb.value) : set.delete(cb.value);
    after();
  }));
}

const afterFilter = () => { renderToolbar(); reload(); };

function openFilter(chipEl) {
  const id = chipEl.dataset.chip;
  if (id === 'repeated') { state.repeatedOnly = !state.repeatedOnly; state.wordKey = null; afterFilter(); return; }
  if (id === 'book') {
    const vocabMode = state.tab === 'vocab';
    const books = lib.listBooks()
      .map(b => ({ value: b.key, label: b.title, count: vocabMode ? b.vocab_count : b.highlights_count }))
      .filter(b => b.count || state.selectedBooks.has(b.value))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'es'));
    const html = `<div class="pop-head"><input type="search" placeholder="Filtrar libros…" id="pop-q"></div>
      <div class="pop-list">${checkList(books, state.selectedBooks)}</div>
      <div class="pop-foot"><button class="link-btn" data-pop="none">Quitar filtro</button><button class="btn btn-sm btn-primary" data-pop="close">Listo</button></div>`;
    openPopover(chipEl, id, html, pop => {
      bindChecks(pop, state.selectedBooks, afterFilter);
      const q = pop.querySelector('#pop-q');
      q.focus();
      q.addEventListener('input', () => {
        const v = fold(q.value);
        pop.querySelectorAll('.pop-item').forEach(l => l.classList.toggle('hidden', !!v && !fold(l.title).includes(v)));
      });
      pop.querySelector('[data-pop="none"]').onclick = () => { state.selectedBooks.clear(); pop.querySelectorAll('input[type=checkbox]').forEach(c => { c.checked = false; }); afterFilter(); };
      pop.querySelector('[data-pop="close"]').onclick = closePopover;
    });
  } else if (id === 'lang') {
    const langs = (state.tab === 'vocab' ? lib.listVocabLanguages() : lib.listLanguages())
      .map(l => ({ value: l.lang, label: langName(l.lang), count: l.count }));
    const note = state.tab === 'vocab' ? 'Idioma de cada palabra.' : state.tab === 'books' ? 'Idioma del libro.' : 'Idioma del libro (número de libros).';
    openPopover(chipEl, id, `<div class="pop-list">${checkList(langs, state.selectedLangs)}</div><div class="pop-note">${note}</div>`,
      pop => bindChecks(pop, state.selectedLangs, afterFilter));
  } else if (id === 'type') {
    const sup = lib.supersededCount();
    const items = Object.entries(TYPE_LABELS).map(([v, l]) => ({ value: v, label: l, title: l, count: v === 'superseded' ? sup : undefined }));
    openPopover(chipEl, id, `<div class="pop-list">${checkList(items, state.selectedTypes)}</div>
      <div class="pop-note">«Versiones anteriores»: cuando amplías un subrayado, el Kindle guarda también la versión corta; se ocultan para no verla repetida.</div>`,
      pop => bindChecks(pop, state.selectedTypes, afterFilter));
  } else if (id === 'status') {
    const counts = lib.vocabStatusCounts();
    const items = Object.entries(STATUS_LABELS).map(([v, l]) => ({ value: v, label: l, count: counts[v] }));
    openPopover(chipEl, id, `<div class="pop-list">${checkList(items, state.selectedStatuses)}</div>`,
      pop => bindChecks(pop, state.selectedStatuses, afterFilter));
  }
}

/** Lo que filtra la lista ahora mismo, con una × para quitar cada cosa. */
function renderActiveFilters() {
  const el = $('#active-filters');
  const pills = [];
  if (['highlights', 'vocab'].includes(state.tab)) {
    const books = [...state.selectedBooks];
    if (books.length > 3) pills.push(['books', `${fmtNum(books.length)} libros`]);
    else books.forEach(k => pills.push([`book:${k}`, shortTitle((lib.books.get(k) || {}).title || '?')]));
    state.selectedLangs.forEach(l => pills.push([`lang:${l}`, langName(l)]));
    if (state.tab === 'vocab' && state.wordKey) pills.push(['word', `Palabra «${(lib.repeatStats().get(state.wordKey) || {}).word || '?'}»`]);
    if (state.tab === 'vocab' && state.repeatedOnly) pills.push(['repeated', 'Se te resisten']);
  }
  if (!pills.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `<span>Filtrando por:</span>${pills.map(([k, l]) => `<button class="pill-x" data-unfilter="${esc(k)}" title="Quitar este filtro"><span>${esc(l)}</span>${icon('x')}</button>`).join('')}
    <button class="link-btn" data-unfilter="all">Quitar todos</button>`;
}

function unfilter(k) {
  if (k === 'all') { state.selectedBooks.clear(); state.selectedLangs.clear(); state.repeatedOnly = false; state.wordKey = null; }
  else if (k === 'books') state.selectedBooks.clear();
  else if (k.startsWith('book:')) state.selectedBooks.delete(k.slice(5));
  else if (k.startsWith('lang:')) state.selectedLangs.delete(k.slice(5));
  else if (k === 'word') state.wordKey = null;
  else if (k === 'repeated') state.repeatedOnly = false;
  afterFilter();
}

// ============================================================
//  Bienvenida (sin datos)
// ============================================================
function renderWelcome() {
  $('#result-count').textContent = '';
  const spines = [['#7b2f2a', 92], ['#2c4770', 110], ['#86651c', 84], ['#2d5a4c', 118], ['#57386b', 98], ['#3f3a35', 106], ['#9b3b2d', 88]];
  $('#results').innerHTML = `<div class="welcome">
    <div class="welcome-art" aria-hidden="true">${spines.map(([c, h]) => `<span style="height:${h}px;background:${c}"></span>`).join('')}</div>
    <h2>Tus lecturas, en un solo sitio</h2>
    <p>Trae los subrayados, notas y palabras que buscas en tu Kindle. Todo se guarda en este navegador y, si quieres, se sincroniza con tus otros equipos: el móvil y el ordenador.</p>
    <div class="welcome-actions">
      ${enMovil
        ? `<button class="btn btn-primary" id="w-link">${icon('phone')}Ya lo uso en el ordenador</button>
           <button class="btn btn-ghost" id="w-import">${icon('import')}Importar archivos</button>`
        : `<button class="btn btn-primary" id="w-import">${icon('import')}Importar mis datos</button>
           <button class="btn btn-ghost" id="w-link">${icon('phone')}Ya lo uso en otro equipo</button>`}
    </div>
    <div class="welcome-steps">
      ${enMovil
        ? `<div class="welcome-step">${icon('laptop')}<strong>Desde el ordenador</strong><span>Crea allí un código (Sincronización → Con un código) y escríbelo aquí una vez: tu biblioteca llega sola.</span></div>`
        : `<div class="welcome-step">${icon('kindle')}<strong>Del Kindle</strong><span>Conéctalo por USB: subrayados, palabras buscadas y la lista de libros.</span></div>`}
      <div class="welcome-step">${icon('cloud')}<strong>De la nube de Amazon</strong><span>Todo lo que subrayaste en cualquier aparato, con un marcador.</span></div>
      <div class="welcome-step">${icon('map')}<strong>Para estudiar</strong><span>Mapas en UltraMind y palabras en VocaMaster, con un clic.</span></div>
    </div>
  </div>`;
  $('#w-import').onclick = () => openDialog('import-dialog');
  $('#w-link').onclick = () => openSyncDialog({ codigo: true });
}

// ============================================================
//  Inicio
// ============================================================
const dayHash = s => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

/** Un subrayado para hoy: el mismo todo el día; «Otro» pasa al siguiente. */
function dailyHighlight() {
  const pool = lib.filterHighlights({ types: new Set(['highlight', 'note']) })
    .filter(h => h.type === 'highlight' && h.content.length >= 60 && h.content.length <= 700);
  if (!pool.length) return null;
  const i = (dayHash(new Date().toDateString()) + state.dailyOffset * 7919) % pool.length;
  return pool[i];
}

function bookCardHtml(b, { stats = true } = {}) {
  const badges = [];
  if (lib.device && b.on_device) badges.push(`<span class="cover-badge" title="En el Kindle">${icon('kindle')}</span>`);
  else if (b.in_cloud) badges.push(`<span class="cover-badge" title="En la nube de Amazon">${icon('cloud')}</span>`);
  const s = [];
  if (b.highlights_count) s.push(`<span title="Subrayados">${icon('highlight')}${fmtNum(b.highlights_count)}</span>`);
  if (b.vocab_count) s.push(`<span title="Palabras buscadas">${icon('words')}${fmtNum(b.vocab_count)}</span>`);
  const lack = b.device_counts && b.device_counts.highlights > b.hl_count ? b.device_counts.highlights - b.hl_count : 0;
  return `<div class="book-card" data-book-key="${esc(b.key)}" tabindex="0" role="button" aria-label="${esc(b.title)}">
    <div class="cover">${coverHtml(b)}${badges.length ? `<div class="cover-badges">${badges.join('')}</div>` : ''}</div>
    <div class="book-meta">
      <div class="b-title">${esc(shortTitle(b.title))}</div>
      <div class="b-author">${esc(displayAuthor(b.author) || '—')}</div>
      ${stats ? `<div class="b-stats">${s.join('') || '<span class="muted">Sin subrayados</span>'}</div>` : ''}
      ${stats && lack ? `<div class="b-lack" title="El Kindle tiene ${b.device_counts.highlights} subrayados de este libro; los que faltan se hicieron en otro aparato: tráelos con Importar → Nube de Amazon">Faltan ${fmtNum(lack)} subrayados del Kindle</div>` : ''}
    </div>
  </div>`;
}

function renderHome() {
  const c = $('#results');
  const s = lib.stats();
  const st = lib.vocabStatusCounts();
  const books = lib.listBooks();
  const hist = lib.history();
  const recentKeys = [...hist.books].sort((a, b) => (b.last || '').localeCompare(a.last || '')).map(b => b.key);
  const byKey = new Map(books.map(b => [b.key, b]));
  let shelf = recentKeys.map(k => byKey.get(k)).filter(Boolean).slice(0, 12);
  if (!shelf.length) shelf = [...books].sort((a, b) => b.highlights_count - a.highlights_count).slice(0, 12);
  const daily = dailyHighlight();
  const dailyBook = daily ? byKey.get(daily.bookKey) || { title: daily.title, author: daily.author } : null;
  const recentWords = [];
  const seenW = new Set();
  for (const v of lib.filterVocab({})) {
    if (v.no_lookup || seenW.has(v.wkey)) continue;
    seenW.add(v.wkey); recentWords.push(v);
    if (recentWords.length >= 16) break;
  }
  const h = new Date().getHours();
  const hello = h < 6 ? 'Buenas noches' : h < 14 ? 'Buenos días' : h < 21 ? 'Buenas tardes' : 'Buenas noches';
  const today = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  const lastRead = hist.books.length ? [...hist.books].sort((a, b) => (b.last || '').localeCompare(a.last || ''))[0] : null;

  c.innerHTML = `<div class="home">
    <div class="home-hello">
      <h2>${hello}</h2>
      <p>${esc(today.charAt(0).toUpperCase() + today.slice(1))}${lastRead ? ` · Lo último que leíste: <em>${esc(shortTitle(lastRead.title))}</em>` : ''}</p>
    </div>

    <div class="tiles">
      <button class="tile" data-go="books"><div class="tile-top">Libros ${icon('library')}</div><div class="tile-num">${fmtNum(s.books)}</div><div class="tile-sub">${lib.device ? `${fmtNum(books.filter(b => b.on_device).length)} en el Kindle` : 'en tu biblioteca'}</div></button>
      <button class="tile" data-go="highlights"><div class="tile-top">Subrayados ${icon('highlight')}</div><div class="tile-num">${fmtNum(s.highlights)}</div><div class="tile-sub">con texto</div></button>
      <button class="tile" data-go="vocab"><div class="tile-top">Palabras ${icon('words')}</div><div class="tile-num">${fmtNum(s.vocab)}</div><div class="tile-sub">${fmtNum(lib.repeatedWordCount())} se te resisten</div></button>
      <button class="tile accent" data-go="new-words"><div class="tile-top">Por estudiar ${icon('send')}</div><div class="tile-num">${fmtNum(st.new)}</div><div class="tile-sub">sin enviar a VocaMaster</div></button>
    </div>

    ${daily ? `<section class="daily">
      <div class="daily-label">${icon('sparkle')}Un subrayado para hoy</div>
      <p class="daily-text">${esc(daily.content)}</p>
      ${(daily.notes || []).map(n => `<p class="daily-note">${esc(n.content)}</p>`).join('')}
      <div class="daily-foot">
        <button class="daily-book" data-book-key="${esc(daily.bookKey)}" data-flash="${esc(daily.hash)}">
          <div class="cover">${generatedCover(dailyBook)}</div>
          <div style="min-width:0"><div class="daily-book-title">${esc(shortTitle(dailyBook.title))}</div><div class="daily-book-author">${esc(displayAuthor(dailyBook.author))}${locLabel(daily) ? ` · ${esc(locLabel(daily))}` : ''}</div></div>
        </button>
        <button class="btn btn-ghost btn-sm" id="daily-copy">${icon('copy')}Copiar</button>
        <button class="btn btn-ghost btn-sm" id="daily-next">${icon('shuffle')}Otro</button>
      </div>
    </section>` : ''}

    ${shelf.length ? `<section>
      <div class="section-head"><h3>${recentKeys.length ? 'Leídos hace poco' : 'Tus libros'}</h3><button class="link-btn" data-go="books">Ver toda la biblioteca</button></div>
      <div class="shelf">${shelf.map(b => bookCardHtml(b, { stats: false })).join('')}</div>
    </section>` : ''}

    <div class="home-cols">
      <section class="panel">
        <div class="section-head"><h3>Palabras recientes</h3><button class="link-btn" data-go="vocab">Ver todas</button></div>
        ${recentWords.length ? `<div class="word-cloud">${recentWords.map(v => `<button class="word-chip" data-wkey="${esc(v.wkey)}" title="${esc(v.context || '')}">${esc(v.word)}${v.times > 1 ? `<small>×${v.times}</small>` : ''}</button>`).join('')}</div>`
          : '<p class="panel-note">Aún no hay palabras buscadas.</p>'}
        ${st.new ? `<div class="panel-actions" style="margin-top:14px"><button class="btn btn-primary btn-sm" data-go="send-new">${icon('send')}Estudiar las ${fmtNum(st.new)} nuevas en VocaMaster</button></div>` : ''}
      </section>
      <section class="panel">
        <div class="section-head"><h3>Tus datos</h3></div>
        <div class="kv-line">${icon('kindle')}<span>${lib.device ? `Kindle leído <strong>${esc(fmtWhen(lib.device.scannedAt))}</strong> · ${fmtNum(lib.device.keys.length)} libros` : 'Aún no has conectado el Kindle'}</span></div>
        <div class="kv-line">${icon('phone')}<span>${esc(nubeSummary())}</span></div>
        <div class="kv-line">${icon('laptop')}<span>${esc(syncSummary())}</span></div>
        <div class="kv-line">${icon('history')}<span>${hist.years.length ? `Registros desde <strong>${esc(hist.years[hist.years.length - 1].year)}</strong> en ${fmtNum(hist.books.length)} libros` : 'Sin fechas de lectura todavía'}</span></div>
        <div class="panel-actions" style="margin-top:12px">
          ${canRescan ? `<button class="btn btn-sm" data-go="rescan">${icon('refresh')}Volver a escanear el Kindle</button>` : ''}
          <button class="btn btn-sm btn-ghost" data-go="import">${icon('import')}Importar</button>
          <button class="btn btn-sm btn-ghost" data-go="sync">${icon('refresh')}Sincronización</button>
        </div>
      </section>
    </div>
  </div>`;
  setCount(s.books, 'libro', 'libros');
  const copy = $('#daily-copy');
  if (copy) copy.onclick = () => copyText(`${daily.content}\n\n— ${shortTitle(dailyBook.title)}${dailyBook.author ? `, ${displayAuthor(dailyBook.author)}` : ''}`);
  const next = $('#daily-next');
  if (next) next.onclick = () => { state.dailyOffset++; renderHome(); };
}

function syncSummary() {
  const st = sync ? sync.state : 'none';
  if (st === 'ok') return `Archivo de sincronización: al día (${fmtWhen(sync.meta.lastSync)})`;
  if (st === 'needs-permission') return 'Archivo de sincronización: pulsa para dar permiso';
  if (st === 'unsupported') return 'Archivo de sincronización: no en este navegador';
  if (st === 'error') return 'Archivo de sincronización: error';
  if (st === 'syncing') return 'Archivo de sincronización: sincronizando…';
  return 'Sin archivo de sincronización';
}

function nubeSummary() {
  if (!nube || !nube.codigo) return 'Sin código: llévate tu biblioteca al móvil con «Sincronización»';
  if (nube.state === 'syncing') return 'Con un código: sincronizando…';
  if (nube.state === 'error') return `Con un código: ${nube.error || 'error'}`;
  return `Con un código: al día${nube.lastSync ? ` (${fmtWhen(nube.lastSync)})` : ''}`;
}

/** Atajos del Inicio y del Historial. */
function go(where) {
  if (where === 'import') openDialog('import-dialog');
  else if (where === 'sync') openSyncDialog();
  else if (where === 'rescan') rescanKindle();
  else if (where === 'new-words' || where === 'send-new') {
    state.selectedBooks.clear(); state.selectedLangs.clear(); state.repeatedOnly = false; state.wordKey = null;
    state.selectedStatuses = new Set(['new']);
    setTab('vocab');
    if (where === 'send-new') openVocaMaster();
  } else setTab(where);
}

// ============================================================
//  Subrayados
// ============================================================
function locLabel(h) {
  if (h.location_start) {
    return `pos. ${h.location_start}${h.location_end && h.location_end !== h.location_start ? '–' + h.location_end : ''}`;
  }
  return h.page ? `pág. ${h.page}` : '';
}

const RENDER_LIMIT = 300;
let renderedCount = 0;

function freshList() { $('#results').innerHTML = '<div class="stack" id="list"></div>'; }

function listContainer() {
  let list = $('#list');
  if (!list) { $('#results').innerHTML = '<div class="stack" id="list"></div>'; list = $('#list'); }
  return list;
}

function emptyList(text, sub = '') {
  return `<div class="empty">${icon('search')}<p class="empty-title">${esc(text)}</p>${sub ? `<p>${sub}</p>` : ''}</div>`;
}

function highlightCardHtml(h, i, inBook) {
  const tags = [];
  if (h.type === 'note') tags.push('<span class="tag note">Nota</span>');
  if (h.type === 'bookmark') tags.push('<span class="tag">Marcador</span>');
  if (h.type === 'empty') tags.push('<span class="tag">Sin texto</span>');
  if (h.type === 'dropped') tags.push('<span class="tag bad">Bloqueado</span>');
  if (h.superseded) tags.push('<span class="tag warn" title="Luego ampliaste este subrayado en el Kindle">Versión anterior</span>');
  let body;
  if (h.type === 'bookmark') body = '<p class="h-content empty-content">Marcador en esta posición.</p>';
  else if (h.type === 'empty') body = '<p class="h-content empty-content">Subrayado sin texto (imagen, tabla o pie de página).</p>';
  else if (h.type === 'dropped') body = '<p class="h-content empty-content">Texto bloqueado por el límite de recortes de Amazon: el Kindle no lo guardó.</p>';
  else body = `<p class="h-content">${esc(h.content)}</p>`;
  if (h.parent) body = `<blockquote class="h-parent">${esc(h.parent.length > 220 ? h.parent.slice(0, 220) + '…' : h.parent)}</blockquote>${body}`;
  for (const n of h.notes || []) body += `<div class="h-note"><div class="h-note-label">${icon('note')}Tu nota</div>${esc(n.content)}</div>`;
  const hasText = h.type === 'highlight' || h.type === 'note';
  const [c1, c2] = coverColors(h.title);
  const meta = [locLabel(h), h.highlighted_at ? fmtDay(h.highlighted_at) : ''].filter(Boolean).join(' · ');
  const actions = [];
  if (hasText) actions.push(`<button class="icon-btn" data-copy title="Copiar">${icon('copy')}</button>`);
  if (hasText && speechSupported) actions.push(`<button class="icon-btn" data-speak="content" title="Escuchar">${icon('volume')}</button>`);
  if (hasText && needsTranslation(h.language)) actions.push(`<button class="icon-btn" data-translate title="Traducir">${icon('translate')}</button>`);
  return `<article class="h-card${h.type === 'highlight' ? '' : ' ' + h.type}${h.superseded ? ' superseded' : ''}" data-i="${i}" data-hash="${esc(h.hash)}">
    ${body}
    ${hasText ? '<div class="h-translation hidden"></div>' : ''}
    <footer class="h-foot">
      <div class="h-src">
        ${inBook ? '' : `<span class="h-src-dot" style="--c1:${c1};--c2:${c2}"></span><button data-open-book="${esc(h.bookKey)}" title="${esc(h.title)}">${esc(shortTitle(h.title))}</button>`}
        <span class="h-src-text">${inBook ? '' : (meta ? '· ' : '')}${esc(meta)}</span>
        ${tags.length ? `<span class="h-tags">${tags.join('')}</span>` : ''}
      </div>
      <div class="card-actions">${actions.join('')}</div>
    </footer>
  </article>`;
}

function renderHighlights(append = false, { inBook = false } = {}) {
  const list = listContainer();
  const items = state.results;
  if (!inBook) setCount(items.length, 'subrayado', 'subrayados');
  if (!items.length) {
    list.innerHTML = emptyList(state.search ? `Nada coincide con «${state.search}»` : 'No hay subrayados con estos filtros',
      state.search || state.selectedBooks.size || state.selectedLangs.size ? 'Prueba a quitar algún filtro.' : '');
    return;
  }
  const start = append ? renderedCount : 0;
  const end = Math.min(items.length, start + RENDER_LIMIT);
  const html = items.slice(start, end).map((h, j) => highlightCardHtml(h, start + j, inBook)).join('');
  if (append) { list.querySelector('.load-more')?.remove(); list.insertAdjacentHTML('beforeend', html); }
  else { list.innerHTML = html; }
  renderedCount = end;
  if (end < items.length) addLoadMore(list, items.length - end, () => renderHighlights(true, { inBook }));
}

// ============================================================
//  Vocabulario
// ============================================================
const fmtDay = iso => new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });

/** Búsquedas de una palabra, de la más reciente a la más antigua: [{ title, at }]. */
function wordHits(wkey) {
  const r = lib.repeatStats().get(wkey);
  if (!r) return [];
  return [...r.hits]
    .sort((a, b) => (b.at || '').localeCompare(a.at || ''))
    .map(h => ({ title: (lib.books.get(h.bookKey) || {}).title || 'Sin libro', at: h.at }));
}

/** Texto del tooltip: «Buscada 3 veces:» y una línea por búsqueda con fecha y libro. */
function timesTooltip(wkey) {
  const hits = wordHits(wkey);
  return [`Buscada ${hits.length} veces:`, ...hits.map(h => `• ${h.at ? fmtDay(h.at) : 'sin fecha'} — ${h.title}`)].join('\n');
}

function toggleTimesList(btn) {
  const list = btn.nextElementSibling;
  const open = list.classList.contains('hidden');
  if (open) list.innerHTML = wordHits(btn.dataset.times).map(h =>
    `<li><span>${esc(h.at ? fmtDay(h.at) : 'sin fecha')}</span> ${esc(h.title)}</li>`).join('');
  list.classList.toggle('hidden', !open);
  btn.setAttribute('aria-expanded', String(open));
}

function wordSideHtml(v) {
  const st = v.status;
  const out = [];
  if (st) out.push(`<span class="v-status v-status-${st}">${esc(STATUS_TAGS[st])}</span>`);
  const a = [];
  if (speechSupported) a.push(`<button class="icon-btn" data-speak="word" title="Escuchar la palabra">${icon('volume')}</button>`);
  if (needsTranslation(v.language)) a.push(`<button class="icon-btn" data-translate title="Traducir">${icon('translate')}</button>`);
  if (st !== 'known') a.push(`<button class="icon-btn" data-word-act="known" title="Me la sé">${icon('check')}</button>`);
  if (st !== 'ignored') a.push(`<button class="icon-btn" data-word-act="ignored" title="Ignorar">${icon('ban')}</button>`);
  if (st) a.push(`<button class="icon-btn" data-word-act="clear" title="Quitar la marca">${icon('undo')}</button>`);
  out.push(`<div class="card-actions">${a.join('')}</div>`);
  return out.join('');
}

function wordCardHtml(v, i, inBook) {
  const sel = state.selectedWords.has(v.wkey);
  return `<article class="v-card${sel ? ' selected' : ''}" data-wkey="${esc(v.wkey)}" data-i="${i}">
    <input type="checkbox" class="v-cb" data-i="${i}" aria-label="Elegir ${esc(v.word)}" title="Elegir (Mayús+clic: un tramo)"${sel ? ' checked' : ''}>
    <div class="v-head">
      <div class="v-word">${esc(v.word)}</div>
      <div class="v-sub">${v.language ? `<span class="tag">${esc(v.language.split('-')[0])}</span>` : ''}${v.stem && v.stem.toLowerCase() !== v.word.toLowerCase() ? `<span>de «${esc(v.stem)}»</span>` : ''}</div>
    </div>
    <div class="v-body">
      ${v.context ? `<div class="v-context">${highlightWord(v.context, v.word)}${speechSupported ? ` <button class="icon-btn" data-speak="context" title="Escuchar la frase" style="width:24px;height:24px;display:inline-grid;vertical-align:-6px">${icon('volume')}</button>` : ''}</div>` : '<div class="v-context muted">Sin frase (búsqueda antigua)</div>'}
      <div class="v-source">${!inBook && v.book_title ? `<button data-open-book="${esc(v.bookKey)}" title="${esc(v.book_title)}">${esc(shortTitle(v.book_title))}</button>` : ''}${!inBook && v.book_title && v.looked_up_at ? ' · ' : ''}${v.looked_up_at ? esc(fmtDay(v.looked_up_at)) : ''}</div>
      ${v.times > 1 ? `<button class="v-times" data-times="${esc(v.wkey)}" title="${esc(timesTooltip(v.wkey))}" aria-expanded="false">Buscada ${fmtNum(v.times)} veces${v.timesBooks > 1 ? ` en ${fmtNum(v.timesBooks)} libros` : ''} ▾</button>
      <ul class="v-times-list hidden"></ul>` : ''}
    </div>
    <div class="v-side">${wordSideHtml(v)}</div>
    <div class="v-translation hidden"></div>
  </article>`;
}

function renderVocab(append = false, { inBook = false } = {}) {
  const list = listContainer();
  const items = state.results;
  if (!inBook) setCount(items.length, 'palabra', 'palabras');
  if (!items.length) {
    list.innerHTML = emptyList(state.search ? `Nada coincide con «${state.search}»` : 'No hay palabras con estos filtros',
      'Revisa los filtros de libro, idioma o estado.');
    renderSelectionBar();
    return;
  }
  const start = append ? renderedCount : 0;
  const end = Math.min(items.length, start + RENDER_LIMIT);
  const html = items.slice(start, end).map((v, j) => wordCardHtml(v, start + j, inBook)).join('');
  if (append) { list.querySelector('.load-more')?.remove(); list.insertAdjacentHTML('beforeend', html); }
  else { list.innerHTML = html; state.lastChecked = null; }
  renderedCount = end;
  if (end < items.length) addLoadMore(list, items.length - end, () => renderVocab(true, { inBook }));
  renderSelectionBar();
}

// ----- Elegir palabras con su casilla -----
function renderSelectionBar() {
  const bar = $('#selection-bar');
  if (!isWordList() || !lib.vocab.size) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const n = state.selectedWords.size;
  bar.classList.toggle('active', n > 0);
  bar.innerHTML = n
    ? `<strong>${fmtNum(n)} palabra${n === 1 ? '' : 's'} elegida${n === 1 ? '' : 's'}</strong>
       <button class="btn btn-primary btn-sm" data-sel-act="send">${icon('send')}Enviar a VocaMaster</button>
       <button class="btn btn-sm" data-sel-act="known">${icon('check')}Me las sé</button>
       <button class="btn btn-sm" data-sel-act="ignored">${icon('ban')}Ignorar</button>
       <button class="link-btn" data-sel-act="all">Elegir todas</button>
       <button class="link-btn" data-sel-act="none">Quitar selección</button>`
    : `<span>${tactil()
        ? 'Toca la casilla de cada palabra para enviarla o marcarla (mantén pulsada una casilla para elegir también las de en medio).'
        : 'Marca palabras con su casilla para enviarlas o marcarlas (Mayús+clic elige un tramo).'}</span>
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

/** Cambia el estado de una palabra y repinta sus tarjetas sin perder el sitio en la lista. */
async function setWordStatus(keys, status) {
  for (const k of keys) lib.setWordStatus(k, status);
  const ks = new Set(keys);
  $$('.v-card').filter(c => ks.has(c.dataset.wkey)).forEach(c => {
    const item = state.results[+c.dataset.i];
    if (item) item.status = status || null;
    c.querySelector('.v-side').innerHTML = wordSideHtml(item || { status, language: null });
  });
  if (state.tab === 'vocab') renderToolbar();
  await lib.save();
  syncSoon();
}

// ----- Copiar, escuchar y traducir -----
async function copyText(text, done = '✓ Copiado') {
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch { toast('No se pudo copiar: el navegador no dio permiso'); }
}

function copyFromCard(btn) {
  const card = btn.closest('[data-i]');
  const h = state.results[+card.dataset.i];
  if (!h) return;
  const notes = (h.notes || []).map(n => `\nNota: ${n.content}`).join('');
  copyText(`${h.content}${notes}\n\n— ${shortTitle(h.title)}${h.author ? `, ${displayAuthor(h.author)}` : ''}${locLabel(h) ? ` (${locLabel(h)})` : ''}`);
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
  btn.className = 'btn load-more';
  btn.textContent = `Mostrar más (${fmtNum(remaining)} restantes)`;
  btn.onclick = onClick;
  container.appendChild(btn);
}

// ============================================================
//  Biblioteca
// ============================================================
function renderBooks() {
  const c = $('#results');
  let books = lib.listBooks();
  if (state.selectedLangs.size) books = books.filter(b => state.selectedLangs.has(b.language || '?'));
  if (state.search) {
    const q = fold(state.search);
    books = books.filter(b => fold(b.title).includes(q) || fold(b.author || '').includes(q));
  }
  const missing = b => !b.on_device && (b.highlights_count || b.vocab_count || b.in_cloud);
  const v = state.bookView;
  if (v === 'device') books = books.filter(b => b.on_device);
  if (v === 'missing') books = books.filter(missing);
  if (v === 'hl') books = books.filter(b => b.highlights_count);
  if (v === 'words') books = books.filter(b => b.vocab_count);
  const s = state.sort.books;
  if (s === 'author') books.sort((a, b) => displayAuthor(a.author || '~').localeCompare(displayAuthor(b.author || '~'), 'es', { sensitivity: 'base' }));
  else if (s === 'highlights') books.sort((a, b) => b.highlights_count - a.highlights_count);
  else if (s === 'words') books.sort((a, b) => b.vocab_count - a.vocab_count);
  else if (s === 'recent') {
    const last = new Map(lib.history().books.map(b => [b.key, b.last || '']));
    books.sort((a, b) => (last.get(b.key) || '').localeCompare(last.get(a.key) || ''));
  }
  setCount(books.length, 'libro', 'libros');
  const head = lib.device ? `<div class="books-head"><span class="hint">Inventario del Kindle: ${esc(fmtWhen(lib.device.scannedAt))}</span></div>` : '';
  c.innerHTML = books.length
    ? `${head}<div class="books-grid">${books.map(b => bookCardHtml(b)).join('')}</div>`
    : emptyList('Ningún libro coincide', 'Prueba con otra búsqueda o quita los filtros.');
}

// ============================================================
//  Página de un libro
// ============================================================
function renderBook() {
  const b = lib.listBooks().find(x => x.key === state.bookKey) || (lib.books.get(state.bookKey) && { ...lib.books.get(state.bookKey), highlights_count: 0, vocab_count: 0 });
  if (!b) { setTab('books'); return; }
  const h = lib.history().books.find(x => x.key === b.key);
  const notes = [...lib.highlights.values()].filter(x => x.bookKey === b.key && x.type === 'note').length;
  const facts = [];
  facts.push(`<span class="fact">${icon('highlight')}<strong>${fmtNum(b.highlights_count)}</strong> subrayados</span>`);
  if (notes) facts.push(`<span class="fact">${icon('note')}<strong>${fmtNum(notes)}</strong> notas</span>`);
  facts.push(`<span class="fact">${icon('words')}<strong>${fmtNum(b.vocab_count)}</strong> palabras</span>`);
  if (b.language) facts.push(`<span class="fact">${esc(langName(b.language))}</span>`);
  if (h) facts.push(`<span class="fact">${icon('history')}${esc(fmtSpan(h.first, h.last))}</span>`);
  if (lib.device) facts.push(b.on_device ? `<span class="fact good">${icon('kindle')}En el Kindle</span>` : `<span class="fact">${icon('kindle')}No está en el Kindle</span>`);
  if (b.in_cloud) facts.push(`<span class="fact">${icon('cloud')}En la nube de Amazon</span>`);
  const lack = b.device_counts && b.device_counts.highlights > b.hl_count ? b.device_counts.highlights - b.hl_count : 0;
  if (lack) facts.push(`<span class="fact warn" title="Se hicieron en otro aparato: tráelos con Importar → Nube de Amazon">${icon('alert')}Faltan ${fmtNum(lack)} subrayados del Kindle</span>`);
  const hasHl = b.highlights_count > 0, hasWords = b.vocab_count > 0;
  if (state.bookTab === 'highlights' && !hasHl && hasWords) state.bookTab = 'vocab';
  if (state.bookTab === 'vocab' && !hasWords && hasHl) state.bookTab = 'highlights';
  setCount(b.highlights_count, 'subrayado', 'subrayados');

  $('#results').innerHTML = `
    <div class="book-hero">
      <div class="cover">${coverHtml(b)}</div>
      <div>
        <h2 class="hero-title">${esc(b.title)}</h2>
        <div class="hero-author">${esc(displayAuthor(b.author) || 'Autor desconocido')}</div>
        <div class="hero-facts">${facts.join('')}</div>
      </div>
      <div class="hero-actions">
          ${hasHl ? `<button class="btn btn-primary" data-book-act="ultramind">${icon('map')}Abrir en UltraMind</button>` : ''}
          ${hasWords ? `<button class="btn${hasHl ? '' : ' btn-primary'}" data-book-act="vocamaster">${icon('send')}Enviar palabras a VocaMaster</button>` : ''}
          ${hasHl ? `<button class="btn btn-ghost" data-book-act="copy">${icon('copy')}Copiar subrayados</button>` : ''}
          <button class="btn btn-ghost" data-book-act="export">${icon('export')}Exportar…</button>
      </div>
    </div>
    <div class="book-tabs">
      <div class="seg" role="tablist">
        <button class="${state.bookTab === 'highlights' ? 'on' : ''}" data-book-tab="highlights">Subrayados <span class="n">${fmtNum(b.highlights_count)}</span></button>
        <button class="${state.bookTab === 'vocab' ? 'on' : ''}" data-book-tab="vocab">Palabras <span class="n">${fmtNum(b.vocab_count)}</span></button>
      </div>
      <label class="search-wrap">${icon('search')}<input type="search" id="book-q" placeholder="Buscar en este libro…" value="${esc(state.search)}" autocomplete="off"></label>
    </div>
    <div class="stack" id="list"></div>`;
  const q = $('#book-q');
  q.addEventListener('input', () => {
    state.search = q.value.trim();
    clearTimeout(renderBook._t);
    renderBook._t = setTimeout(renderBookList, 180);
  });
  renderBookList();
  renderSelectionBar();
  if (state.flash) {
    const hash = state.flash;
    state.flash = null;
    requestAnimationFrame(() => {
      const el = document.querySelector(`.h-card[data-hash="${CSS.escape(hash)}"]`);
      if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); }
    });
  }
}

function renderBookList() {
  if (state.bookTab === 'vocab') {
    state.results = lib.filterVocab(currentFilters());
    renderVocab(false, { inBook: true });
  } else {
    state.results = lib.filterHighlights(currentFilters());
    renderHighlights(false, { inBook: true });
  }
}

function bookAction(act) {
  const b = lib.books.get(state.bookKey);
  if (!b) return;
  const items = () => lib.filterHighlights({ bookKeys: new Set([b.key]), types: new Set(['highlight', 'note']) });
  if (act === 'ultramind') {
    const maps = ultramindMaps(items());
    if (maps.length) openInUltraMind(maps[0]);
  } else if (act === 'vocamaster') {
    state.bookTab = 'vocab';
    openVocaMaster();
  } else if (act === 'copy') {
    const text = items().filter(h => h.type === 'highlight').map(h => h.content + (h.notes || []).map(n => `\n  Nota: ${n.content}`).join('')).join('\n\n');
    copyText(`${b.title}${b.author ? ` — ${displayAuthor(b.author)}` : ''}\n\n${text}`, '✓ Subrayados copiados');
  } else if (act === 'export') openExport();
}

// ============================================================
//  Buscador (Ctrl+K)
// ============================================================
let paletteItems = [];
let paletteIndex = 0;

function openPalette() {
  closePopover();
  $('#rail').classList.remove('open');
  openDialog('search-dialog');
  const input = $('#palette-input');
  input.value = '';
  renderPalette('');
  input.focus();
  setTimeout(() => input.focus(), 30);
}

function snippet(text, q, n = 120) {
  const f = fold(text);
  const i = f.indexOf(q);
  if (i < 0) return esc(text.slice(0, n));
  const a = Math.max(0, i - 40);
  const pre = (a > 0 ? '…' : '') + text.slice(a, i);
  const hit = text.slice(i, i + q.length);
  const post = text.slice(i + q.length, i + q.length + n - 40);
  return `${esc(pre)}<mark>${esc(hit)}</mark>${esc(post)}${i + q.length + n - 40 < text.length ? '…' : ''}`;
}

function renderPalette(raw) {
  const q = fold(raw.trim());
  const groups = [];
  paletteItems = [];
  const add = (group, rows) => { if (rows.length) { groups.push({ group, rows }); paletteItems.push(...rows); } };
  if (!q) {
    add('Ir a', [
      ...Object.entries(VIEW_TITLES).map(([t, l]) => ({ kind: 'go', id: t, title: l, iconName: { home: 'home', books: 'library', highlights: 'highlight', vocab: 'words', history: 'history' }[t] })),
      { kind: 'go', id: 'import', title: 'Importar…', iconName: 'import' },
    ]);
    const hist = lib.history().books.sort((a, b) => (b.last || '').localeCompare(a.last || '')).slice(0, 5);
    add('Leídos hace poco', hist.map(b => ({ kind: 'book', id: b.key, book: lib.books.get(b.key) })).filter(r => r.book));
  } else {
    const books = lib.listBooks().filter(b => fold(b.title).includes(q) || fold(b.author || '').includes(q)).slice(0, 6);
    add('Libros', books.map(b => ({ kind: 'book', id: b.key, book: b })));
    const hls = [];
    for (const h of lib.highlights.values()) {
      if ((h.type === 'highlight' || h.type === 'note') && fold(h.content).includes(q)) { hls.push(h); if (hls.length >= 8) break; }
    }
    add('Subrayados', hls.map(h => ({ kind: 'hl', id: h.hash, h, book: lib.books.get(h.bookKey) })));
    const words = [];
    const seen = new Set();
    for (const v of lib.vocab.values()) {
      if (!fold(v.word).includes(q)) continue;
      const k = `${v.language}|${(v.stem || v.word).toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k); words.push(v);
      if (words.length >= 8) break;
    }
    add('Palabras', words.map(v => ({ kind: 'word', id: v.key, v, book: lib.books.get(v.bookKey) })));
  }
  paletteIndex = 0;
  let n = 0;
  const row = r => {
    const i = n++;
    if (r.kind === 'go') return `<button class="pal-item" data-pi="${i}">${icon(r.iconName)}<div class="pal-main"><div class="pal-title">${esc(r.title)}</div></div></button>`;
    if (r.kind === 'book') return `<button class="pal-item" data-pi="${i}"><div class="cover">${generatedCover(r.book)}</div><div class="pal-main"><div class="pal-title serif">${q ? snippet(r.book.title, q, 90) : esc(r.book.title)}</div><div class="pal-sub">${esc(displayAuthor(r.book.author) || '')}</div></div></button>`;
    if (r.kind === 'hl') return `<button class="pal-item" data-pi="${i}">${icon(r.h.type === 'note' ? 'note' : 'quote')}<div class="pal-main"><div class="pal-title serif">${snippet(r.h.content, q)}</div><div class="pal-sub">${esc(shortTitle(r.book ? r.book.title : ''))}</div></div></button>`;
    return `<button class="pal-item" data-pi="${i}">${icon('words')}<div class="pal-main"><div class="pal-title serif">${snippet(r.v.word, q, 60)}</div><div class="pal-sub">${esc(r.v.context ? r.v.context.slice(0, 100) : '')}</div></div></button>`;
  };
  $('#palette-results').innerHTML = groups.length
    ? groups.map(g => `<div class="pal-group">${esc(g.group)}</div>${g.rows.map(row).join('')}`).join('') +
      '<div class="pal-hint"><span>↑ ↓ para moverte</span><span>Intro para abrir</span><span>Esc para cerrar</span></div>'
    : `<div class="pal-empty">Nada coincide con «${esc(raw)}».</div>`;
  paintPalette();
}

function paintPalette() {
  $$('#palette-results .pal-item').forEach(el => el.classList.toggle('on', +el.dataset.pi === paletteIndex));
  const on = $('#palette-results .pal-item.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

function runPaletteItem(i) {
  const r = paletteItems[i];
  if (!r) return;
  closeDialog('search-dialog');
  if (r.kind === 'go') { if (r.id === 'import') openDialog('import-dialog'); else setTab(r.id); }
  else if (r.kind === 'book') openBook(r.id);
  else if (r.kind === 'hl') openBook(r.h.bookKey, 'highlights', { flash: r.h.hash });
  else if (r.kind === 'word') {
    state.selectedBooks.clear(); state.selectedLangs.clear(); state.repeatedOnly = false;
    state.wordKey = wordKeyOf(r.v);
    setTab('vocab');
  }
}

// ============================================================
//  Tema (automático, claro u oscuro)
// ============================================================
const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: 'Tema: automático (como el sistema)', light: 'Tema: claro', dark: 'Tema: oscuro' };
function currentTheme() { try { return localStorage.getItem('kindlevault:theme') || 'auto'; } catch { return 'auto'; } }
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try { t === 'auto' ? localStorage.removeItem('kindlevault:theme') : localStorage.setItem('kindlevault:theme', t); } catch { /* */ }
  const btn = $('#btn-theme');
  btn.innerHTML = icon({ auto: 'auto', light: 'sun', dark: 'moon' }[t]);
  btn.title = THEME_LABEL[t];
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#15130f' : '#f6f2ea';
}

// ============================================================
//  Historial de lectura
// ============================================================
const fmtMonth = iso => new Date(iso).toLocaleDateString('es-ES', { month: 'short', year: 'numeric' });
const fmtSpan = (a, b) => (fmtMonth(a) === fmtMonth(b) ? fmtMonth(a) : `${fmtMonth(a)} – ${fmtMonth(b)}`);
const plural = (n, one, many) => `${fmtNum(n)} ${n === 1 ? one : many}`;

function renderHistory() {
  const c = $('#results');
  const h = lib.history();
  setCount(h.books.length, 'libro con actividad', 'libros con actividad');
  if (!h.years.length) {
    c.innerHTML = emptyList('Todavía no hay fechas', 'El historial sale de las fechas de tus búsquedas y subrayados.');
    return;
  }
  const words = h.years.reduce((n, y) => n + y.words, 0);
  const hls = h.years.reduce((n, y) => n + y.hl, 0);
  const since = h.years[h.years.length - 1].year;
  const maxYear = Math.max(...h.years.map(y => y.words + y.hl));
  const reps = [...lib.repeatStats().entries()].filter(([, r]) => r.n >= 2)
    .sort((a, b) => b[1].n - a[1].n || b[1].books.size - a[1].books.size).slice(0, 20);
  const topBooks = [...h.books].sort((a, b) => b.words - a.words).filter(b => b.words).slice(0, 10);
  const maxBook = topBooks.length ? topBooks[0].words : 1;
  const langTotal = h.langs.reduce((n, l) => n + l.count, 0) || 1;
  const bar = (n, max, cls) => `<span class="hist-bar ${cls}" style="width:${Math.max(n ? 2 : 0, Math.round((n / max) * 100))}%"></span>`;

  c.innerHTML = `<div class="history">
    <section class="hist-summary">
      <div><strong>${fmtNum(h.books.length)}</strong><span>libros con actividad</span></div>
      <div><strong>${fmtNum(words)}</strong><span>palabras buscadas</span></div>
      <div><strong>${fmtNum(hls)}</strong><span>subrayados</span></div>
      <div><strong>${esc(since)}</strong><span>primer registro</span></div>
    </section>

    <section class="hist-section">
      <h3>Por año</h3>
      <div class="hist-legend"><span class="hist-dot words"></span>palabras buscadas <span class="hist-dot hl"></span>subrayados</div>
      ${h.years.map(y => `<div class="hist-row">
        <span class="hist-label">${esc(y.year)}</span>
        <span class="hist-bars">${bar(y.words, maxYear, 'words')}${bar(y.hl, maxYear, 'hl')}</span>
        <span class="hist-num">${fmtNum(y.words)} · ${fmtNum(y.hl)} · ${plural(y.books.length, 'libro', 'libros')}</span>
      </div>`).join('')}
    </section>

    <div class="hist-cols">
      <section class="hist-section">
        <h3>Idiomas de las palabras</h3>
        ${h.langs.map(l => `<button class="hist-row hist-link" data-lang="${esc(l.lang)}" title="Ver las palabras en ${esc(langName(l.lang))}">
          <span class="hist-label">${esc(langName(l.lang))}</span>
          <span class="hist-bars">${bar(l.count, h.langs[0].count, 'words')}</span>
          <span class="hist-num">${fmtNum(l.count)} · ${Math.round((l.count / langTotal) * 100)} %</span>
        </button>`).join('')}
      </section>
      <section class="hist-section">
        <h3>Libros con más palabras buscadas</h3>
        ${topBooks.map(b => `<button class="hist-row hist-link" data-book="${esc(b.key)}" data-to="vocab" title="Ver sus palabras">
          <span class="hist-label hist-title">${esc(b.title)}</span>
          <span class="hist-bars">${bar(b.words, maxBook, 'words')}</span>
          <span class="hist-num">${fmtNum(b.words)}</span>
        </button>`).join('')}
      </section>
    </div>

    ${reps.length ? `<section class="hist-section">
      <h3>Las que se te resisten</h3>
      <p class="hint">Palabras que has buscado más de una vez. Pulsa una para ver todas sus frases, o
        <button class="link-btn" id="hist-all-reps">ver las ${fmtNum(lib.repeatedWordCount())}</button> y enviarlas a VocaMaster.</p>
      <div class="hist-chips">${reps.map(([k, r]) => `<button class="hist-chip" data-wkey="${esc(k)}" title="${esc(timesTooltip(k))}">
        ${esc(r.word)} <span>×${r.n}${r.books.size > 1 ? ` · ${r.books.size} libros` : ''}</span></button>`).join('')}</div>
    </section>` : ''}

    <section class="hist-section">
      <h3>Línea de tiempo</h3>
      <p class="hint">Cuándo leíste cada libro, según las fechas de tus búsquedas y subrayados. Pulsa un libro para abrirlo.</p>
      ${h.years.map(y => `<div class="hist-year">
        <h4>${esc(y.year)}</h4>
        ${y.books.map(b => `<button class="hist-book hist-link" data-book="${esc(b.key)}" data-to="${b.inYear.hl ? 'highlights' : 'vocab'}">
          <span class="hist-book-title">${esc(b.title)}${b.author ? ` <span class="hist-author">· ${esc(b.author)}</span>` : ''}</span>
          <span class="hist-book-meta">${esc(fmtSpan(b.inYear.first, b.inYear.last))}${[b.inYear.words ? plural(b.inYear.words, 'palabra', 'palabras') : '', b.inYear.hl ? plural(b.inYear.hl, 'subrayado', 'subrayados') : ''].filter(Boolean).map(x => ` · ${x}`).join('')}</span>
        </button>`).join('')}
      </div>`).join('')}
    </section>
  </div>`;
  c.scrollTop = 0;

  c.querySelectorAll('.hist-link[data-book]').forEach(el => { el.onclick = () => openBook(el.dataset.book, el.dataset.to); });
  c.querySelectorAll('.hist-link[data-lang]').forEach(el => { el.onclick = () => {
    state.selectedBooks.clear(); state.selectedLangs = new Set([el.dataset.lang]); state.repeatedOnly = false; state.wordKey = null;
    setTab('vocab');
  }; });
  const all = $('#hist-all-reps');
  if (all) all.onclick = () => {
    state.selectedBooks.clear(); state.selectedLangs.clear(); state.repeatedOnly = true; state.wordKey = null;
    setTab('vocab');
  };
}

function setSearch(q) {
  state.search = q;
  $('#search').value = q;
}

// ============================================================
//  Exportar
// ============================================================
function exportKind() { return isWordList() ? 'vocab' : 'highlights'; }

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

// ----- UltraMind: abrir el mapa allí directamente -----
// UltraMind lee el mapa de su propia dirección, detrás de «#mapa=» (JSON en
// base64 apto para direcciones; esa parte no sale del navegador) y lo abre
// como mapa nuevo. Se abre en una sola pestaña con nombre: cada mapa que se
// manda después llega a esa misma pestaña.
const ULTRAMIND_URL = 'https://ultramind-218544803913.europe-west1.run.app';
const ultramindUrl = () => { try { return (localStorage.getItem('kindlevault:ultramindUrl') || ULTRAMIND_URL).replace(/\/+$/, ''); } catch { return ULTRAMIND_URL; } };
const toBase64Url = text => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
function openInUltraMind(map) {
  const paquete = { fuente: 'mapa', v: 1, titulo: map.title, markdown: map.content, origen: 'kindlevault' };
  const w = window.open(`${ultramindUrl()}/#mapa=${toBase64Url(JSON.stringify(paquete))}`, 'ultramind');
  toast(w ? `🧠 Abriendo «${map.title}» en UltraMind…` : 'El navegador no dejó abrir UltraMind: descarga el archivo y ábrelo allí con «Abrir o importar»');
}

function renderUltraMindSend(maps) {
  const box = $('#ultramind-send');
  box.classList.toggle('hidden', !maps);
  if (!maps) return;
  const branches = m => (m.content.match(/^- /gm) || []).length;
  box.innerHTML = maps.length
    ? `<div class="um-list">${maps.map((m, i) => `<div class="um-row">
          <span class="um-title">${esc(m.title)}</span>
          <span class="um-count">${plural(branches(m), 'subrayado', 'subrayados')}</span>
          <button class="btn btn-primary btn-sm" data-um-open="${i}">🧠 Abrir en UltraMind</button>
        </div>`).join('')}</div>
       <button class="link-btn um-url" id="um-url" title="${esc(ultramindUrl())}">Dirección de UltraMind</button>`
    : '';
  box.querySelectorAll('[data-um-open]').forEach(btn => { btn.onclick = () => openInUltraMind(maps[+btn.dataset.umOpen]); });
  const u = $('#um-url');
  if (u) u.onclick = () => {
    const next = prompt('Dirección de UltraMind (la que abres en el navegador):', ultramindUrl());
    if (next === null) return;
    const v = next.trim();
    if (v && !/^https:\/\/\S+|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(v)) { alert('Esa dirección no vale: tiene que empezar por https://'); return; }
    try { v ? localStorage.setItem('kindlevault:ultramindUrl', v.replace(/\/+$/, '')) : localStorage.removeItem('kindlevault:ultramindUrl'); } catch { /* */ }
    renderUltraMindSend(maps);
    toast('Dirección de UltraMind guardada');
  };
}

function refreshPreview() {
  const ex = currentExport();
  renderUltraMindSend(ex.maps || null);
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
    ? 'Van exactamente las palabras que has elegido. Cuando VocaMaster las añada (o al copiar un bloque), quedan marcadas como «Enviada».'
    : `${state.tab === 'book' ? 'Van las palabras de este libro.' : 'Se usan los filtros que tengas puestos.'} No van las marcadas como «Me la sé» ni «Ignorar». Cuando VocaMaster las añada (o al copiar un bloque), quedan marcadas como «Enviada» para no repetirlas la próxima vez.`;
  const items = chosen
    ? lib.filterVocab({}).filter(v => state.selectedWords.has(v.wkey))
    : lib.filterVocab({ ...currentFilters(), statuses: null, ...(state.tab === 'book' ? { search: '' } : {}) });
  vmItems = vocamasterItems(items, {
    baseForm: $('#vm-base-form').checked,
    includeSent: $('#vm-include-sent').checked,
    withContext: $('#vm-with-context').checked,
    allSentences: $('#vm-all-sentences').checked,
    explicit: chosen,
  });
  renderVocaMasterSend();
  vmBlocks = vocamasterBlocks(items, {
    baseForm: $('#vm-base-form').checked,
    includeSent: $('#vm-include-sent').checked,
    withContext: $('#vm-with-context').checked,
    byBook: $('#vm-by-book').checked,
    explicit: chosen,
  });
  const c = $('#vm-blocks');
  if (!vmBlocks.length) {
    c.innerHTML = `<div class="empty"><p>No hay palabras nuevas que enviar con estos filtros.${$('#vm-include-sent').checked ? '' : ' Si quieres repetir las ya enviadas, marca «Incluir las ya enviadas».'}</p></div>`;
    return;
  }
  const langs = new Set(vmBlocks.map(b => b.lang));
  const words = vmBlocks.reduce((n, b) => n + b.terms.length, 0);
  const nBooks = new Set(vmBlocks.map(b => b.book)).size;
  let html = `<p class="vm-summary">${fmtNum(words)} palabras en ${fmtNum(vmBlocks.length)} bloque${vmBlocks.length === 1 ? '' : 's'}` +
    `${langs.size > 1 ? `, separadas por idioma (cada idioma va a su lista de VocaMaster)` : ''}.` +
    ($('#vm-by-book').checked ? ` Son de ${plural(nBooks, 'libro', 'libros')}: crea en VocaMaster una lista por libro y pega en ella sus bloques.` : '') + '</p>';
  html += vmBlocks.map((b, i) => {
    const preview = b.terms.slice(0, 12).join(', ') + (b.terms.length > 12 ? '…' : '');
    return `<div class="vm-block" data-i="${i}">
      <div class="vm-block-head">
        <div>${b.book !== undefined ? `<strong>${esc(b.book || 'Sin libro')}</strong> · ${esc(langName(b.lang))}` : `<strong>${esc(langName(b.lang))}</strong>`}${b.total > 1 ? ` · bloque ${b.index} de ${b.total}` : ''} · ${plural(b.terms.length, 'palabra', 'palabras')}</div>
        <button class="btn btn-primary" data-vm-copy="${i}">Copiar</button>
      </div>
      <div class="vm-preview">${esc(preview)}</div>
      <textarea class="vm-fallback hidden" readonly rows="6">${esc(b.text)}</textarea>
    </div>`;
  }).join('');
  c.innerHTML = html;
  c.querySelectorAll('[data-vm-copy]').forEach(btn => { btn.onclick = () => copyVocaMasterBlock(+btn.dataset.vmCopy, btn); });
}

// ----- Envío directo: abre VocaMaster y le pasa las palabras -----
// VocaMaster las recibe en una hoja donde se revisan, se etiquetan (una a una o
// varias a la vez, con sus etiquetas de siempre) y se añaden. Al terminar avisa
// de qué añadió, y aquí se marcan como «Enviada».
const VOCAMASTER_URL = 'https://vocamaster-685956792688.europe-west1.run.app/';
const vocamasterUrl = () => { try { return localStorage.getItem('kindlevault:vocamasterUrl') || VOCAMASTER_URL; } catch { return VOCAMASTER_URL; } };
let vmItems = [];
let vmSend = null; // { id, status: 'waiting'|'received'|'imported'|'failed', count, added }

function renderVocaMasterSend() {
  const box = $('#vm-send');
  const n = vmItems.length;
  const words = new Set(vmItems.map(e => `${e.language}\u0001${e.term.toLowerCase()}`)).size;
  const books = new Set(vmItems.map(e => e.book).filter(Boolean)).size;
  const langs = [...new Set(vmItems.map(e => e.language || '?'))].map(langName);
  const st = vmSend;
  const status = !st ? ''
    : st.status === 'waiting' ? 'Abriendo VocaMaster… (si te pide iniciar sesión, hazlo: las palabras esperan).'
    : st.status === 'received' ? `✓ VocaMaster ha recibido ${plural(st.count, 'entrada', 'entradas')}. Revísalas allí (etiquetas, quitar alguna…) y pulsa «Añadir a VocaMaster».`
    : st.status === 'imported' ? `✓ VocaMaster ha añadido ${plural(st.added, 'palabra o frase', 'palabras o frases')}: aquí quedan marcadas como «Enviada».`
    : 'No he podido pasárselas a VocaMaster (¿bloqueó el navegador la ventana nueva?). Vuelve a pulsar el botón o usa «Copiar y pegar a mano».';
  box.innerHTML = n
    ? `<p class="vm-summary">${plural(words, 'palabra', 'palabras')}${n > words ? ` con ${plural(n, 'frase', 'frases')}` : ''}${books ? `, de ${plural(books, 'libro', 'libros')}` : ''} · ${esc(langs.join(', '))}.</p>
       <p class="hint">Se abre VocaMaster con estas palabras en una vista previa: allí ves qué hará con cada una (nueva, frase de ejemplo para una que ya tienes o repetida), les pones o quitas etiquetas —por defecto, el libro y «kindle»—, varias a la vez si quieres, y pulsas «Añadir». Su IA pone la traducción y la definición del sentido de la frase.</p>
       <button class="btn btn-primary" id="vm-send-btn"${st && st.status === 'waiting' ? ' disabled' : ''}>📤 Abrir VocaMaster y enviar</button>
       ${status ? `<p class="vm-send-status ${st.status}">${esc(status)}</p>` : ''}`
    : `<div class="empty"><p>No hay palabras nuevas que enviar con estos filtros.${$('#vm-include-sent').checked ? '' : ' Si quieres repetir las ya enviadas, marca «Incluir las ya enviadas».'}</p></div>`;
  const btn = $('#vm-send-btn');
  if (btn) btn.onclick = sendToVocaMaster;
}

function sendToVocaMaster() {
  if (!vmItems.length) return;
  const url = vocamasterUrl();
  const origin = new URL(url).origin;
  const id = `kv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const payload = { id, sentAt: new Date().toISOString(), items: vmItems };
  // Ventana con nombre: si ya se abrió antes desde aquí, se reutiliza esa pestaña.
  const w = window.open(url, 'vocamaster');
  vmSend = { id, status: w ? 'waiting' : 'failed', count: vmItems.length, added: 0 };
  renderVocaMasterSend();
  if (!w) return;
  // VocaMaster tarda en cargar (y puede pedir iniciar sesión): se repite hasta que conteste.
  let tries = 0;
  const timer = setInterval(() => {
    if (!vmSend || vmSend.id !== id || vmSend.status !== 'waiting') { clearInterval(timer); return; }
    if (w.closed || ++tries > 240) { clearInterval(timer); vmSend.status = 'failed'; renderVocaMasterSend(); return; }
    try { w.postMessage({ source: 'kindlevault', type: 'vocab-send', payload }, origin); } catch { /* aún cargando */ }
  }, 500);
}

window.addEventListener('message', async e => {
  let origin;
  try { origin = new URL(vocamasterUrl()).origin; } catch { return; }
  if (e.origin !== origin || !e.data || e.data.source !== 'vocamaster') return;
  if (e.data.type === 'vocab-received' && vmSend && e.data.id === vmSend.id) {
    vmSend.status = 'received';
    renderVocaMasterSend();
  } else if (e.data.type === 'vocab-imported' && Array.isArray(e.data.keys)) {
    const keys = [...new Set(e.data.keys.filter(k => typeof k === 'string'))]
      .filter(k => { const st = lib.wordStatus.get(k); return !st || !st.status; });
    if (keys.length) await setWordStatus(keys, 'sent');
    if (vmSend) { vmSend.status = 'imported'; vmSend.added = e.data.keys.length; }
    if (!$('#vocamaster-dialog').classList.contains('hidden')) renderVocaMaster();
    toast(`✓ VocaMaster ha añadido ${plural(e.data.keys.length, 'palabra o frase', 'palabras o frases')}: marcadas como «Enviada»`);
  }
});

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
  // Un envío anterior ya terminado no se enseña al volver a abrir.
  if (vmSend && !['waiting', 'received'].includes(vmSend.status)) vmSend = null;
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
  hydrateIcons();
  applyTheme(currentTheme());
  $('#btn-theme').onclick = () => applyTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length]);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(currentTheme()));

  // Navegación
  $$('[data-tab]').forEach(t => t.addEventListener('click', () => {
    if (t.dataset.tab === 'vocab' && state.tab !== 'vocab') state.wordKey = null;
    setTab(t.dataset.tab);
  }));
  $('#btn-back').onclick = () => setTab(state.prevTab || 'books');
  $('#btn-menu').onclick = () => $('#rail').classList.add('open');
  $('#rail-scrim').onclick = () => $('#rail').classList.remove('open');
  $('#btn-search').onclick = openPalette;
  $('#btn-search-m').onclick = openPalette;
  $('#btn-import-m').onclick = () => openDialog('import-dialog');

  // Buscar en la lista y ordenar
  $('#search').addEventListener('input', e => {
    state.search = e.target.value.trim();
    clearTimeout(wire._t);
    wire._t = setTimeout(reload, 200);
  });
  $('#sort').addEventListener('change', e => { state.sort[state.tab] = e.target.value; reload(); });

  // Filtros
  $('#filters').addEventListener('click', e => {
    const view = e.target.closest('[data-book-view]');
    if (view) { state.bookView = view.dataset.bookView; renderToolbar(); reload(); return; }
    const c = e.target.closest('[data-chip]');
    if (c) openFilter(c);
  });
  $('#active-filters').addEventListener('click', e => {
    const b = e.target.closest('[data-unfilter]');
    if (b) unfilter(b.dataset.unfilter);
  });
  document.addEventListener('mousedown', e => {
    if (popoverFor && !e.target.closest('#popover') && !e.target.closest('[data-chip]')) closePopover();
  });
  window.addEventListener('resize', closePopover);
  $('#results').addEventListener('scroll', () => {
    closePopover();
    // Lo que llegó mientras se leía más abajo, al volver arriba.
    if (refreshPending && $('#results').scrollTop < 120) refreshSoft();
  }, { passive: true });

  // Buscador (Ctrl+K)
  $('#palette-input').addEventListener('input', e => renderPalette(e.target.value));
  $('#palette-input').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { paletteIndex = Math.min(paletteItems.length - 1, paletteIndex + 1); paintPalette(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { paletteIndex = Math.max(0, paletteIndex - 1); paintPalette(); e.preventDefault(); }
    else if (e.key === 'Enter') { runPaletteItem(paletteIndex); e.preventDefault(); }
  });
  $('#palette-results').addEventListener('click', e => {
    const it = e.target.closest('[data-pi]');
    if (it) runPaletteItem(+it.dataset.pi);
  });
  $('#palette-results').addEventListener('mousemove', e => {
    const it = e.target.closest('[data-pi]');
    if (it && +it.dataset.pi !== paletteIndex) { paletteIndex = +it.dataset.pi; paintPalette(); }
  });

  $('#btn-import').onclick = () => { $('#rail').classList.remove('open'); openDialog('import-dialog'); };
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
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  document.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', async e => {
    dragDepth = 0;
    document.body.classList.remove('dragging');
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
    $('#rail').classList.remove('open');
    if (sync.state === 'needs-permission') syncInteractive();
    else openSyncDialog();
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
  $('#vm-by-book').onchange = renderVocaMaster;
  $('#vm-all-sentences').onchange = renderVocaMaster;
  $$('input[name="vm-scope"]').forEach(r => { r.onchange = renderVocaMaster; });
  $('#selection-bar').addEventListener('click', e => {
    const btn = e.target.closest('[data-sel-act]');
    if (btn) selectionAction(btn.dataset.selAct);
  });
  // En táctil, mantener pulsada una casilla elige el tramo desde la última (como Mayús+clic).
  let pulsando = null, pulsadaLarga = null;
  const soltar = () => { if (pulsando) { clearTimeout(pulsando); pulsando = null; } };
  $('#results').addEventListener('pointerdown', e => {
    pulsadaLarga = null; // (si tras la pulsación larga no llegó el clic, no se come el siguiente toque)
    const cb = e.target.closest('.v-cb');
    if (!cb || e.pointerType === 'mouse') return;
    soltar();
    pulsando = setTimeout(() => {
      pulsando = null;
      if (state.lastChecked === null || state.lastChecked === +cb.dataset.i) return;
      pulsadaLarga = cb;
      cb.checked = true;
      toggleWordCheckbox(cb, true);
      if (navigator.vibrate) navigator.vibrate(12);
    }, 450);
  });
  ['pointerup', 'pointercancel', 'pointermove'].forEach(ev => $('#results').addEventListener(ev, e => {
    if (ev !== 'pointermove' || (e.movementX * e.movementX + e.movementY * e.movementY) > 16) soltar();
  }));
  $('#results').addEventListener('contextmenu', e => { if (e.target.closest('.v-cb')) e.preventDefault(); });
  $('#results').addEventListener('click', e => {
    const t = e.target;
    const cb = t.closest('.v-cb');
    if (cb && pulsadaLarga === cb) { pulsadaLarga = null; e.preventDefault(); return; } // ya elegido el tramo
    if (cb) { toggleWordCheckbox(cb, e.shiftKey); return; }
    const el = t.closest('[data-speak], [data-translate], [data-times], [data-word-act], [data-copy], [data-open-book], [data-go], [data-book-act], [data-book-tab], [data-book-key], .word-chip[data-wkey]');
    if (!el) return;
    const d = el.dataset;
    if ('speak' in d) speakFromCard(el);
    else if ('translate' in d) translateFromCard(el);
    else if ('times' in d) toggleTimesList(el);
    else if ('copy' in d) copyFromCard(el);
    else if ('wordAct' in d) setWordStatus([el.closest('.v-card').dataset.wkey], d.wordAct === 'clear' ? null : d.wordAct);
    else if ('openBook' in d) openBook(d.openBook, isWordList() ? 'vocab' : 'highlights');
    else if ('go' in d) go(d.go);
    else if ('bookAct' in d) bookAction(d.bookAct);
    else if ('bookTab' in d) { state.bookTab = d.bookTab; setSearch(''); state.selectedWords.clear(); renderBook(); }
    else if ('bookKey' in d) {
      const b = lib.listBooks().find(x => x.key === d.bookKey);
      openBook(d.bookKey, b && !b.highlights_count && b.vocab_count ? 'vocab' : 'highlights', { flash: d.flash || null });
    } else if ('wkey' in d) {
      state.selectedBooks.clear(); state.selectedLangs.clear(); state.repeatedOnly = false;
      state.wordKey = d.wkey;
      setTab('vocab');
    }
  });
  $('#results').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const card = e.target.closest('.book-card[data-book-key]');
    if (card) card.click();
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
      toast('Para copiar un mapa, filtra un solo libro (o usa «Descargar»: un archivo por libro)');
      return;
    }
    try { await navigator.clipboard.writeText(ex.maps ? (ex.maps[0] ? ex.maps[0].content : '') : ex.content); toast('✓ Copiado al portapapeles'); }
    catch { toast('No se pudo copiar; usa “Descargar archivo”'); }
  };

  $$('[data-close]').forEach(b => { b.onclick = () => closeDialog(b.dataset.close); });
  $$('.dialog-backdrop').forEach(d => d.addEventListener('mousedown', e => { if (e.target === d) d.classList.add('hidden'); }));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (popoverFor) { closePopover(); return; }
      $$('.dialog-backdrop').forEach(d => d.classList.add('hidden'));
      $('#rail').classList.remove('open');
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    else if (e.key === '/' && !typing) {
      e.preventDefault();
      if (!$('#toolbar').classList.contains('hidden')) $('#search').focus();
      else if ($('#book-q')) $('#book-q').focus();
      else openPalette();
    }
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
  // El archivo y el código no cruzan nunca a la vez; lo que trae uno se pasa al otro.
  const cerrojo = crearCerrojo();
  sync = new SyncManager(lib, {
    onStatus: renderSyncPill,
    onMerged: () => { refreshSoft(); fetchCovers(); nube.schedule(); },
    cerrojo,
  });
  nube = new NubeSync(lib, {
    onStatus: renderSyncPill,
    onMerged: () => {
      refreshSoft(); fetchCovers(); sync.schedule();
      if (document.visibilityState === 'visible' && $('#sync-dialog').classList.contains('hidden')) toast('↓ Cambios de tu otro equipo, ya aquí');
    },
    cerrojo,
  });
  wire();
  refreshAll();
  renderRescanButtons();
  nube.init().catch(e => console.error(e));
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
