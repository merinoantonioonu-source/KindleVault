// Sincronización con un archivo JSON (OneDrive, Dropbox, una carpeta de red...).
// Regla: leer el archivo, combinarlo con lo local y escribir el resultado.
// Nunca se borra nada y nunca se sobrescribe un archivo que no se ha podido leer.
import { kvGet, kvSet } from './store.js';
import { hash53 } from './parser.js';

export const syncSupported = typeof window !== 'undefined' && 'showSaveFilePicker' in window;

const PICKER_TYPES = [{ description: 'Sincronización de KindleVault', accept: { 'application/json': ['.json'] } }];

function signature(books, highlights, vocab, wordStatus = []) {
  let covers = 0, langs = 0;
  for (const b of books) {
    if (b.cover_url && b.cover_url !== '__not_found__') covers += 2;
    else if (b.cover_url) covers += 1;
    if (b.language) langs++;
  }
  // Los estados de palabras cambian sin cambiar ningún recuento: van con su propia huella.
  const statuses = hash53(wordStatus.map(w => `${w.key}:${w.status || ''}:${w.at}`).sort().join('\n'));
  return `${books.length}|${highlights.length}|${vocab.length}|${covers}|${langs}|${statuses}`;
}

export class SyncManager {
  constructor(library, { onStatus = () => {}, onMerged = () => {} } = {}) {
    this.library = library;
    this.onStatus = onStatus;
    this.onMerged = onMerged;
    this.handle = null;
    this.meta = { name: null, lastSync: null };
    this.state = syncSupported ? 'none' : 'unsupported';
    this.error = null;
    this._busy = null;
    this._timer = null;
  }

  _set(state, error = null) {
    this.state = state;
    this.error = error;
    this.onStatus(this);
  }

  async init() {
    if (!syncSupported) { this._set('unsupported'); return; }
    this.handle = (await kvGet('syncHandle')) || null;
    this.meta = (await kvGet('syncMeta')) || { name: null, lastSync: null };
    if (!this.handle) { this._set('none'); return; }
    const perm = await this.handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') await this.syncNow();
    else this._set('needs-permission');
  }

  async _remember(handle) {
    this.handle = handle;
    this.meta = { name: handle.name, lastSync: null };
    await kvSet('syncHandle', handle);
    await kvSet('syncMeta', this.meta);
  }

  /** Crea un archivo nuevo (con los datos actuales). Requiere un clic del usuario. */
  async create() {
    const handle = await window.showSaveFilePicker({
      id: 'kindlevault-sync', suggestedName: 'kindlevault-sync.json', types: PICKER_TYPES,
    });
    await this._remember(handle);
    return this.syncNow({ interactive: true });
  }

  /** Vincula un archivo existente (el creado en otro ordenador). Requiere un clic. */
  async link() {
    const [handle] = await window.showOpenFilePicker({ id: 'kindlevault-sync', types: PICKER_TYPES, multiple: false });
    await this._remember(handle);
    return this.syncNow({ interactive: true });
  }

  async unlink() {
    this.handle = null;
    this.meta = { name: null, lastSync: null };
    await kvSet('syncHandle', undefined);
    await kvSet('syncMeta', undefined);
    this._set('none');
  }

  /** Programa una sincronización tras cambios locales (agrupa cambios seguidos). */
  schedule() {
    if (!this.handle) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.syncNow(), 1500);
  }

  async syncNow({ interactive = false } = {}) {
    if (!this.handle) return { ok: false };
    if (this._busy) { await this._busy; }
    this._busy = this._doSync(interactive).finally(() => { this._busy = null; });
    return this._busy;
  }

  async _doSync(interactive) {
    let perm = await this.handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted' && interactive) perm = await this.handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') { this._set('needs-permission'); return { ok: false, needsPermission: true }; }

    this._set('syncing');
    try {
      const file = await this.handle.getFile();
      const text = (await file.text()).trim();
      let remote = null;
      if (text) {
        try { remote = JSON.parse(text); } catch {
          throw new Error('El archivo de sincronización está dañado o a medio descargar. No lo he tocado; ábrelo de nuevo cuando termine de sincronizar tu nube.');
        }
        if (remote.format !== 'kindlevault-sync') {
          throw new Error('Ese archivo no es un archivo de sincronización de KindleVault. No lo he tocado.');
        }
      }
      const changedHere = remote ? this.library.merge(remote) : false;
      if (changedHere) {
        this.library.guessMissingLanguages();
        await this.library.save();
        this.onMerged();
      }
      const local = this.library.toJSON();
      const remoteSig = remote ? signature(remote.books || [], remote.highlights || [], remote.vocab || [], remote.wordStatus || []) : null;
      const localSig = signature(local.books, local.highlights, local.vocab, local.wordStatus);
      let wrote = false;
      if (remoteSig !== localSig) {
        const w = await this.handle.createWritable();
        await w.write(JSON.stringify(local));
        await w.close();
        wrote = true;
      }
      this.meta.lastSync = new Date().toISOString();
      this.meta.name = this.handle.name;
      await kvSet('syncMeta', this.meta);
      this._set('ok');
      return { ok: true, changedHere, wrote };
    } catch (e) {
      if (e && e.name === 'NotFoundError') {
        this._set('error', 'No encuentro el archivo de sincronización. ¿Lo has movido o borrado? Vincúlalo de nuevo.');
      } else {
        this._set('error', (e && e.message) || String(e));
      }
      return { ok: false, error: this.error };
    }
  }

  /** Para navegadores sin acceso a archivos (móvil, Firefox): solo lectura. */
  async importFromFile(file) {
    const data = JSON.parse(await file.text());
    if (data.format !== 'kindlevault-sync') throw new Error('Ese archivo no es de KindleVault.');
    const changed = this.library.merge(data);
    if (changed) { this.library.guessMissingLanguages(); await this.library.save(); this.onMerged(); }
    return changed;
  }
}
