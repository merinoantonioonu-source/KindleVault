/**
 * Sincronizar con un código, del lado del navegador: hablar con la Realtime
 * Database, bajar y subir piezas y juntar la biblioteca (el formato está en
 * `nube.js`).
 *
 * Cada cruce:
 *   1. lee el índice de la nube y baja solo las piezas que han cambiado desde
 *      el último cruce de este equipo;
 *   2. las junta con lo de aquí (`Library.merge`, como el archivo);
 *   3. sube las piezas en las que aquí hay algo que la nube no tiene y,
 *      después, el índice nuevo;
 *   4. vuelve a mirar la ficha del índice: si otro equipo escribió a la vez,
 *      empieza otra vez con lo suyo (no se pierde nada: lo de aquí sigue aquí).
 *
 * Este equipo recuerda (en `nubeMemoria`) qué versión de cada pieza vio y qué
 * huella tenía aquí cada una: así sabe, sin bajar nada, qué ha cambiado en
 * cada lado.
 */

import { kvGet, kvSet } from './store.js';
import {
  NUBE_BASE, LECTURA_MAX, SOBRAS_ESPERA,
  abrir, claveDe, codigoNuevo, codigoValido, componerIndice, esCubo, hexAlAzar, huecoDe, leerCatalogo, leerCubo,
  leerEstados, leerIndice, limpiarCodigo, mismoIndice, paraPieza, piezasLocales, queEquipo, sellar, sobrasParaBorrar,
  tamanoEnLaNube, trocear, unirPieza,
} from './nube.js';

const KV_CODIGO = 'nubeCodigo';
const KV_MEMORIA = 'nubeMemoria';

/** Cada cuánto se mira si otro equipo ha subido algo, con la página a la vista (solo unos bytes). */
export const NUBE_VISTAZO = 3 * 60 * 1000;
/** La espera tras el último cambio antes de subirlo (junta varios cambios seguidos). */
export const NUBE_ESPERA = 8000;

/** Un fallo al hablar con la nube, ya contado para el usuario. */
export class ErrorNube extends Error {}

/**
 * La Realtime Database por su API web: `GET`, `PUT` y `DELETE` sobre
 * `sync/<hueco>.json`, sin cabeceras propias. Al escribir y borrar se pide
 * `print=silent`: así Firebase no devuelve una copia de lo subido (no se gasta
 * descarga en balde).
 */
export function redFirebase(base = NUBE_BASE) {
  const url = (hueco, parte = '', silencio = false) => `${base.replace(/\/+$/, '')}/sync/${hueco}${parte}.json${silencio ? '?print=silent' : ''}`;
  const pedir = async (direccion, init) => {
    let r;
    try { r = await fetch(direccion, init); } catch { throw new ErrorNube('Sin conexión con la nube: se intentará más tarde'); }
    if (r.status === 401 || r.status === 403) throw new ErrorNube('La base de datos no ha dejado guardar los datos (permiso denegado)');
    if (r.status === 413) throw new ErrorNube('Hay un trozo demasiado grande para la nube');
    if (!r.ok) throw new ErrorNube(`La nube respondió con un error (${r.status})`);
    return r;
  };
  return {
    async leer(hueco, parte) { return (await pedir(url(hueco, parte))).json(); },
    async escribir(hueco, valor) { await pedir(url(hueco, '', true), { method: 'PUT', body: JSON.stringify(valor) }); },
    async borrar(hueco) { await pedir(url(hueco, '', true), { method: 'DELETE' }); },
  };
}

/**
 * La ficha que acompaña a cada hueco, con los mismos campos que ponen RepArena
 * y UltraMind (las reglas de la base de datos son las suyas): versión, hora,
 * equipo, de dónde viene y un número (los libros, o el trozo de una pieza).
 */
function fichaNueva(dev, n) {
  const at = Date.now();
  // Un número que no se repite aunque dos equipos escriban en el mismo milisegundo.
  return { ver: at * 1000 + Math.floor(Math.random() * 1000), at, dev, from: queEquipo(), n };
}

/** Hace `fn` con cada elemento, como mucho `max` a la vez. */
async function enParalelo(lista, max, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(max, lista.length) }, async () => {
    while (i < lista.length) await fn(lista[i++]);
  }));
}

// --- Piezas ----------------------------------------------------------------------

/** Una pieza de la nube, descifrada; `null` si falta algún trozo o no se puede leer. */
async function bajarPieza(red, clave, codigo, nombre, p) {
  const trozos = await Promise.all(Array.from({ length: p.n }, async (_, i) => {
    const valor = await red.leer(await huecoDe(codigo, 'p', p.u, i));
    return valor && typeof valor.blob === 'string' ? valor.blob : null;
  }));
  if (trozos.some(t => t === null)) return null;
  try { return await abrir(clave, trozos.join(''), paraPieza(nombre, p.u)); } catch { return null; }
}

/** Cifra una pieza (aún sin subirla): su referencia y sus trozos. */
async function prepararPieza(clave, nombre, contenido) {
  const u = hexAlAzar(8);
  const texto = await sellar(clave, contenido, paraPieza(nombre, u));
  const trozos = trocear(texto);
  return { ref: { u, n: trozos.length, b: texto.length }, trozos };
}

async function subirTrozos(red, codigo, dev, { ref, trozos }) {
  const escritos = [];
  try {
    for (let i = 0; i < trozos.length; i++) {
      const hueco = await huecoDe(codigo, 'p', ref.u, i);
      await red.escribir(hueco, { meta: fichaNueva(dev, i), blob: trozos[i] });
      escritos.push(hueco);
    }
  } catch (e) {
    // Una pieza a medias no sirve: fuera lo que se llegó a subir.
    await Promise.all(escritos.map(h => red.borrar(h).catch(() => undefined)));
    throw e;
  }
}

async function borrarPieza(red, codigo, p) {
  try {
    await Promise.all(Array.from({ length: p.n }, async (_, i) => red.borrar(await huecoDe(codigo, 'p', p.u, i))));
    return true;
  } catch { return false; }
}

/** Lo leído de la nube: el índice y su versión. */
async function leerNube(red, clave, hueco) {
  const valor = await red.leer(hueco);
  if (!valor || typeof valor.blob !== 'string') return { indice: null, ver: null };
  let abierto;
  try { abierto = await abrir(clave, valor.blob, 'indice'); } catch {
    throw new ErrorNube('No se pudieron leer los datos de la nube con este código');
  }
  const indice = leerIndice(abierto);
  if (indice === 'nuevo') throw new ErrorNube('La nube tiene datos de una versión más nueva de KindleVault: recarga la página');
  if (!indice) throw new ErrorNube('Lo que hay en la nube con este código no es una biblioteca de KindleVault');
  const ver = valor.meta && typeof valor.meta.ver === 'number' ? valor.meta.ver : null;
  return { indice, ver };
}

/** La versión del índice de la nube (solo su ficha, unos pocos bytes). */
export async function versionEnLaNube(codigo, red = redFirebase()) {
  const ficha = await red.leer(await huecoDe(limpiarCodigo(codigo)), '/meta');
  return ficha && typeof ficha.ver === 'number' ? ficha.ver : null;
}

// --- El cruce ----------------------------------------------------------------------

const memoriaNueva = dev => ({ dev: dev || hexAlAzar(6), piezas: {}, catalogo: null, pendientes: [], vistas: {}, limpiarDesde: null, ver: null, at: null });

/**
 * Un cruce completo con la nube. Devuelve qué ha pasado; si otro equipo
 * escribía a la vez, lo vuelve a intentar con lo suyo (hasta tres veces).
 */
async function cruzar({ red, codigo, lib, mem, guardarMemoria, alTraer, crearSiFalta }) {
  const clave = await claveDe(codigo);
  const huecoIndice = await huecoDe(codigo);
  // Lo subido en intentos cuyo índice no llegó a escribirse (o lo pisó otro
  // equipo): si nadie lo usa, irá a sobras para borrarse sin prisa.
  const sueltas = [...(mem.pendientes || [])];
  let trajo = false;

  for (let intento = 0; intento < 3; intento++) {
    const leidoA = Date.now();
    const { indice: anterior, ver: verAnterior } = await leerNube(red, clave, huecoIndice);
    if (!anterior && !crearSiFalta) {
      return { ok: false, vacio: true, mensaje: 'No hay nada guardado con ese código: comprueba que esté bien escrito' };
    }
    const refs = anterior ? anterior.piezas : {};
    // Piezas que este equipo dio por buenas en su último cruce y que el índice
    // ya no nombra (otro equipo escribió encima justo a la vez): nadie las usa,
    // así que van a sobras en vez de quedarse para siempre en la nube.
    if (anterior) {
      const conocidas = new Set([...Object.values(refs), ...anterior.sobras, ...sueltas].map(p => p.u));
      for (const p of Object.values(mem.piezas)) {
        if (p.u && p.n && !conocidas.has(p.u)) { sueltas.push({ u: p.u, n: p.n }); conocidas.add(p.u); }
      }
    }

    // 1. Qué bajar: lo que ha cambiado en la nube desde el último cruce de este
    //    equipo y, si aquí hay menos que entonces (datos borrados, algo raro),
    //    también, para no subir nunca algo que deje la nube con menos.
    const antes = await piezasLocales(lib);
    const bajadas = new Map();
    const faltan = new Set();
    const cambiadas = Object.keys(refs).filter(n => {
      const m = mem.piezas[n];
      return !m || m.u !== refs[n].u || ((antes.get(n) || {}).cuenta || 0) < m.c || (n === 'catalogo' && !mem.catalogo);
    });
    await enParalelo(cambiadas, 6, async nombre => {
      const c = await bajarPieza(red, clave, codigo, nombre, refs[nombre]);
      if (c === null) faltan.add(nombre); else bajadas.set(nombre, c);
    });
    // Sin el catálogo no se sabe de qué libro es cada cosa: mejor esperar.
    if (faltan.has('catalogo')) throw new ErrorNube('No se pudo traer el catálogo de la nube: se intentará más tarde');
    const catalogoNube = bajadas.get('catalogo') || (refs.catalogo ? mem.catalogo : null);
    if (refs.catalogo && !catalogoNube) throw new ErrorNube('Falta el catálogo de la nube: se intentará más tarde');

    // 2. Lo traído, aquí.
    const cat = leerCatalogo(catalogoNube);
    const datos = { books: cat.books, device: cat.device, highlights: [], vocab: [], wordStatus: [] };
    const librosNube = new Map(cat.books.map(b => [b.key, b]));
    for (const [nombre, c] of bajadas) {
      if (nombre === 'estados') datos.wordStatus = leerEstados(c);
      else if (esCubo(nombre)) {
        const { highlights, vocab } = leerCubo(c, librosNube);
        datos.highlights.push(...highlights);
        datos.vocab.push(...vocab);
      }
    }
    const cambioAqui = lib.merge(datos);
    if (cambioAqui) {
      lib.guessMissingLanguages();
      trajo = true;
    }
    // 3. Cómo están las piezas aquí ahora (lo que se cambie desde aquí irá en el próximo cruce).
    const locales = cambioAqui ? await piezasLocales(lib) : antes;
    if (cambioAqui) { await lib.save(); alTraer(); }

    // 4. Qué hay que subir: las piezas en las que aquí hay algo que la nube no tiene.
    const nuevas = { ...refs };
    const preparadas = [];
    const contenidoNube = new Map();
    for (const nombre of new Set([...Object.keys(refs), ...locales.keys()])) {
      if (faltan.has(nombre)) continue;
      const ref = refs[nombre], memP = mem.piezas[nombre], loc = locales.get(nombre);
      if (!loc) continue; // aquí no hay nada de esa pieza: lo de la nube se queda como está
      // Nada nuevo en ningún lado: ni se baja ni se sube.
      if (ref && !bajadas.has(nombre) && memP && memP.d === loc.huella) continue;
      let subir = null;
      if (!ref) subir = loc.contenido;
      else {
        // Lo de la nube: lo bajado ahora o, del catálogo, lo recordado del último cruce.
        const base = bajadas.get(nombre) || (nombre === 'catalogo' ? mem.catalogo : null);
        if (base) {
          const u = unirPieza(nombre, base, loc.contenido);
          if (u.cambiado) subir = u.contenido;
          else contenidoNube.set(nombre, base);
        } else subir = loc.contenido; // la nube no ha cambiado desde el último cruce y aquí está todo lo suyo, y más
      }
      if (subir) {
        preparadas.push({ nombre, ...(await prepararPieza(clave, nombre, subir)) });
        contenidoNube.set(nombre, subir);
      }
    }

    // Antes de subir nada, se apunta: si la página se cierra a medias, el
    // próximo cruce sabrá que eso quedó suelto y lo borrará.
    const subidas = preparadas.map(p => p.ref);
    if (subidas.length) {
      mem.pendientes = [...sueltas, ...subidas];
      await guardarMemoria(mem);
    }
    try {
      await enParalelo(preparadas, 4, async p => {
        await subirTrozos(red, codigo, mem.dev, p);
        nuevas[p.nombre] = p.ref;
      });
    } catch (e) {
      sueltas.push(...subidas);
      throw e;
    }

    // 5. Las sobras que este equipo ya lleva viendo un rato, fuera.
    const borradas = new Set();
    let vistas = mem.vistas || {};
    if (anterior) {
      const r = sobrasParaBorrar(anterior, vistas, Date.now());
      vistas = r.vistas;
      for (const s of r.borrar) if ((await borrarPieza(red, codigo, s)) || r.olvidar.has(s.u)) borradas.add(s.u);
    }

    // 6. El índice nuevo, si dice algo distinto.
    const nuevo = componerIndice({ anterior, piezas: nuevas, borradas, sueltas, ahora: Date.now() });
    let ver = verAnterior;
    if (!anterior || !mismoIndice(anterior, nuevo)) {
      // Demasiado tiempo desde que se leyó: otro equipo podría haber dado por
      // sobrante algo de lo que se iba a escribir. Otra vez, desde el principio.
      if (Date.now() - leidoA > LECTURA_MAX) {
        await Promise.all(subidas.map(p => borrarPieza(red, codigo, p)));
        continue;
      }
      const catalogoFinal = contenidoNube.get('catalogo') || catalogoNube;
      const ficha = fichaNueva(mem.dev, catalogoFinal && Array.isArray(catalogoFinal.libros) ? catalogoFinal.libros.length : 0);
      await red.escribir(huecoIndice, { meta: ficha, blob: await sellar(clave, nuevo, 'indice') });
      const leida = await red.leer(huecoIndice, '/meta');
      if (!leida || leida.ver !== ficha.ver) {
        // Otro equipo ha escrito justo después: se vuelve a cruzar con lo suyo.
        // Lo subido aquí no se borra ya (ese otro índice podría usarlo): si al
        // final nadie lo usa, irá a sobras.
        sueltas.push(...subidas);
        continue;
      }
      ver = ficha.ver;
    }

    // 7. Lo acordado con la nube, para el próximo cruce.
    for (const [nombre, ref] of Object.entries(nuevo.piezas)) {
      if (faltan.has(nombre)) continue; // se volverá a intentar
      const loc = locales.get(nombre);
      mem.piezas[nombre] = { u: ref.u, n: ref.n, d: loc ? loc.huella : null, c: loc ? loc.cuenta : 0 };
    }
    for (const nombre of Object.keys(mem.piezas)) if (!nuevo.piezas[nombre]) delete mem.piezas[nombre];
    if (contenidoNube.has('catalogo')) mem.catalogo = contenidoNube.get('catalogo');
    else if (bajadas.has('catalogo')) mem.catalogo = bajadas.get('catalogo');
    if (!nuevo.piezas.catalogo) mem.catalogo = null;
    mem.pendientes = [];
    // Las sobras del índice, con cuándo las vio este equipo sin usar por primera
    // vez (las que acaba de dejar él, ahora mismo).
    const ahora = Date.now();
    mem.vistas = Object.fromEntries(nuevo.sobras.map(s => [s.u, vistas[s.u] ?? ahora]));
    const primera = Math.min(...Object.values(mem.vistas));
    mem.limpiarDesde = Number.isFinite(primera) ? primera + SOBRAS_ESPERA : null;
    mem.ver = ver;
    mem.at = Date.now();
    mem.tamano = { piezas: Object.keys(nuevo.piezas).length, bytes: tamanoEnLaNube(nuevo) };
    await guardarMemoria(mem);

    return {
      ok: true, trajo, subio: subidas.length, faltan: faltan.size, ver, repetir: faltan.size > 0,
      piezas: Object.keys(nuevo.piezas).length, tamano: tamanoEnLaNube(nuevo),
    };
  }
  return { ok: false, mensaje: 'Otro equipo estaba sincronizando a la vez: se intentará otra vez en un momento', repetir: true };
}

// --- El gestor ---------------------------------------------------------------------

/**
 * La sincronización con un código de este navegador: el código, su estado
 * para la interfaz y cuándo cruzar (al abrir, al volver a la página, un rato
 * después de cada cambio y cuando otro equipo sube algo).
 *
 * `cerrojo` es el mismo que usa el archivo de sincronización: nunca van dos
 * cruces a la vez sobre la misma biblioteca.
 */
export class NubeSync {
  constructor(library, { onStatus = () => {}, onMerged = () => {}, red = null, cerrojo = fn => fn() } = {}) {
    this.library = library;
    this.onStatus = onStatus;
    this.onMerged = onMerged;
    this.red = red || redFirebase();
    this.cerrojo = cerrojo;
    this.codigo = null;
    this.state = 'off';       // off | syncing | ok | error
    this.error = null;
    this.lastSync = null;     // hora (ms) del último cruce bueno
    this.ver = null;          // versión del índice tras el último cruce
    this.tamano = null;       // lo que ocupa la biblioteca en la nube ({ piezas, bytes })
    this._mem = null;
    this._busy = null;
    this._timer = null;
    this._vigilando = false;
  }

  _set(state, error = null) {
    this.state = state;
    this.error = error;
    this.onStatus(this);
  }

  async _memoria() {
    if (!this._mem) {
      const m = await kvGet(KV_MEMORIA);
      this._mem = m && typeof m === 'object' && m.piezas ? m : memoriaNueva(m && m.dev);
      if (!this._mem.dev) this._mem.dev = hexAlAzar(6);
    }
    return this._mem;
  }

  async _guardarMemoria(mem) {
    this._mem = mem;
    await kvSet(KV_MEMORIA, mem);
  }

  /** Cambia el código (o lo quita): lo recordado del anterior ya no vale. */
  async _guardarCodigo(codigo) {
    const mem = await this._memoria();
    await this._guardarMemoria(memoriaNueva(mem.dev));
    this.codigo = codigo ? limpiarCodigo(codigo) : null;
    this.ver = null;
    this.lastSync = null;
    this.tamano = null;
    await kvSet(KV_CODIGO, this.codigo || undefined);
  }

  async init() {
    const codigo = await kvGet(KV_CODIGO);
    this.codigo = typeof codigo === 'string' && codigoValido(codigo) ? limpiarCodigo(codigo) : null;
    if (!this.codigo) { this._set('off'); return; }
    const mem = await this._memoria();
    this.ver = mem.ver;
    this.lastSync = mem.at;
    if (mem.tamano) this.tamano = mem.tamano;
    this.vigilar();
    await this.syncNow();
  }

  /** Crea un código nuevo y sube ya lo de aquí. Devuelve el resultado del primer cruce. */
  async crear() {
    await this._guardarCodigo(codigoNuevo());
    const r = await this.syncNow({ crearSiFalta: true });
    if (!r.ok) {
      // Sin subir nada, el código no le sirve al otro equipo.
      await this._guardarCodigo(null);
      this._set('off');
    } else this.vigilar();
    return r;
  }

  /** Vincula este equipo con el código de otro: si con ese código no hay nada, no se queda. */
  async vincular(texto) {
    if (!codigoValido(texto)) return { ok: false, mensaje: 'El código tiene 16 cifras' };
    await this._guardarCodigo(texto);
    const r = await this.syncNow({ crearSiFalta: false });
    if (!r.ok) {
      await this._guardarCodigo(null);
      this._set('off');
    } else this.vigilar();
    return r;
  }

  async desvincular() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this._busy) await this._busy.catch(() => undefined);
    await this._guardarCodigo(null);
    this._set('off');
  }

  /**
   * Los datos de este navegador se han borrado: lo recordado ya no dice la
   * verdad, así que el próximo cruce empieza de cero (trae todo de la nube y
   * no sube nada que la deje con menos).
   */
  async olvidar() {
    const mem = await this._memoria();
    await this._guardarMemoria(memoriaNueva(mem.dev));
    this.ver = null;
  }

  /** Un cruce un rato después del último cambio (junta los cambios seguidos). */
  schedule(espera = NUBE_ESPERA) {
    if (!this.codigo) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this.syncNow(); }, espera);
  }

  async syncNow({ crearSiFalta = true } = {}) {
    if (!this.codigo) return { ok: false };
    clearTimeout(this._timer);
    this._timer = null;
    while (this._busy) await this._busy.catch(() => undefined);
    const codigo = this.codigo;
    this._busy = this.cerrojo(() => this._cruzar(codigo, crearSiFalta));
    try { return await this._busy; } finally { this._busy = null; }
  }

  async _cruzar(codigo, crearSiFalta) {
    if (this.codigo !== codigo) return { ok: false };
    this._set('syncing');
    let r;
    try {
      const mem = await this._memoria();
      r = await cruzar({
        red: this.red, codigo, lib: this.library, mem, crearSiFalta,
        guardarMemoria: m => this._guardarMemoria(m),
        alTraer: () => this.onMerged(),
      });
    } catch (e) {
      r = { ok: false, mensaje: e instanceof ErrorNube ? e.message : 'No se pudo sincronizar con la nube: se intentará más tarde', repetir: true };
      if (!(e instanceof ErrorNube)) console.error(e);
    }
    // Si mientras tanto se ha desvinculado, lo de este cruce ya no cuenta.
    if (this.codigo !== codigo) return r;
    if (r.ok) {
      this.ver = r.ver ?? null;
      this.tamano = { piezas: r.piezas, bytes: r.tamano };
      this.lastSync = Date.now();
      this._set('ok');
      if (r.repetir) this.schedule(60_000);
    } else {
      this._set('error', r.mensaje || 'No se pudo sincronizar');
      if (r.repetir) this.schedule(60_000);
    }
    return r;
  }

  /**
   * Con un código, la nube se mira al volver a la página y, mientras se ve,
   * cada pocos minutos (solo la ficha del índice: unos bytes). Al salir de la
   * página, lo pendiente se sube ya.
   */
  vigilar() {
    if (this._vigilando || typeof document === 'undefined') return;
    this._vigilando = true;
    document.addEventListener('visibilitychange', () => {
      if (!this.codigo) return;
      if (document.visibilityState === 'hidden') {
        if (this._timer) this.syncNow();
      } else this._mirar();
    });
    setInterval(() => this._mirar(), NUBE_VISTAZO);
    // Al volver la conexión, lo pendiente sale ya.
    window.addEventListener('online', () => { if (this.codigo) this.syncNow(); });
  }

  async _mirar() {
    if (!this.codigo || this._busy || document.visibilityState !== 'visible') return;
    // Si lo último falló (sin red, quizá), se vuelve a intentar entero.
    if (this.state === 'error') { this.syncNow(); return; }
    // Hay piezas viejas que ya se pueden borrar: un cruce las quita.
    const mem = await this._memoria();
    if (mem.limpiarDesde && Date.now() >= mem.limpiarDesde) { this.syncNow(); return; }
    try {
      const ver = await versionEnLaNube(this.codigo, this.red);
      if (ver !== this.ver) this.syncNow();
    } catch { /* sin red: ya se mirará */ }
  }
}
