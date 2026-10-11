// Acceso a los archivos del Kindle conectado por USB.
import { kvGet, kvSet } from './store.js';

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
  return {
    folderName: dir.name,
    clippings: await readHandle(clippings),
    vocab: vocabDb ? { db: await readHandle(vocabDb), wal: await readHandle(vocabWal) } : null,
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
  await kvSet('kindleHandle', dir);
  return readKindleFolder(dir);
}

/** Alternativa universal: archivos elegidos a mano (funciona en cualquier navegador). */
export async function readKindleFiles(fileList) {
  const out = { folderName: null, clippings: null, vocab: null };
  let db = null, wal = null;
  for (const f of fileList) {
    const n = f.name.toLowerCase();
    const item = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
    if (n.endsWith('.txt')) out.clippings = item;
    else if (n.endsWith('-wal')) wal = item;
    else if (n.endsWith('.db') || n.endsWith('.sqlite')) db = item;
  }
  if (db) out.vocab = { db, wal };
  return out;
}
