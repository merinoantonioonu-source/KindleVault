// Exportación de subrayados y vocabulario con control fino de metadatos.

export const DEFAULT_OPTIONS = {
  include_book_title: true, include_author: true, include_language: true,
  include_location: true, include_date: true, include_type: true,
  include_context: true, include_word_language: true,
  include_source_book: true, include_lookup_date: true,
  group_by_book: true, include_front_matter: true, include_main_heading: true,
};

export const PRESETS = {
  full: { ...DEFAULT_OPTIONS },
  'text-only': Object.fromEntries(Object.keys(DEFAULT_OPTIONS).map(k => [k, false])),
  study: {
    include_book_title: true, include_author: false, include_language: true,
    include_location: false, include_date: false, include_type: false,
    include_context: true, include_word_language: true,
    include_source_book: true, include_lookup_date: false,
    group_by_book: true, include_front_matter: false, include_main_heading: true,
  },
};

const nowIso = () => new Date().toISOString().slice(0, 19);
const fmtDate = d => (d ? String(d).replace('T', ' ').slice(0, 19) : '');

function locLabel(h) {
  if (h.location_start) {
    let s = `loc. ${h.location_start}`;
    if (h.location_end && h.location_end !== h.location_start) s += `–${h.location_end}`;
    return s;
  }
  return h.page ? `pág. ${h.page}` : '';
}

function highlightMd(h, o) {
  const out = [];
  if (h.type === 'note') out.push(o.include_type ? `**Nota:** ${h.content}` : h.content);
  else out.push(`> ${h.content.replace(/\n/g, '\n> ')}`);
  for (const n of h.notes || []) out.push(`\n${o.include_type ? '**Nota:** ' : ''}${n.content}`);
  const meta = [];
  if (o.include_location) { const l = locLabel(h); if (l) meta.push(l); }
  if (o.include_date && h.highlighted_at) meta.push(fmtDate(h.highlighted_at));
  if (meta.length) out.push(`\n<sub>${meta.join(' · ')}</sub>`);
  out.push('');
  return out.join('\n');
}

function groupByTitle(items) {
  const map = new Map();
  for (const h of items) {
    if (!map.has(h.title)) map.set(h.title, []);
    map.get(h.title).push(h);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es'));
}

export function highlightsToMarkdown(items, o) {
  const lines = [];
  if (o.include_front_matter) lines.push('---', 'source: KindleVault', `generated: ${nowIso()}`, `highlights: ${items.length}`, '---\n');
  if (o.include_main_heading) lines.push('# Mis subrayados de Kindle\n');
  if (o.group_by_book) {
    for (const [title, group] of groupByTitle(items)) {
      if (o.include_book_title) {
        lines.push(`## ${title}`);
        const sub = [];
        if (o.include_author && group[0].author) sub.push(`*${group[0].author}*`);
        if (o.include_language && group[0].language) sub.push(`\`lang:${group[0].language}\``);
        sub.push(`${group.length} subrayados`);
        lines.push(sub.join(' · ') + '\n');
      }
      group.forEach(h => lines.push(highlightMd(h, o)));
      lines.push('---\n');
    }
  } else {
    items.forEach(h => lines.push(highlightMd(h, o)));
  }
  return lines.join('\n').trim() + '\n';
}

// ---------- UltraMind ----------
// UltraMind lee Markdown así: cada título (#) y cada viñeta (-) es un tema del
// mapa, y las líneas que empiezan por «>» son la nota del tema de encima.
// Un mapa por libro: el título es el tema central y cada subrayado una rama.
// Lo único que va en la nota de una rama es lo que escribiste tú en el Kindle;
// nada de ubicación, fecha ni autor.
const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();
const noteLines = text => String(text).split(/\r?\n/).map(l => `> ${l}`);

function ultramindMap(title, group) {
  const lines = [`# ${oneLine(title)}`];
  for (const h of group) {
    // Una nota sin subrayado al que unirla se queda como rama propia.
    lines.push(`- ${h.type === 'note' ? 'Nota: ' : ''}${oneLine(h.content)}`);
    for (const n of h.notes || []) lines.push(...noteLines(n.content));
  }
  return lines.join('\n') + '\n';
}

const safeFileName = s => oneLine(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'mapa';

/** Un mapa por libro: [{ title, filename, content }]. */
export function ultramindMaps(items) {
  const useful = items.filter(h => h.type === 'highlight' || h.type === 'note');
  return groupByTitle(useful).map(([title, group]) => ({
    title,
    filename: `${safeFileName(title)}.md`,
    content: ultramindMap(title, group),
  }));
}

// ---------- VocaMaster ----------
// VocaMaster (+ → Vocabulario → «Pegar texto») toma cada línea como una
// palabra y su IA rellena traducción, definición y ejemplo. Cada línea va como
// «palabra | frase del libro»: VocaMaster guarda esa frase como ejemplo y la
// usa para traducir el sentido que la palabra tiene ahí. Se manda en bloques
// pequeños y separados por idioma, porque cada lista de VocaMaster es de un
// idioma y la IA trabaja mejor con listas cortas.
export const VOCAMASTER_BLOCK_SIZE = 50;
const VOCAMASTER_BLOCK_CHARS = 20000; // VocaMaster lee como mucho 30.000 caracteres de una vez

/** explicit: palabras elegidas a mano con su casilla; van todas, tengan la marca que tengan. */
export function vocamasterBlocks(items, { baseForm = true, includeSent = false, withContext = true, explicit = false, byBook = false, blockSize = VOCAMASTER_BLOCK_SIZE } = {}) {
  // Por idioma y, si se pide, también por libro (cada libro, su propia lista en VocaMaster).
  const byLang = new Map();
  for (const v of items) {
    if (!explicit && (v.status === 'known' || v.status === 'ignored')) continue;
    if (!explicit && v.status === 'sent' && !includeSent) continue;
    const term = oneLine(baseForm && v.stem ? v.stem : v.word).replace(/\|/g, '/');
    if (!term) continue;
    const lang = String(v.language || '?').split('-')[0].toLowerCase();
    const group = byBook ? `${lang}\u0001${v.book_title || ''}` : lang;
    if (!byLang.has(group)) byLang.set(group, new Map());
    const words = byLang.get(group);
    const k = term.toLowerCase();
    // Si la palabra se buscó varias veces, va la frase más reciente (la lista llega ordenada así).
    if (!words.has(k)) words.set(k, { term, context: oneLine(v.context).replace(/\|/g, '/'), keys: new Set() });
    const w = words.get(k);
    if (!w.context && v.context) w.context = oneLine(v.context).replace(/\|/g, '/');
    w.keys.add(v.wkey);
  }
  const lineOf = w => (withContext && w.context ? `${w.term} | ${w.context}` : w.term);
  const blocks = [];
  const groups = [...byLang.entries()];
  if (byBook) groups.sort(([a], [b]) => a.split('\u0001')[1].localeCompare(b.split('\u0001')[1], 'es', { sensitivity: 'base' }));
  for (const [group, words] of groups) {
    const [lang, book] = group.split('\u0001');
    const parts = [];
    let cur = [], chars = 0;
    for (const w of words.values()) {
      const len = lineOf(w).length + 1;
      if (cur.length && (cur.length >= blockSize || chars + len > VOCAMASTER_BLOCK_CHARS)) { parts.push(cur); cur = []; chars = 0; }
      cur.push(w); chars += len;
    }
    if (cur.length) parts.push(cur);
    parts.forEach((part, i) => blocks.push({
      lang,
      book: byBook ? (book || null) : undefined,
      index: i + 1,
      total: parts.length,
      terms: part.map(w => w.term),
      keys: [...new Set(part.flatMap(w => [...w.keys]))],
      text: part.map(lineOf).join('\n'),
    }));
  }
  return blocks;
}

export function vocabToMarkdown(items, o) {
  const lines = [];
  if (o.include_front_matter) lines.push('---', 'source: KindleVault', `generated: ${nowIso()}`, `words: ${items.length}`, '---\n');
  if (o.include_main_heading) lines.push('# Vocabulario buscado\n');
  for (const v of items) {
    let line = `- **${v.word}**`;
    if (o.include_word_language && v.language) line += ` \`${v.language}\``;
    lines.push(line);
    if (o.include_context && v.context) lines.push(`  > ${v.context}`);
    const sub = [];
    if (o.include_source_book && v.book_title) sub.push(`de *${v.book_title}*`);
    if (o.include_lookup_date && v.looked_up_at) sub.push(fmtDate(v.looked_up_at));
    if (sub.length) lines.push(`  <sub>${sub.join(' · ')}</sub>`);
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

export function highlightsToTxt(items, o) {
  const out = [];
  for (const h of items) {
    out.push(h.content);
    const m = [];
    if (o.include_book_title) m.push(h.title);
    if (o.include_author && h.author) m.push(h.author);
    if (o.include_location) { const l = locLabel(h); if (l) m.push(l); }
    if (o.include_date && h.highlighted_at) m.push(fmtDate(h.highlighted_at));
    if (m.length) out.push(`  — ${m.join(' · ')}`);
    for (const n of h.notes || []) out.push(`  ${o.include_type ? 'Nota: ' : ''}${n.content}`);
    out.push('');
  }
  return out.join('\n').trim() + '\n';
}

export function vocabToTxt(items, o) {
  const out = [];
  for (const v of items) {
    let line = v.word;
    if (o.include_context && v.context) line += `\n  ${v.context}`;
    const m = [];
    if (o.include_word_language && v.language) m.push(v.language);
    if (o.include_source_book && v.book_title) m.push(v.book_title);
    if (o.include_lookup_date && v.looked_up_at) m.push(fmtDate(v.looked_up_at));
    if (m.length) line += `\n  — ${m.join(' · ')}`;
    out.push(line, '');
  }
  return out.join('\n').trim() + '\n';
}

const csvCell = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function highlightCols(o) {
  const cols = [['content', 'content'], ['notes_text', 'note']];
  if (o.include_book_title) cols.push(['title', 'book']);
  if (o.include_author) cols.push(['author', 'author']);
  if (o.include_language) cols.push(['language', 'language']);
  if (o.include_type) cols.push(['type', 'type']);
  if (o.include_location) cols.push(['location_start', 'loc_start'], ['location_end', 'loc_end'], ['page', 'page']);
  if (o.include_date) cols.push(['highlighted_at', 'date']);
  return cols;
}

function vocabCols(o) {
  const cols = [['word', 'word']];
  if (o.include_context) cols.push(['context', 'context']);
  if (o.include_word_language) cols.push(['language', 'language']);
  if (o.include_source_book) cols.push(['book_title', 'book']);
  if (o.include_lookup_date) cols.push(['looked_up_at', 'date']);
  return cols;
}

const toCsv = (items, cols) =>
  '﻿' + [cols.map(c => c[1]).join(','), ...items.map(it => cols.map(c => csvCell(it[c[0]])).join(','))].join('\r\n') + '\r\n';

const toJson = (items, cols) =>
  JSON.stringify(items.map(it => Object.fromEntries(cols.map(c => [c[1], it[c[0]] ?? null]))), null, 2);

/** Genera el contenido de exportación. kind: 'highlights' | 'vocab'. */
export function buildExport(kind, format, items, options) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  if (kind === 'vocab' && format === 'ultramind') format = 'markdown';
  const ext = { ultramind: 'md', markdown: 'md', txt: 'txt', csv: 'csv', json: 'json' }[format];
  let content;
  if (kind === 'highlights') {
    items = items.map(h => ({ ...h, notes_text: (h.notes || []).map(n => n.content).join(' / ') }));
    if (format === 'ultramind') content = ultramindMaps(items).map(m => m.content).join('\n');
    else if (format === 'markdown') content = highlightsToMarkdown(items, o);
    else if (format === 'txt') content = highlightsToTxt(items, o);
    else if (format === 'csv') content = toCsv(items, highlightCols(o));
    else content = toJson(items, highlightCols(o));
  } else {
    if (format === 'markdown') content = vocabToMarkdown(items, o);
    else if (format === 'txt') content = vocabToTxt(items, o);
    else if (format === 'csv') content = toCsv(items, vocabCols(o));
    else content = toJson(items, vocabCols(o));
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const name = `${kind === 'vocab' ? 'vocabulario' : 'subrayados'}_${stamp}${format === 'ultramind' ? '_ultramind' : ''}.${ext}`;
  const mime = { md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json' }[ext];
  return { content, filename: name, mime: `${mime};charset=utf-8` };
}
