// Acceso a los archivos del Kindle conectado por USB.
import { kvGet, kvSet } from './store.js';
import { BOOK_FILE_RE, metaFromFileName, mobiMeta } from './bookmeta.js';

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
  return { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
}

/**
 * Lista los libros que hay en el Kindle (carpeta documents y sus subcarpetas).
 * Se saltan las carpetas .sdr (datos de lectura) y los diccionarios.
 */
async function listDeviceBooks(dir, path = '', depth = 0, out = []) {
  if (depth > 6) return out;
  let entries = [];
  try { for await (const e of dir.entries()) entries.push(e); } catch { return out; }
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
      out.push({ file: `${path}${name}`, ...meta });
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
  let vocabWal = null;
  if (vocabDb) {
    vocabWal =
      (await walk(dir, ['system', 'vocabulary', 'vocab.db-wal'])) ||
      (await walk(dir, ['vocabulary', 'vocab.db-wal'])) ||
      (await walk(dir, ['vocab.db-wal']));
  }
  const documents = (await child(dir, 'documents', 'directory')) ||
    (dir.name.toLowerCase() === 'documents' ? dir : null);
  return {
    folderName: dir.name,
    rootEntries: await rootEntries(dir),
    clippings: await readHandle(clippings),
    vocab: vocabDb ? { db: await readHandle(vocabDb), wal: await readHandle(vocabWal) } : null,
    deviceBooks: documents ? await listDeviceBooks(documents) : null,
  };
}

/** Pide la carpeta del Kindle (o reutiliza la de esta sesión si sigue autorizada). */
export async function pickKindleFolder() {
  const saved = await kvGet('kindleHandle');
  if (saved) {
    try {
      if ((await saved.queryPermission({ mode: 'read' })) === 'granted') {
        const r = await readKindleFolder(saved);
        if (r.clippings || r.vocab) return r;
      }
    } catch { /* Kindle desconectado o letra de unidad distinta */ }
  }
  const dir = await window.showDirectoryPicker({ id: 'kindlevault-kindle', mode: 'read' });
  try { await kvSet('kindleHandle', dir); } catch { /* sin recordar la carpeta: se pedirá otra vez */ }
  return readKindleFolder(dir);
}

/**
 * Archivos elegidos a mano (funciona en cualquier navegador): My Clippings.txt,
 * vocab.db, cuadernos exportados de la app Kindle (.html) y el archivo de la
 * nube de Amazon o de sincronización (.json).
 */
export async function readKindleFiles(fileList) {
  const out = { folderName: null, clippings: null, vocab: null, notebooks: [], amazon: [], syncFiles: [], fileNames: [] };
  let db = null, wal = null;
  for (const f of fileList) {
    const n = f.name.toLowerCase();
    out.fileNames.push(f.name);
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
  if (db) out.vocab = { db, wal };
  return out;
}
