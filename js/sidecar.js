// Anotaciones que el Kindle guarda en la carpeta «.sdr» de cada libro.
//
// Ahí están TODOS los subrayados, notas y marcadores del libro, también los
// que llegan de la nube al descargarlo (hechos en el móvil, el ordenador u
// otro Kindle), que nunca se escriben en My Clippings.txt. Pero solo guarda
// su posición, no el texto subrayado (ese texto está en el libro, cifrado).
// Así que de aquí solo se sacan recuentos: cuántos hay en el Kindle, para
// avisar de los que faltan y traerlos de la nube de Amazon.
//
// Formato KRDS (archivos .yjr, .yjf, .azw3r, .azw3f, .pds, .pdt…): cada
// anotación es un campo con nombre como «annotation.personal.highlight».

export const SIDECAR_RE = /\.(yjr|yjf|azw3r|azw3f|azwr|azwf|pds|pdt)$/i;
const KRDS_MAGIC = [0x00, 0x00, 0x00, 0x00, 0x00, 0x1a, 0xb1, 0x26];

const NAMES = {
  highlights: 'annotation.personal.highlight',
  notes: 'annotation.personal.note',
  bookmarks: 'annotation.personal.bookmark',
};
const enc = new TextEncoder();
const PATTERNS = Object.fromEntries(Object.entries(NAMES).map(([k, n]) => [k, enc.encode(n)]));
const NAME_CHAR = c => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x5f;

function occurrences(bytes, pat, strict) {
  let n = 0;
  const first = pat[0], len = pat.length;
  outer: for (let i = 2; i + len <= bytes.length; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < len; j++) if (bytes[i + j] !== pat[j]) continue outer;
    if (i + len < bytes.length && NAME_CHAR(bytes[i + len])) continue; // otro nombre más largo
    // En KRDS cada texto va precedido de su longitud (2 bytes).
    if (strict && ((bytes[i - 2] << 8) | bytes[i - 1]) !== len) continue;
    n++;
  }
  return n;
}

export const isKrds = bytes => KRDS_MAGIC.every((b, i) => bytes[i] === b);

/** { highlights, notes, bookmarks } de un archivo de la carpeta .sdr, o null si no es KRDS. */
export function countSidecar(bytes) {
  const krds = isKrds(bytes);
  const out = {};
  for (const [k, pat] of Object.entries(PATTERNS)) {
    out[k] = occurrences(bytes, pat, true);
    if (!out[k] && krds) out[k] = occurrences(bytes, pat, false);
  }
  if (!krds && !out.highlights && !out.notes && !out.bookmarks) return null;
  return out;
}
