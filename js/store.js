// Biblioteca local: libros, subrayados y vocabulario, persistidos en IndexedDB.
import { detectLanguage } from './parser.js';

// ---------- IndexedDB mínima (clave → valor) ----------
const DB_NAME = 'kindlevault';
let dbPromise = null;
function idb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
export async function kvGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('kv').objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function kvSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    if (value === undefined) tx.objectStore('kv').delete(key);
    else tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- Normalización ----------
const norm = s => (s || '').normalize('NFC').replace(/\s+/g, ' ').trim();
const fold = s => norm(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
export const bookKey = (title, author) => `${fold(title)}\u0001${fold(author)}`;

/**
 * Título sin paréntesis ni puntuación (full) y su parte principal, antes de
 * un subtítulo tras «:», «;», « - » o «. » (main). Sirve para casar el mismo
 * libro escrito de formas distintas en My Clippings, vocab.db, los nombres de
 * archivo y Amazon.
 */
function titleParts(title) {
  const f = fold(title).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  const bare = s => s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return { full: bare(f), main: bare(f.split(/\s*[:;]\s*|\s+[-–—]\s+|\.\s+/)[0]) };
}

/**
 * ¿Es el mismo libro? Igual título, o uno es el título principal del otro sin
 * subtítulo: «Sapiens» = «Sapiens: De animales a dioses» = «Sapiens (Spanish
 * Edition)». Pero «Dune» ≠ «Dune Messiah», «Harry Potter» ≠ «Harry Potter y la
 * piedra filosofal» y «El señor de los anillos: Las dos torres» ≠ «…: El
 * retorno del rey»: empezar igual no basta.
 */
function sameTitle(a, b) {
  if (a.full.length < 2 || b.full.length < 2) return false;
  if (a.full === b.full) return true;
  const aPlain = a.full === a.main, bPlain = b.full === b.main;
  return (aPlain && a.full === b.main) || (bPlain && b.full === a.main);
}
const authorWords = a => new Set(fold(a).split(/[^\p{L}]+/u).filter(w => w.length > 2));
function authorsCompatible(a, b) {
  if (!a || !b) return true;
  const A = authorWords(a), B = authorWords(b);
  if (!A.size || !B.size) return true;
  for (const w of A) if (B.has(w)) return true;
  return false;
}

export const USEFUL_TYPES = new Set(['highlight', 'note']);

/** Estados que el usuario da a una palabra del vocabulario. */
export const WORD_STATUSES = ['sent', 'known', 'ignored'];

/**
 * Clave de estado de una palabra: idioma + forma base. Así «ran» y «running»
 * comparten estado con «run», y marcar una vale para todas sus búsquedas.
 */
export const wordKey = v => `${v.language || '?'}\u0001${norm(v.stem || v.word).toLowerCase()}`;

/** Posición de un subrayado para compararlo con otros del mismo libro. */
function span(h) {
  if (h.location_start != null) return { unit: 'loc', a: h.location_start, b: h.location_end ?? h.location_start };
  if (h.page != null) return { unit: 'page', a: h.page, b: h.page };
  return null;
}
const overlaps = (x, y) => x && y && x.unit === y.unit && x.a <= y.b && y.a <= x.b;
const compact = s => fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export class Library {
  constructor() {
    this.books = new Map();      // key → {key,title,author,language,cover_url}
    this.highlights = new Map(); // hash → {...,bookKey}
    this.vocab = new Map();      // key → {...,bookKey}
    this.wordStatus = new Map(); // wordKey → {status: 'sent'|'known'|'ignored'|null, at, source?}
    this.device = null;          // último inventario del Kindle: {scannedAt, keys:[bookKey], files, unresolved}
    this.updatedAt = null;
    this._derivedCache = null;
  }

  // ----- serialización -----
  toJSON() {
    return {
      format: 'kindlevault-sync',
      version: 1,
      savedAt: new Date().toISOString(),
      books: [...this.books.values()],
      highlights: [...this.highlights.values()],
      vocab: [...this.vocab.values()],
      wordStatus: [...this.wordStatus.entries()].map(([key, v]) => ({ key, ...v })),
      device: this.device,
    };
  }
  static fromJSON(data) {
    const lib = new Library();
    if (data) lib.merge(data);
    return lib;
  }
  async save() {
    this.updatedAt = new Date().toISOString();
    await kvSet('library', this.toJSON());
  }
  static async load() {
    return Library.fromJSON(await kvGet('library'));
  }
  clear() {
    this.books.clear(); this.highlights.clear(); this.vocab.clear(); this.wordStatus.clear();
    this.device = null;
    this._derivedCache = null;
  }

  // ----- libros -----
  _mergeBookFields(target, src) {
    let changed = false;
    if (!target.author && src.author) { target.author = src.author; changed = true; }
    if (!target.language && src.language) { target.language = src.language; changed = true; }
    if (!target.asin && src.asin) { target.asin = src.asin; changed = true; }
    if (!target.in_cloud && src.in_cloud) { target.in_cloud = true; changed = true; }
    const rank = u => (!u ? 0 : u === '__not_found__' ? 1 : 2);
    if (rank(src.cover_url) > rank(target.cover_url)) { target.cover_url = src.cover_url; changed = true; }
    return changed;
  }

  /** Por ASIN; si además se da el título, tiene que cuadrar (un ASIN mal asignado antes no manda). */
  findBookByAsin(asin, title = null) {
    if (!asin) return null;
    const t = title ? titleParts(title) : null;
    for (const b of this.books.values()) {
      if (b.asin === asin && (!t || sameTitle(t, titleParts(b.title)))) return b;
    }
    return null;
  }

  findBook(title, author) {
    const exact = this.books.get(bookKey(title, author));
    if (exact) return exact;
    const t = titleParts(title);
    for (const b of this.books.values()) {
      if (sameTitle(t, titleParts(b.title)) && authorsCompatible(b.author, author)) return b;
    }
    return null;
  }

  findOrCreateBook(title, author, language = null, asin = null) {
    let b = this.findBookByAsin(asin, title) || this.findBook(title, author);
    if (b) {
      this._mergeBookFields(b, { author, language, asin });
      return b;
    }
    const key = bookKey(title, author);
    b = { key, title: norm(title), author: norm(author) || null, language: language || null, asin: asin || null, cover_url: null };
    this.books.set(key, b);
    return b;
  }

  // ----- importación desde el Kindle -----
  /**
   * Lo que ya estaba se vuelve a colocar en su libro: así, al volver a leer
   * el Kindle, se corrigen subrayados que una versión anterior metió en otro
   * libro de título parecido. (bookAt: fecha de esa corrección, para que la
   * sincronización la lleve a los demás ordenadores.)
   */
  importHighlights(items) {
    let added = 0, dup = 0, moved = 0;
    for (const h of items) {
      const book = this.findOrCreateBook(h.bookTitle, h.author);
      const old = this.highlights.get(h.hash);
      if (old) {
        dup++;
        if (old.bookKey !== book.key) { old.bookKey = book.key; old.bookAt = new Date().toISOString(); moved++; }
        continue;
      }
      const { bookTitle, author, ...rest } = h;
      this.highlights.set(h.hash, { ...rest, bookKey: book.key });
      added++;
    }
    if (moved) this._derivedCache = null;
    return { added, dup, moved };
  }

  importVocab(entries) {
    let added = 0;
    for (const v of entries) {
      let book = null;
      if (v.book_title) book = this.findOrCreateBook(v.book_title, v.book_authors, v.book_lang, v.book_asin);
      const old = this.vocab.get(v.key);
      if (old) {
        const key = book ? book.key : null;
        if (old.bookKey !== key) { old.bookKey = key; old.bookAt = new Date().toISOString(); }
        if (v.mastered !== undefined) old.mastered = v.mastered;
        continue;
      }
      const { book_authors, book_lang, book_asin, ...rest } = v;
      this.vocab.set(v.key, { ...rest, bookKey: book ? book.key : null });
      added++;
    }
    // Lo que el Kindle ya da por aprendido entra como «Me la sé», pero con la
    // fecha de la búsqueda: cualquier decisión tuya posterior manda sobre ella.
    for (const v of entries) {
      if (!v.mastered) continue;
      const k = wordKey(v);
      if (!this.wordStatus.has(k)) this.wordStatus.set(k, { status: 'known', at: v.looked_up_at || '1970-01-01T00:00:00.000Z', source: 'kindle' });
    }
    return added;
  }

  // ----- libros que hay en el Kindle -----
  /**
   * Registra el inventario del Kindle: cada libro encontrado se casa con uno
   * de la biblioteca (por ASIN o por título) o se añade, aunque no tenga
   * subrayados, para que se vea que está ahí. Los que solo tienen un código
   * (sin título legible) se cuentan aparte.
   */
  applyDeviceInventory(files) {
    const keys = new Set();
    const unresolved = new Set();
    const counts = {};
    const before = new Set(this.device ? this.device.keys : []);
    let created = 0;
    for (const f of files) {
      let b = this.findBookByAsin(f.asin, f.title);
      if (!b && f.title) {
        const n = this.books.size;
        b = this.findOrCreateBook(f.title, f.author, f.language ? f.language.split('-')[0] : null, f.asin);
        if (this.books.size > n) created++;
      }
      if (!b) { unresolved.add(f.asin || f.file); continue; }
      keys.add(b.key);
      // Anotaciones que el Kindle guarda del libro (en su carpeta .sdr), vengan de donde vengan.
      if (f.annotations) {
        const c = counts[b.key] || { highlights: 0, notes: 0, bookmarks: 0 };
        for (const k of Object.keys(c)) c[k] = Math.max(c[k], f.annotations[k] || 0);
        counts[b.key] = c;
      }
    }
    const hadInventory = !!this.device;
    this.device = { scannedAt: new Date().toISOString(), keys: [...keys], files: files.length, unresolved: [...unresolved], counts };
    return {
      books: keys.size, created, unresolved: unresolved.size,
      arrived: hadInventory ? [...keys].filter(k => !before.has(k)) : [],
      left: hadInventory ? [...before].filter(k => !keys.has(k)) : [],
    };
  }

  isOnDevice(key) { return !!(this.device && this.device.keys.includes(key)); }
  deviceCounts(key) { return (this.device && this.device.counts && this.device.counts[key]) || null; }

  // ----- estado de las palabras -----
  getWordStatus(v) {
    const s = this.wordStatus.get(wordKey(v));
    return (s && s.status) || null;
  }

  /** status null = quitar la marca (se guarda como tal para que la sincronización lo respete). */
  setWordStatus(key, status) {
    this.wordStatus.set(key, { status: status || null, at: new Date().toISOString() });
  }

  // ----- relaciones calculadas: versiones anteriores y notas -----
  /**
   * Al ampliar un subrayado, el Kindle añade uno nuevo a My Clippings y deja
   * también el corto. Se marca como «versión anterior» el subrayado cuyo texto
   * está dentro de otro que se solapa con él (o que repite exactamente el de
   * otro del mismo libro). Además, cada nota se une al subrayado en cuya
   * posición se escribió. Nada de esto se guarda: se recalcula de los datos.
   */
  _derived() {
    const sig = this.highlights.size;
    if (this._derivedCache && this._derivedCache.sig === sig) return this._derivedCache;
    const superseded = new Set();
    const notesByHighlight = new Map(); // hash subrayado → [notas]
    const noteParent = new Map();       // hash nota → subrayado

    const byBook = new Map();
    for (const h of this.highlights.values()) {
      if (!USEFUL_TYPES.has(h.type)) continue;
      if (!byBook.has(h.bookKey)) byBook.set(h.bookKey, { hl: [], notes: [] });
      const g = byBook.get(h.bookKey);
      (h.type === 'note' ? g.notes : g.hl).push({ h, s: span(h), t: compact(h.content) });
    }

    const older = (x, y) => (x.h.highlighted_at || '') <= (y.h.highlighted_at || '') ? x : y;
    // Entre dos copias del mismo subrayado (p. ej. del Kindle y de la nube), se
    // queda la que tiene más datos: con fecha y con el tramo de posiciones.
    const poorer = (x, y) => {
      const rich = z => (z.h.highlighted_at ? 2 : 0) + (z.h.location_end != null ? 1 : 0);
      return rich(x) !== rich(y) ? (rich(x) < rich(y) ? x : y) : older(x, y);
    };
    for (const { hl, notes } of byBook.values()) {
      // Mismo texto exacto (y no muy corto): duplicado aunque cambie la posición.
      const sameText = new Map();
      for (const x of hl) {
        if (x.t.length < 20) continue;
        const prev = sameText.get(x.t);
        if (prev) {
          const old = poorer(prev, x);
          superseded.add(old.h.hash);
          sameText.set(x.t, old === prev ? x : prev);
        } else sameText.set(x.t, x);
      }
      // Solapados: el corto está dentro del largo.
      const located = hl.filter(x => x.s && x.t).sort((x, y) =>
        x.s.unit.localeCompare(y.s.unit) || x.s.a - y.s.a);
      for (let i = 0; i < located.length; i++) {
        const x = located[i];
        for (let j = i + 1; j < located.length; j++) {
          const y = located[j];
          if (y.s.unit !== x.s.unit || y.s.a > x.s.b) break;
          if (!overlaps(x.s, y.s)) continue;
          if (x.t === y.t) superseded.add(poorer(x, y).h.hash);
          else if (y.t.includes(x.t)) superseded.add(x.h.hash);
          else if (x.t.includes(y.t)) superseded.add(y.h.hash);
        }
      }
      // Notas: al subrayado que contiene su posición; mejor si acaba justo ahí,
      // y entre empates, el de fecha más cercana.
      const alive = hl.filter(x => x.s && !superseded.has(x.h.hash));
      const time = x => Date.parse(x.h.highlighted_at || '') || 0;
      // La misma nota llegada por dos vías: se queda una.
      const seenNotes = [];
      for (const n of notes) {
        // (Amazon sitúa la nota al principio del subrayado y el Kindle al final: basta el mismo texto en el mismo libro.)
        const twin = n.t && seenNotes.find(m => m.t === n.t);
        if (twin) { const p = poorer(twin, n); superseded.add(p.h.hash); if (p === twin) seenNotes[seenNotes.indexOf(twin)] = n; }
        else seenNotes.push(n);
      }
      for (const n of notes) {
        if (!n.s || superseded.has(n.h.hash)) continue;
        let best = null, bestScore = Infinity;
        for (const x of alive) {
          if (x.s.unit !== n.s.unit || n.s.a < x.s.a || n.s.a > x.s.b) continue;
          const score = (x.s.b === n.s.a ? 0 : 1e12) + Math.abs(time(x) - time(n));
          if (score < bestScore) { best = x; bestScore = score; }
        }
        if (!best) continue;
        noteParent.set(n.h.hash, best.h);
        if (!notesByHighlight.has(best.h.hash)) notesByHighlight.set(best.h.hash, []);
        notesByHighlight.get(best.h.hash).push(n.h);
      }
    }
    this._derivedCache = { sig, superseded, notesByHighlight, noteParent };
    return this._derivedCache;
  }

  supersededCount() { return this._derived().superseded.size; }

  /** Tipo con el que se filtra: las versiones anteriores tienen el suyo. */
  _kind(h, d = this._derived()) {
    return d.superseded.has(h.hash) ? 'superseded' : h.type;
  }

  /** Asigna idioma a los libros que no lo tienen, mirando el texto de sus subrayados. */
  guessMissingLanguages() {
    const texts = new Map();
    for (const h of this.highlights.values()) {
      if (!USEFUL_TYPES.has(h.type)) continue;
      if (!texts.has(h.bookKey)) texts.set(h.bookKey, []);
      texts.get(h.bookKey).push(h.content);
    }
    for (const b of this.books.values()) {
      if (b.language) continue;
      const lang = detectLanguage(texts.get(b.key) || []);
      if (lang) b.language = lang;
    }
  }

  // ----- combinación (sincronización) -----
  /** Une los datos de otro origen. Devuelve true si algo cambió aquí. */
  merge(data) {
    let changed = false;
    const remap = new Map(); // clave de libro remota → clave local
    for (const rb of data.books || []) {
      const local = this.books.get(rb.key) || this.findBook(rb.title, rb.author);
      if (local) {
        remap.set(rb.key, local.key);
        if (this._mergeBookFields(local, rb)) changed = true;
      } else {
        this.books.set(rb.key, { ...rb });
        remap.set(rb.key, rb.key);
        changed = true;
      }
    }
    for (const h of data.highlights || []) {
      const old = this.highlights.get(h.hash);
      if (old) {
        // Una corrección de libro hecha en otro ordenador, más reciente, manda.
        if (h.bookAt && (h.bookAt > (old.bookAt || ''))) {
          old.bookKey = remap.get(h.bookKey) || h.bookKey; old.bookAt = h.bookAt;
          this._derivedCache = null; changed = true;
        }
        continue;
      }
      this.highlights.set(h.hash, { ...h, bookKey: remap.get(h.bookKey) || h.bookKey });
      changed = true;
    }
    for (const v of data.vocab || []) {
      const old = this.vocab.get(v.key);
      if (old) {
        if (v.bookAt && (v.bookAt > (old.bookAt || ''))) {
          old.bookKey = v.bookKey ? (remap.get(v.bookKey) || v.bookKey) : null; old.bookAt = v.bookAt; changed = true;
        }
        continue;
      }
      this.vocab.set(v.key, { ...v, bookKey: v.bookKey ? (remap.get(v.bookKey) || v.bookKey) : null });
      changed = true;
    }
    // Inventario del Kindle: vale el más reciente.
    if (data.device && (!this.device || (data.device.scannedAt || '') > (this.device.scannedAt || ''))) {
      this.device = { ...data.device, keys: (data.device.keys || []).map(k => remap.get(k) || k) };
      changed = true;
    }
    // Estados de palabras: gana el cambio más reciente.
    for (const ws of data.wordStatus || []) {
      const { key, ...rest } = ws;
      const local = this.wordStatus.get(key);
      if (local && (local.at || '') >= (rest.at || '')) continue;
      this.wordStatus.set(key, rest);
      changed = true;
    }
    return changed;
  }

  // ----- consultas -----
  stats() {
    const d = this._derived();
    let useful = 0;
    for (const h of this.highlights.values()) if (USEFUL_TYPES.has(h.type) && !d.superseded.has(h.hash)) useful++;
    return { books: this.listBooks().length, highlights: useful, highlights_total: this.highlights.size, vocab: this.vocab.size };
  }

  listBooks() {
    const d = this._derived();
    const counts = new Map();
    for (const h of this.highlights.values()) {
      const c = counts.get(h.bookKey) || { useful: 0, total: 0, vocab: 0, hl: 0 };
      c.total++;
      if (USEFUL_TYPES.has(h.type) && !d.superseded.has(h.hash)) c.useful++;
      if (h.type === 'highlight' && !d.superseded.has(h.hash)) c.hl++;
      counts.set(h.bookKey, c);
    }
    for (const v of this.vocab.values()) {
      if (!v.bookKey) continue;
      const c = counts.get(v.bookKey) || { useful: 0, total: 0, vocab: 0, hl: 0 };
      c.vocab++;
      counts.set(v.bookKey, c);
    }
    return [...this.books.values()]
      .map(b => {
        const c = counts.get(b.key) || { useful: 0, total: 0, vocab: 0, hl: 0 };
        return { ...b, highlights_count: c.useful, hl_count: c.hl, total_count: c.total, vocab_count: c.vocab, on_device: this.isOnDevice(b.key), device_counts: this.deviceCounts(b.key) };
      })
      // Un libro sin nada (p. ej. el que quedó vacío al separar dos títulos
      // parecidos) no se enseña, salvo que esté en el Kindle o en la nube.
      .filter(b => b.total_count || b.vocab_count || b.on_device || b.in_cloud)
      .sort((a, b) => a.title.localeCompare(b.title, 'es', { sensitivity: 'base' }));
  }

  listLanguages() {
    const counts = new Map();
    for (const b of this.books.values()) {
      const l = b.language || '?';
      counts.set(l, (counts.get(l) || 0) + 1);
    }
    return [...counts.entries()].map(([lang, count]) => ({ lang, count })).sort((a, b) => b.count - a.count);
  }

  _bookMatches(bk, f) {
    if (f.bookKeys && f.bookKeys.size && !f.bookKeys.has(bk)) return false;
    if (f.languages && f.languages.size) {
      const b = this.books.get(bk);
      if (!f.languages.has((b && b.language) || '?')) return false;
    }
    return true;
  }

  /**
   * Con subrayados y notas a la vez, cada nota emparejada va dentro de su
   * subrayado (campo notes) en vez de aparecer suelta. Con solo notas, cada
   * una lleva el texto de su subrayado en parent.
   */
  filterHighlights(f = {}) {
    const d = this._derived();
    const q = f.search ? fold(f.search) : null;
    const withNotes = !f.types || f.types.has('note');
    const nested = withNotes && (!f.types || f.types.has('highlight'));
    const out = [];
    for (const h of this.highlights.values()) {
      const kind = this._kind(h, d);
      if (f.types && !f.types.has(kind)) continue;
      if (!this._bookMatches(h.bookKey, f)) continue;
      const parent = h.type === 'note' ? d.noteParent.get(h.hash) || null : null;
      if (nested && parent) continue;
      const notes = (withNotes && kind === 'highlight' && d.notesByHighlight.get(h.hash)) || [];
      if (q && !fold(h.content).includes(q) && !notes.some(n => fold(n.content).includes(q))) continue;
      const b = this.books.get(h.bookKey) || {};
      out.push({
        ...h,
        superseded: kind === 'superseded',
        notes: notes.map(n => ({ content: n.content, highlighted_at: n.highlighted_at })),
        parent: parent ? parent.content : null,
        title: b.title || '?', author: b.author || null, language: b.language || null,
      });
    }
    return out.sort((a, b) =>
      a.title.localeCompare(b.title, 'es', { sensitivity: 'base' }) ||
      (a.location_start ?? a.page ?? 0) - (b.location_start ?? b.page ?? 0));
  }

  filterVocab(f = {}) {
    const q = f.search ? fold(f.search) : null;
    const out = [];
    for (const v of this.vocab.values()) {
      if (f.bookKeys && f.bookKeys.size && !f.bookKeys.has(v.bookKey)) continue;
      if (f.languages && f.languages.size) {
        const b = this.books.get(v.bookKey);
        const lang = v.language || (b && b.language) || '?';
        if (!f.languages.has(lang)) continue;
      }
      if (q && !fold(v.word).includes(q) && !fold(v.context).includes(q)) continue;
      const status = this.getWordStatus(v);
      if (f.statuses && !f.statuses.has(status || 'new')) continue;
      const b = this.books.get(v.bookKey);
      out.push({ ...v, status, wkey: wordKey(v), book_title: (b && b.title) || v.book_title || null });
    }
    return out.sort((a, b) => (b.looked_up_at || '').localeCompare(a.looked_up_at || ''));
  }

  /** Cuántas búsquedas hay en cada estado (para el filtro lateral). */
  vocabStatusCounts() {
    const c = { new: 0, sent: 0, known: 0, ignored: 0 };
    for (const v of this.vocab.values()) c[this.getWordStatus(v) || 'new']++;
    return c;
  }

  booksWithoutCover() {
    return [...this.books.values()].filter(b => !b.cover_url);
  }
}
