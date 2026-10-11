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
  const cols = [['content', 'content']];
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
  const ext = { markdown: 'md', txt: 'txt', csv: 'csv', json: 'json' }[format];
  let content;
  if (kind === 'highlights') {
    if (format === 'markdown') content = highlightsToMarkdown(items, o);
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
  const name = `${kind === 'vocab' ? 'vocabulario' : 'subrayados'}_${stamp}.${ext}`;
  const mime = { md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json' }[ext];
  return { content, filename: name, mime: `${mime};charset=utf-8` };
}
