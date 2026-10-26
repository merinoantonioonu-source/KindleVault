// Parser de "My Clippings.txt" y lector de vocab.db del Kindle.
import { SQLiteReader } from './sqlite-reader.js';

const SEPARATOR = '==========';

const TYPE_KEYWORDS = {
  note: ['note', 'nota', 'notiz', 'anmerkung', 'annotation', 'メモ', '笔记', '노트'],
  bookmark: ['bookmark', 'marcador', 'lesezeichen', 'signet', 'segnalibro', 'ブックマーク', '书签', '북마크'],
  highlight: ['highlight', 'subrayado', 'resaltado', 'markierung', 'surlignement',
    'evidenziazione', 'destacado', 'destaque', 'ハイライト', '标注', '하이라이트'],
};

const DRM_LIMIT_RE = new RegExp([
  '<\\s*you\\s+have\\s+reached\\s+the\\s+clipping\\s+limit\\s+for\\s+this\\s+item\\s*>',
  '<\\s*has\\s+llegado\\s+al\\s+l[íi]mite\\s+de\\s+recortes?\\s+para\\s+este\\s+elemento\\s*>',
  '<\\s*vous\\s+avez\\s+atteint\\s+la\\s+limite\\s+de\\s+coupures?',
  '<\\s*sie\\s+haben\\s+das\\s+ausschneidelimit',
].join('|'), 'i');

const TITLE_AUTHOR_RE = /^(.+?)\s*\(([^()]+)\)\s*$/;
const PAGE_RE = /(?:^|[^\p{L}])(?:page|p[áa]gina|seite|pagina|p\.)\s+(\d{1,7})/iu;

const MONTHS = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
  januar: 1, februar: 2, märz: 3, mai: 5, juni: 6, juli: 7, oktober: 10, dezember: 12,
  janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, juin: 6, juillet: 7, août: 8, aout: 8,
  septembre: 9, octobre: 10, novembre: 11, décembre: 12, decembre: 12,
  gennaio: 1, febbraio: 2, aprile: 4, maggio: 5, giugno: 6, luglio: 7, settembre: 9,
  ottobre: 10, dicembre: 12,
};
const MONTH_WORDS_RE = new RegExp(`(?:^|[^\\p{L}])(?:${Object.keys(MONTHS).join('|')})(?:$|[^\\p{L}])`, 'iu');

/** Hash rápido y estable (cyrb53) para identificar subrayados entre sincronizaciones. */
export function hash53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

export function decodeText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(b), encoding: 'utf-16le' };
  if (b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(b), encoding: 'utf-16be' };
  const text = new TextDecoder('utf-8').decode(b);
  return { text: text.replace(/^﻿/, ''), encoding: b[0] === 0xef && b[1] === 0xbb ? 'utf-8-sig' : 'utf-8' };
}

function inferType(meta) {
  const lower = meta.toLowerCase();
  for (const [type, words] of Object.entries(TYPE_KEYWORDS)) {
    if (words.some(w => lower.includes(w))) return type;
  }
  return 'highlight';
}

function extractLocation(meta) {
  const segments = meta.split('|');
  for (const seg of segments) {
    const m = seg.match(/(?<!\d)(\d{1,7})\s*[-–—]\s*(\d{1,7})(?!\d)/);
    if (m) return [Number(m[1]), Number(m[2])];
  }
  for (const seg of segments) {
    if (MONTH_WORDS_RE.test(seg) || /\d{1,2}:\d{2}:\d{2}/.test(seg)) continue;
    for (const m of seg.matchAll(/(?<!\d)(\d{1,7})(?!\d)/g)) {
      const n = Number(m[1]);
      if (n >= 1900 && n <= 2099 && seg.length < 25) continue;
      return [n, null];
    }
  }
  return [null, null];
}

function extractPage(meta) {
  const m = meta.match(PAGE_RE);
  return m ? Number(m[1]) : null;
}

/** Convierte "domingo, 31 de diciembre de 2023 1:02:52" (y equivalentes) a ISO local. */
export function parseKindleDate(meta) {
  const raw = (meta.includes('|') ? meta.slice(meta.lastIndexOf('|') + 1) : meta).trim();
  const time = raw.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?/);
  let day = null, month = null, year = null;
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) { year = +iso[1]; month = +iso[2]; day = +iso[3]; }
  else {
    const words = raw.toLowerCase().match(/[\p{L}]+/gu) || [];
    month = words.map(w => MONTHS[w]).find(Boolean) || null;
    const nums = (raw.replace(/\d{1,2}:\d{2}(:\d{2})?/, '').match(/\d+/g) || []).map(Number);
    year = nums.find(n => n >= 1990 && n <= 2100) || null;
    day = nums.find(n => n >= 1 && n <= 31 && n !== year) || null;
  }
  if (!day || !month || !year) return raw || null;
  let h = time ? +time[1] : 0;
  const mi = time ? +time[2] : 0, s = time && time[3] ? +time[3] : 0;
  if (time && time[4]) {
    const pm = /p/i.test(time[4]);
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  const p = n => String(n).padStart(2, '0');
  return `${year}-${p(month)}-${p(day)}T${p(h)}:${p(mi)}:${p(s)}`;
}

function parseBlock(block) {
  const lines = block.split(/\r?\n/).map(l => l.trim().replace(/^﻿/, '')).filter(Boolean);
  if (lines.length < 2) return [null, `Solo ${lines.length} línea(s) en el bloque (se esperaban al menos 2)`];
  const tm = lines[0].match(TITLE_AUTHOR_RE);
  const title = (tm ? tm[1] : lines[0]).trim();
  const author = tm ? tm[2].trim() : null;
  if (!title) return [null, 'Línea 1 vacía: sin título'];

  const meta = lines[1];
  let type = inferType(meta);
  const [locStart, locEnd] = extractLocation(meta);
  const page = extractPage(meta);
  if (locStart === null && page === null) {
    return [null, `Línea 2 sin ubicación ni página detectada: «${meta.slice(0, 120)}»`];
  }
  let content = lines.slice(2).join('\n').trim();
  // Aviso de Amazon en vez del texto: «<Has alcanzado el límite de recortes…>» y variantes.
  const limitNotice = /^<[^<>]{8,200}>$/.test(content) &&
    /(clipping|recorte|l[ií]mite|limite|limit|coupure|ausschneid|ritagli|destaque)/i.test(content);
  if (content && (DRM_LIMIT_RE.test(content) || limitNotice)) {
    content = '[DRM: límite de subrayado alcanzado]';
    type = 'dropped';
  } else if (!content) {
    if (type === 'bookmark') content = '[marcador de página]';
    else { content = '[contenido vacío]'; type = 'empty'; }
  }
  return [{
    bookTitle: title,
    author,
    type,
    content,
    location_start: locStart,
    location_end: locEnd,
    page,
    highlighted_at: parseKindleDate(meta),
  }, null];
}

/** Analiza el texto completo de My Clippings.txt. Devuelve subrayados y diagnóstico. */
export function parseClippings(bytes, fileLabel = 'My Clippings.txt') {
  const { text, encoding } = decodeText(bytes);
  const blocks = text.split(SEPARATOR).map(b => b.trim()).filter(Boolean);
  const items = [];
  const failures = [];
  blocks.forEach((block, idx) => {
    const [h, err] = parseBlock(block);
    if (h) {
      h.hash = hash53(`${h.bookTitle}|${h.location_start}|${h.location_end}|${h.content.slice(0, 200)}`);
      items.push(h);
    } else if (failures.length < 10) {
      failures.push({ block_index: idx, reason: err, first_lines: block.split(/\r?\n/).slice(0, 4).join('\n') });
    }
  });
  return {
    items,
    diagnosis: {
      file: fileLabel,
      size: bytes.byteLength,
      encoding,
      total_blocks: blocks.length,
      parsed_ok: items.length,
      parsed_failed: blocks.length - items.length,
      failures,
      sample: blocks[0] || '',
    },
  };
}

/** Lee vocab.db (y su -wal si existe) y devuelve palabras con contexto y libro. */
export function readVocabDb(dbBytes, walBytes = null) {
  return readVocabDbDetailed(dbBytes, walBytes).entries;
}

/**
 * Como readVocabDb, pero devuelve también lo necesario para el informe: modo
 * WAL (el Kindle guarda primero las búsquedas nuevas en vocab.db-wal), filas
 * de cada tabla, búsquedas sin su palabra o sin su libro en las otras tablas,
 * y restos de búsquedas que no cuelgan de ninguna tabla.
 */
export function readVocabDbDetailed(dbBytes, walBytes = null) {
  const db = new SQLiteReader(dbBytes, walBytes);
  const { entries, stats } = vocabEntries(db);
  let orphans = null;
  try { orphans = orphanLookups(db, stats.bookTitles); } catch (e) { orphans = { error: e.message }; }
  return { entries, stats, orphans, header: db.info(), walMode: db.walMode, walFrames: db.walFrames, walPages: db.walPages.size };
}

const ASIN_RE = /^(B0[A-Z0-9]{8}|\d{9}[\dX])$/;
/** «en:lumbering» → { lang: 'en', word: 'lumbering' } */
function splitKey(key) {
  const k = String(key || '');
  const i = k.indexOf(':');
  return i > 0 ? { lang: k.slice(0, i), word: k.slice(i + 1) } : { lang: null, word: k };
}
/** ASIN al principio de la clave del libro («B00SDMPAVG:…»), si lo hay. */
const asinOfBookKey = key => {
  const head = String(key || '').split(/[:_]/)[0].toUpperCase();
  return ASIN_RE.test(head) ? head : null;
};

function vocabEntries(db) {
  if (!db.hasTable('LOOKUPS')) throw new Error('vocab.db no tiene la tabla LOOKUPS.');
  const wordRows = db.hasTable('WORDS') ? db.rows('WORDS') : [];
  const words = new Map(wordRows.map(w => [w.id, w]));
  const bookRows = db.hasTable('BOOK_INFO') ? db.rows('BOOK_INFO') : [];
  const books = new Map(bookRows.map(b => [b.id, b]));
  const lookups = db.rows('LOOKUPS');
  const stats = {
    tables: Object.fromEntries(Object.values(db.schema()).map(t => [t.name, t.sql])),
    lookups: lookups.length, words: wordRows.length, bookInfo: bookRows.length,
    withoutWord: 0, withoutBook: 0, bookKeys: new Map(),
    books: bookRows.map(b => ({ id: b.id, asin: b.asin, title: b.title })),
    bookTitles: new Map(bookRows.map(b => [b.id, b.title])),
  };
  const entries = [];
  for (const l of lookups) {
    const bk = String(l.book_key || '');
    stats.bookKeys.set(bk, (stats.bookKeys.get(bk) || 0) + 1);
    // Si falta la fila de WORDS, la palabra sale de su clave («en:palabra»):
    // la búsqueda está, y el Kindle la enseña igual.
    const w = words.get(l.word_key) || null;
    const fromKey = splitKey(l.word_key);
    const word = (w && (w.word || w.stem)) || fromKey.word;
    if (!w) stats.withoutWord++;
    if (!word) continue;
    const b = books.get(l.book_key);
    if (!b && l.book_key) stats.withoutBook++;
    const ts = Number(l.timestamp) || Number(w && w.timestamp) || 0;
    const asin = b && b.asin ? String(b.asin) : asinOfBookKey(l.book_key);
    entries.push({
      key: hash53(`${word}\u0001${l.usage || ''}`),
      word,
      stem: (w && w.stem) || null,
      language: ((w && w.lang) || (b && b.lang) || fromKey.lang || null),
      context: l.usage || null,
      book_title: b ? b.title : null,
      book_authors: b ? b.authors : null,
      book_lang: b ? b.lang : null,
      book_asin: asin,
      looked_up_at: ts ? new Date(ts).toISOString() : null,
      // En el Vocabulary Builder del Kindle, category 100 = «Aprendida».
      mastered: Number(w && w.category) === 100,
    });
  }
  entries.sort((a, b) => (b.looked_up_at || '').localeCompare(a.looked_up_at || ''));
  // Palabras que siguen en WORDS pero sin ninguna búsqueda en LOOKUPS: el
  // Kindle no conserva ya su frase ni su libro.
  const looked = new Set(lookups.map(l => l.word_key));
  const lone = [];
  for (const w of wordRows) {
    if (looked.has(w.id)) continue;
    const word = w.word || w.stem || splitKey(w.id).word;
    if (!word) continue;
    const ts = Number(w.timestamp) || 0;
    lone.push({
      key: hash53(`${word}\u0001`),
      word,
      stem: w.stem || null,
      language: w.lang || splitKey(w.id).lang || null,
      context: null,
      book_title: null, book_authors: null, book_lang: null, book_asin: null,
      looked_up_at: ts ? new Date(ts).toISOString() : null,
      mastered: Number(w.category) === 100,
      no_lookup: true,
    });
  }
  lone.sort((a, b) => (b.looked_up_at || '').localeCompare(a.looked_up_at || ''));
  stats.lone = lone;
  stats.latestWords = [...wordRows].sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0)).slice(0, 20)
    .map(w => ({ word: w.word, at: Number(w.timestamp) ? new Date(Number(w.timestamp)).toISOString() : null, lookup: looked.has(w.id) }));
  return { entries, stats };
}

/** Búsquedas (o restos de ellas) en páginas que no cuelgan de ninguna tabla. */
function orphanLookups(db, bookTitles) {
  const live = new Set(db.rows('LOOKUPS').map(l => l.id));
  const perBook = new Map();
  const sample = [];
  let total = 0;
  for (const { values } of db.orphanRows()) {
    // Forma de una fila de LOOKUPS: id, word_key («en:…»), book_key, dict_key, pos, usage, timestamp.
    const [id, wordKey, bookKey, , , usage, ts] = values;
    if (values.length < 6 || typeof id !== 'string' || typeof wordKey !== 'string' || !/^[a-z]{2,3}(-[A-Za-z]+)?:/.test(wordKey) || live.has(id)) continue;
    total++;
    const t = bookTitles.get(bookKey) || `(clave ${bookKey})`;
    perBook.set(t, (perBook.get(t) || 0) + 1);
    if (sample.length < 10) sample.push({ word: splitKey(wordKey).word, book: t, at: Number(ts) ? new Date(Number(ts)).toISOString() : null, usage: typeof usage === 'string' ? usage.slice(0, 80) : null });
  }
  return { total, perBook: [...perBook.entries()], sample };
}

// ---------- Detección de idioma por palabras frecuentes ----------
const STOPWORDS = {
  es: 'de la que el en y los se del las un por con no una su para es al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros',
  en: 'the of and to in a is that for it as was with be by on not he i this are or his from at which but have an they you were her she there been their one all we can has more will if would its when who what so no about out up into them than other only then some could any these two may also how most',
  fr: 'le de la les et des en un une du est que pour qui dans ne pas au sur se plus par ce il elle avec son sa ses on mais ou comme nous vous leur sont été être cette aux tout fait aussi bien ces sans peut',
  de: 'der die und in den von zu das mit sich des auf für ist im dem nicht ein eine als auch es an werden aus er hat dass sie nach wird bei einer um am sind noch wie einem über einen so zum war haben nur oder aber vor zur bis mehr durch man',
  it: 'di e il la che in a per un del non è una con le si da al sono della dei come più ma anche nel alla gli lo ha questo se delle loro tra',
  pt: 'de a o que e do da em um para é com não uma os no se na por mais as dos como mas foi ao ele das tem à seu sua ou ser quando muito há nos já está eu também só pelo pela até isso ela entre',
};
const STOP_SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v.split(' '))]));

export function detectLanguage(texts) {
  const counts = Object.fromEntries(Object.keys(STOP_SETS).map(k => [k, 0]));
  let total = 0;
  for (const t of texts) {
    for (const w of (t.toLowerCase().match(/[\p{L}]+/gu) || [])) {
      total++;
      for (const [lang, set] of Object.entries(STOP_SETS)) if (set.has(w)) counts[lang]++;
    }
    if (total > 4000) break;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (total < 8 || ranked[0][1] < 3) return null;
  if (ranked[1][1] && ranked[0][1] < ranked[1][1] * 1.3) return null; // demasiado dudoso
  return ranked[0][0];
}
