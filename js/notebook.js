// Otras fuentes de subrayados, además del Kindle por USB:
//  · Cuadernos exportados por la app Kindle de escritorio (PC/Mac) o del móvil:
//    «Cuaderno» → «Exportar cuaderno» genera un HTML por libro.
//  · El archivo que descarga el marcador «KindleVault: nube de Amazon» desde
//    read.amazon.com/notebook (todos los libros con subrayados, estén o no
//    descargados).
// Ambas devuelven elementos con la misma forma que parseClippings.
import { hash53 } from './parser.js';

const KIND_WORDS = {
  bookmark: /^(bookmark|marcador|lesezeichen|signet|segnalibro)/i,
  note: /^(note|nota|notiz|anmerkung)/i,
  highlight: /^(highlight|subrayado|resaltado|destacado|destaque|markierung|surlignement|evidenziazione)/i,
};
const LOC_RE = /(?:location|posición|posicion|position|posizione|posição|pos\.)\s*:?\s*([\d.,]+)(?:\s*[-–]\s*([\d.,]+))?/i;
const PAGE_RE = /(?:page|página|pagina|seite)\s*:?\s*(\d+)/i;
const toNum = s => (s ? Number(String(s).replace(/[.,\s]/g, '')) || null : null);

const clean = s => String(s || '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

function withHash(item) {
  item.hash = hash53(`${item.bookTitle}|${item.location_start}|${item.location_end}|${item.content.slice(0, 200)}`);
  return item;
}

/** Cuaderno exportado de la app Kindle (HTML con noteHeading / noteText). */
export function parseNotebookHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = clean(doc.querySelector('.bookTitle')?.textContent);
  const authorRaw = clean(doc.querySelector('.authors')?.textContent);
  // «Harari, Yuval Noah» → «Yuval Noah Harari»
  const author = /^[^,;]+,\s*[^,;]+$/.test(authorRaw) ? authorRaw.split(/,\s*/).reverse().join(' ') : authorRaw || null;
  const items = [];
  if (!title) return { title: null, author, items };
  let section = null;
  let pending = null;
  for (const el of doc.querySelectorAll('.sectionHeading, .noteHeading, .noteText')) {
    const text = clean(el.textContent);
    if (el.classList.contains('sectionHeading')) { section = text || null; continue; }
    if (el.classList.contains('noteHeading')) {
      const head = text.split(/\s[-–]\s/)[0];
      const type = Object.keys(KIND_WORDS).find(k => KIND_WORDS[k].test(head)) || 'highlight';
      const loc = text.match(LOC_RE);
      const page = text.match(PAGE_RE);
      pending = {
        bookTitle: title, author, type,
        location_start: loc ? toNum(loc[1]) : null,
        location_end: loc && loc[2] ? toNum(loc[2]) : null,
        page: page ? Number(page[1]) : null,
        highlighted_at: null,
        section,
      };
      if (type === 'bookmark') { items.push(withHash({ ...pending, content: '[marcador de página]' })); pending = null; }
      continue;
    }
    if (pending && text) { items.push(withHash({ ...pending, content: text })); pending = null; }
  }
  return { title, author, items };
}

/** Archivo descargado con el marcador desde la nube de Amazon. */
export function parseAmazonExport(data) {
  if (!data || data.format !== 'kindlevault-amazon') throw new Error('no es un archivo de la nube de Amazon hecho con KindleVault');
  const items = [];
  const books = [];
  let failed = 0;
  for (const b of data.books || []) {
    if (b.failed) failed++;
    if (!b.title || (b.failed && !(b.annotations || []).length)) continue;
    books.push({ title: b.title, author: b.author || null, asin: b.asin || null });
    for (const a of b.annotations || []) {
      const base = {
        bookTitle: b.title, author: b.author || null,
        location_start: a.location ?? null, location_end: null, page: a.page ?? null,
        highlighted_at: null,
      };
      const content = clean(a.highlight);
      const note = clean(a.note);
      if (content) items.push(withHash({ ...base, type: 'highlight', content }));
      if (note) items.push(withHash({ ...base, type: 'note', content: note }));
    }
  }
  return { books, items, failed };
}
