// Acceso a los archivos del Kindle conectado por USB.
import { kvGet, kvSet } from './store.js';
import { BOOK_FILE_RE, metaFromFileName, mobiMeta } from './bookmeta.js';
import { SIDECAR_RE, countSidecar } from './sidecar.js';

/** Suma lo que hay en la carpeta .sdr de un libro (máximo por tipo entre sus archivos). */
async function readSidecar(sdr) {
  const total = { highlights: 0, notes: 0, bookmarks: 0 };
  const files = [];
  try {
    for await (const [name, h] of sdr.entries()) {
      if (h.kind !== 'file' || !SIDECAR_RE.test(name)) continue;
      const f = await h.getFile();
      if (f.size > 30 * 1024 * 1024) continue;
      const c = countSidecar(new Uint8Array(await f.arrayBuffer()));
      files.push(`${name}${c ? ` (${c.highlights}/${c.notes}/${c.bookmarks})` : ' (?)'}`);
      if (c) for (const k of Object.keys(total)) total[k] = Math.max(total[k], c[k]);
    }
  } catch { /* carpeta ilegible */ }
  return { annotations: files.length ? total : null, sidecarFiles: files };
}

export const folderAccessSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

async function child(dir, name, kind) {
  const lower = name.toLowerCase();
  try {
    for await (const [entryName, handle] of dir.entries()) {
      if (entryName.toLowerCase() === lower && handle.kind === kind) return handle;
    }
  } catch { /* carpeta ilegible */ }
  return null;
}

async function walk(dir, parts) {
  let cur = dir;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = await child(cur, parts[i], 'directory');
    if (!cur) return null;
  }
  return child(cur, parts[parts.length - 1], 'file');
}

async function readHandle(h) {
  if (!h) return null;
  const f = await h.getFile();
  return { name: f.name, modified: f.lastModified, bytes: new Uint8Array(await f.arrayBuffer()) };
}

/** Lo que hay en la carpeta de vocab.db (nombre, tamaño, fecha), para el informe. */
async function folderListing(dir, parts) {
  let cur = dir;
  for (const p of parts) { cur = await child(cur, p, 'directory'); if (!cur) return null; }
  const out = [];
  try {
    for await (const [name, h] of cur.entries()) {
      if (h.kind === 'directory') { out.push(`${name}/`); continue; }
      const f = await h.getFile();
      out.push(`${name} (${f.size} bytes, ${new Date(f.lastModified).toISOString()})`);
    }
  } catch { /* carpeta ilegible */ }
  return out.sort();
}

/**
 * Lista los libros que hay en el Kindle (carpeta documents y sus subcarpetas).
 * Se saltan las carpetas .sdr (datos de lectura) y los diccionarios.
 */
async function listDeviceBooks(dir, path = '', depth = 0, out = []) {
  if (depth > 6) return out;
  let entries = [];
  try { for await (const e of dir.entries()) entries.push(e); } catch { return out; }
  const sdrDirs = new Map(entries.filter(([n, h]) => h.kind === 'directory' && /\.sdr$/i.test(n)).map(([n, h]) => [n.toLowerCase(), h]));
  for (const [name, h] of entries) {
    if (h.kind === 'directory') {
      if (/\.sdr$/i.test(name) || /^(dictionaries|\.)/i.test(name)) continue;
      await listDeviceBooks(h, `${path}${name}/`, depth + 1, out);
    } else if (BOOK_FILE_RE.test(name)) {
      let meta = metaFromFileName(name);
      if (/\.(azw3?|mobi|prc)$/i.test(name)) {
        try {
          const f = await h.getFile();
          const head = mobiMeta(new Uint8Array(await f.slice(0, 262144).arrayBuffer()));
          if (head) meta = { ...meta, ...Object.fromEntries(Object.entries(head).filter(([, v]) => v)) };
        } catch { /* archivo ilegible: queda el nombre */ }
      }
      if (meta.dictionary) continue; // los diccionarios no son libros
      const sdr = sdrDirs.get(name.replace(/\.[^.]+$/, '').toLowerCase() + '.sdr');
      const side = sdr ? await readSidecar(sdr) : { annotations: null, sidecarFiles: [] };
      out.push({ file: `${path}${name}`, ...meta, ...side });
    }
  }
  return out;
}

async function rootEntries(dir) {
  const names = [];
  try { for await (const [name, h] of dir.entries()) names.push(h.kind === 'directory' ? `${name}/` : name); } catch { /* */ }
  return names.sort();
}

/** Busca My Clippings.txt y vocab.db tanto si se elige la raíz como una subcarpeta. */
export async function readKindleFolder(dir) {
  const clippings =
    (await walk(dir, ['documents', 'My Clippings.txt'])) ||
    (await walk(dir, ['My Clippings.txt']));
  const vocabDb =
    (await walk(dir, ['system', 'vocabulary', 'vocab.db'])) ||
    (await walk(dir, ['vocabulary', 'vocab.db'])) ||
    (await walk(dir, ['vocab.db']));
  // Las búsquedas más recientes pueden estar aún en vocab.db-wal (junto a vocab.db).
  const beside = name =>
    walk(dir, ['system', 'vocabulary', name]).then(h => h || walk(dir, ['vocabulary', name])).then(h => h || walk(dir, [name]));
  const vocabWal = vocabDb ? await beside('vocab.db-wal') : null;
  const vocabShm = vocabDb ? await beside('vocab.db-shm') : null;
  const documents = (await child(dir, 'documents', 'directory')) ||
    (dir.name.toLowerCase() === 'documents' ? dir : null);
  return {
    folderName: dir.name,
    rootEntries: await rootEntries(dir),
    clippings: await readHandle(clippings),
    vocab: vocabDb ? {
      db: await readHandle(vocabDb), wal: await readHandle(vocabWal), shm: !!vocabShm,
      folder: (await folderListing(dir, ['system', 'vocabulary'])) || (await folderListing(dir, ['vocabulary'])),
    } : null,
    deviceBooks: documents ? await listDeviceBooks(documents) : null,
  };
}

async function savedKindle() {
  try { return (await kvGet('kindleHandle')) || null; } catch { return null; }
}

/** ¿Se ha elegido un Kindle antes en este navegador? */
export async function hasSavedKindle() { return !!(await savedKindle()); }

/** Pide siempre la carpeta del Kindle (empezando por la de la última vez, si se puede). */
export async function pickKindleFolder() {
  const saved = await savedKindle();
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'kindlevault-kindle', mode: 'read', ...(saved ? { startIn: saved } : {}) });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    dir = await window.showDirectoryPicker({ id: 'kindlevault-kindle', mode: 'read' });
  }
  try { await kvSet('kindleHandle', dir); } catch { /* sin recordar la carpeta: se pedirá otra vez */ }
  return readKindleFolder(dir);
}

/**
 * Vuelve a leer, tal como está AHORA, el Kindle elegido la última vez.
 * Devuelve null si no está conectado, ha cambiado de letra o no hay permiso.
 */
export async function rescanSavedKindle() {
  const saved = await savedKindle();
  if (!saved) return null;
  try {
    let perm = await saved.queryPermission({ mode: 'read' });
    if (perm !== 'granted') perm = await saved.requestPermission({ mode: 'read' });
    if (perm !== 'granted') return null;
    const r = await readKindleFolder(saved);
    return r.clippings || r.vocab || (r.deviceBooks && r.deviceBooks.length) ? r : null;
  } catch {
    return null;
  }
}

/**
 * Archivos elegidos a mano (funciona en cualquier navegador): My Clippings.txt,
 * vocab.db, cuadernos exportados de la app Kindle (.html) y el archivo de la
 * nube de Amazon o de sincronización (.json).
 */
export async function readKindleFiles(fileList) {
  const out = { folderName: null, clippings: null, vocab: null, notebooks: [], amazon: [], syncFiles: [], fileNames: [], walAlone: false };
  let db = null, wal = null, shm = false;
  for (const f of fileList) {
    const n = f.name.toLowerCase();
    out.fileNames.push(f.name);
    if (n.endsWith('-shm')) { shm = true; continue; }
    const item = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
    if (n.endsWith('.txt')) out.clippings = item;
    else if (n.endsWith('-wal')) wal = item;
    else if (n.endsWith('.db') || n.endsWith('.sqlite')) db = item;
    else if (n.endsWith('.html') || n.endsWith('.htm')) out.notebooks.push(item);
    else if (n.endsWith('.json')) {
      const head = new TextDecoder().decode(item.bytes.subarray(0, 400));
      if (head.includes('kindlevault-amazon')) out.amazon.push(item);
      else if (head.includes('kindlevault-sync')) out.syncFiles.push(item);
    }
  }
  if (db) out.vocab = { db, wal, shm };
  else if (wal) out.walAlone = true;
  return out;
}
