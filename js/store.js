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

/** Título sin paréntesis ni puntuación, para casar vocab.db con My Clippings. */
function bareTitle(title) {
  return fold(title)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
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

export class Library {
  constructor() {
    this.books = new Map();      // key → {key,title,author,language,cover_url}
    this.highlights = new Map(); // hash → {...,bookKey}
    this.vocab = new Map();      // key → {...,bookKey}
    this.updatedAt = null;
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
    this.books.clear(); this.highlights.clear(); this.vocab.clear();
  }

  // ----- libros -----
  _mergeBookFields(target, src) {
    let changed = false;
    if (!target.author && src.author) { target.author = src.author; changed = true; }
    if (!target.language && src.language) { target.language = src.language; changed = true; }
    const rank = u => (!u ? 0 : u === '__not_found__' ? 1 : 2);
    if (rank(src.cover_url) > rank(target.cover_url)) { target.cover_url = src.cover_url; changed = true; }
    return changed;
  }

  findBook(title, author) {
    const exact = this.books.get(bookKey(title, author));
    if (exact) return exact;
    // Coincidencia aproximada: un título es prefijo del otro una vez quitados
    // paréntesis como "(Spanish Edition)". Así "Sapiens" (vocab.db) casa con
    // "Sapiens: A Brief History of Humankind" (My Clippings), pero
    // "Inversión: Claves…" no se confunde con "Inversión: Guía…".
    const t = bareTitle(title);
    if (t.length < 3) return null;
    for (const b of this.books.values()) {
      const bt = bareTitle(b.title);
      if (bt.length < 3) continue;
      const prefix = bt === t || bt.startsWith(t + ' ') || t.startsWith(bt + ' ');
      if (prefix && authorsCompatible(b.author, author)) return b;
    }
    return null;
  }

  findOrCreateBook(title, author, language = null) {
    let b = this.findBook(title, author);
    if (b) {
      this._mergeBookFields(b, { author, language });
      return b;
    }
    const key = bookKey(title, author);
    b = { key, title: norm(title), author: norm(author) || null, language: language || null, cover_url: null };
    this.books.set(key, b);
    return b;
  }

  // ----- importación desde el Kindle -----
  importHighlights(items) {
    let added = 0, dup = 0;
    for (const h of items) {
      if (this.highlights.has(h.hash)) { dup++; continue; }
      const book = this.findOrCreateBook(h.bookTitle, h.author);
      const { bookTitle, author, ...rest } = h;
      this.highlights.set(h.hash, { ...rest, bookKey: book.key });
      added++;
    }
    return { added, dup };
  }

  importVocab(entries) {
    let added = 0;
    for (const v of entries) {
      let book = null;
      if (v.book_title) book = this.findOrCreateBook(v.book_title, v.book_authors, v.book_lang);
      if (this.vocab.has(v.key)) continue;
      const { book_authors, book_lang, ...rest } = v;
      this.vocab.set(v.key, { ...rest, bookKey: book ? book.key : null });
      added++;
    }
    return added;
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
      if (this.highlights.has(h.hash)) continue;
      this.highlights.set(h.hash, { ...h, bookKey: remap.get(h.bookKey) || h.bookKey });
      changed = true;
    }
    for (const v of data.vocab || []) {
      if (this.vocab.has(v.key)) continue;
      this.vocab.set(v.key, { ...v, bookKey: v.bookKey ? (remap.get(v.bookKey) || v.bookKey) : null });
      changed = true;
    }
    return changed;
  }

  // ----- consultas -----
  stats() {
    let useful = 0;
    for (const h of this.highlights.values()) if (USEFUL_TYPES.has(h.type)) useful++;
    return { books: this.books.size, highlights: useful, highlights_total: this.highlights.size, vocab: this.vocab.size };
  }

  listBooks() {
    const counts = new Map();
    for (const h of this.highlights.values()) {
      const c = counts.get(h.bookKey) || { useful: 0, total: 0, vocab: 0 };
      c.total++;
      if (USEFUL_TYPES.has(h.type)) c.useful++;
      counts.set(h.bookKey, c);
    }
    for (const v of this.vocab.values()) {
      if (!v.bookKey) continue;
      const c = counts.get(v.bookKey) || { useful: 0, total: 0, vocab: 0 };
      c.vocab++;
      counts.set(v.bookKey, c);
    }
    return [...this.books.values()]
      .map(b => {
        const c = counts.get(b.key) || { useful: 0, total: 0, vocab: 0 };
        return { ...b, highlights_count: c.useful, total_count: c.total, vocab_count: c.vocab };
      })
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

  filterHighlights(f = {}) {
    const q = f.search ? fold(f.search) : null;
    const out = [];
    for (const h of this.highlights.values()) {
      if (f.types && !f.types.has(h.type)) continue;
      if (!this._bookMatches(h.bookKey, f)) continue;
      if (q && !fold(h.content).includes(q)) continue;
      const b = this.books.get(h.bookKey) || {};
      out.push({ ...h, title: b.title || '?', author: b.author || null, language: b.language || null });
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
      const b = this.books.get(v.bookKey);
      out.push({ ...v, book_title: (b && b.title) || v.book_title || null });
    }
    return out.sort((a, b) => (b.looked_up_at || '').localeCompare(a.looked_up_at || ''));
  }

  booksWithoutCover() {
    return [...this.books.values()].filter(b => !b.cover_url);
  }
}
