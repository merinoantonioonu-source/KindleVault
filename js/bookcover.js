// Portadas: la de Open Library si la hay y, si no (o mientras carga), una
// generada con el título y el autor, como las de las colecciones clásicas: un
// color propio de cada libro (sale del título) y su nombre en letra con remates.

const PALETTE = [
  ['#7b2f2a', '#a3483a'], ['#2c4770', '#456b9e'], ['#2d5a4c', '#4a8270'],
  ['#57386b', '#7c5693'], ['#86651c', '#b48b30'], ['#3f3a35', '#625a51'],
  ['#77395a', '#9f557b'], ['#1d5566', '#2f7b8f'], ['#6a4627', '#93663c'],
  ['#4a5a28', '#6b8040'], ['#304a5e', '#4f7088'], ['#8a4b2a', '#b46a3f'],
];

const hash = s => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Título corto para la portada: sin «(Spanish Edition)» ni subtítulos largos. */
export function shortTitle(title) {
  let t = String(title || '').replace(/\s*\([^()]*\)\s*$/g, '').replace(/\s*\([^()]*\)\s*$/g, '').trim();
  if (t.length > 48 && t.includes(':')) t = t.split(':')[0];
  return t || title || '';
}

/** «Rodi, Robert» → «Robert Rodi». */
export function displayAuthor(author) {
  if (!author) return '';
  const a = String(author).split(/;|&/)[0].trim();
  if (/^[^,]+,\s*[^,]+$/.test(a)) { const [last, first] = a.split(',').map(s => s.trim()); return `${first} ${last}`; }
  return a;
}

export function coverColors(title) {
  return PALETTE[hash(String(title || '')) % PALETTE.length];
}

/** La portada generada (también sirve de respaldo si la imagen falla). */
export function generatedCover(book, { hidden = false } = {}) {
  const [a, b] = coverColors(book.title);
  const t = shortTitle(book.title);
  const size = t.length > 60 ? 'xs' : t.length > 34 ? 'sm' : t.length > 16 ? 'md' : 'lg';
  return `<div class="gcover gcover-${size}" style="--c1:${a};--c2:${b}${hidden ? ';display:none' : ''}">
    <div class="gcover-title">${esc(t)}</div>
    <div class="gcover-rule"></div>
    <div class="gcover-author">${esc(displayAuthor(book.author))}</div>
  </div>`;
}

/** Portada completa: la imagen real con la generada detrás por si no carga. */
export function coverHtml(book) {
  const real = book.cover_url && book.cover_url !== '__not_found__';
  if (!real) return generatedCover(book);
  return `<img class="cover-img" src="${esc(book.cover_url)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">${generatedCover(book, { hidden: true })}`;
}
