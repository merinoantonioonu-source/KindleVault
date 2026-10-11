// Portadas desde la API pública de Open Library (sin clave).

function cleanTitle(title) {
  let t = title.replace(/\s*\([^()]*(edition|edición|spanish|english|french|deutsch|kindle|paperback|hardcover|illustrated|nº\s*\d+|volume\s*\d+|book\s*\d+|deusto|alienta|no ficción|suma)[^()]*\)/gi, '');
  if (t.length > 50 && t.includes(':')) t = t.split(':')[0];
  return t.trim();
}

function cleanAuthor(author) {
  if (!author) return null;
  const a = author.split(/;|&| and /)[0].trim();
  if (a.includes(',')) {
    const [last, first] = a.split(',', 2).map(s => s.trim());
    if (first) return `${first} ${last}`;
  }
  return a;
}

async function search(title, author) {
  const q = [`title:"${title}"`];
  if (author) q.push(`author:"${author}"`);
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q.join(' '))}&limit=3&fields=cover_i`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return undefined;
    const data = await res.json();
    const doc = (data.docs || []).find(d => d.cover_i);
    return doc ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null;
  } catch {
    return undefined; // error de red: reintentar otro día
  } finally {
    clearTimeout(t);
  }
}

/** Devuelve una URL, null si no hay portada, o undefined si no se pudo consultar. */
export async function findCover(title, author) {
  const ct = cleanTitle(title);
  const ca = cleanAuthor(author);
  let url = await search(ct, ca);
  if (url === null && ca) url = await search(ct, null);
  return url;
}
