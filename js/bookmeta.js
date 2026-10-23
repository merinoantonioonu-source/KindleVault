// Título, autor y ASIN de los libros que hay en el Kindle, sin abrir su texto:
// del nombre del archivo y, en los formatos MOBI/AZW/AZW3, de su cabecera
// (que no está cifrada aunque el libro tenga DRM).

export const BOOK_FILE_RE = /\.(azw|azw3|azw4|kfx|mobi|prc|pdf)$/i;
const ASIN_RE = /^(B0[A-Z0-9]{8}|\d{9}[\dX])$/;

/** «Sapiens_ De animales a dioses_B07B7N3ZXZ.azw3» → título y ASIN. */
export function metaFromFileName(name) {
  let t = name.replace(/\.[^.]+$/, '');
  let asin = null;
  let m = t.match(/-asin_([A-Z0-9]{10})-type_[A-Z]+-v_\d+$/i);
  if (m) { asin = m[1].toUpperCase(); t = t.slice(0, m.index); }
  m = t.match(/[_-]([A-Z0-9]{10})(?:_(?:EBOK|EBSP|PDOC))?$/);
  if (m && ASIN_RE.test(m[1])) { asin = m[1]; t = t.slice(0, m.index); }
  m = t.match(/^([A-Z0-9]{10})(?:_(?:EBOK|EBSP|PDOC))?$/);
  if (m && ASIN_RE.test(m[1])) return { title: null, author: null, asin: m[1] };
  t = t.replace(/_ /g, ': ').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return { title: t || null, author: null, asin };
}

const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

/** Cabecera de un MOBI/AZW/AZW3 (los primeros KB del archivo bastan). */
export function mobiMeta(bytes) {
  try {
    if (bytes.length < 90 || ascii(bytes, 60, 8) !== 'BOOKMOBI') return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rec0 = dv.getUint32(78);
    if (ascii(bytes, rec0 + 16, 4) !== 'MOBI') return null;
    const hdrLen = dv.getUint32(rec0 + 20);
    const encoding = dv.getUint32(rec0 + 28);
    const dec = new TextDecoder(encoding === 65001 ? 'utf-8' : 'windows-1252');
    const out = { title: null, author: null, asin: null, language: null };
    const nameOff = dv.getUint32(rec0 + 0x54), nameLen = dv.getUint32(rec0 + 0x58);
    if (nameLen > 0 && nameLen < 1000 && rec0 + nameOff + nameLen <= bytes.length) {
      out.title = dec.decode(bytes.subarray(rec0 + nameOff, rec0 + nameOff + nameLen)).trim() || null;
    }
    const exthFlags = dv.getUint32(rec0 + 0x80);
    const exth = rec0 + 16 + hdrLen;
    if ((exthFlags & 0x40) && ascii(bytes, exth, 4) === 'EXTH') {
      const count = dv.getUint32(exth + 8);
      let p = exth + 12;
      for (let i = 0; i < count && p + 8 <= bytes.length; i++) {
        const type = dv.getUint32(p), len = dv.getUint32(p + 4);
        if (len < 8 || p + len > bytes.length) break;
        const val = () => dec.decode(bytes.subarray(p + 8, p + len)).trim();
        if (type === 100 && !out.author) out.author = val();
        else if (type === 503) out.title = val() || out.title;
        else if (type === 113 || (type === 504 && !out.asin)) { const a = val(); if (ASIN_RE.test(a)) out.asin = a; }
        else if (type === 524) out.language = val();
        p += len;
      }
    }
    return out;
  } catch {
    return null;
  }
}
