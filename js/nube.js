/**
 * Sincronizar con un código: la biblioteca entre el móvil y el ordenador, sin
 * archivo, sin cuenta y sin servidor propio.
 *
 * Es la misma idea que en UltraMind y RepArena: en un equipo se crea un código
 * fijo de 16 cifras y en el otro se escribe una vez. Cada equipo deja sus
 * datos cifrados con ese código en una Realtime Database de Firebase (por su
 * API web, sin librerías). Firebase solo ve algo ilegible en huecos cuyo nombre
 * sale del código, y sus reglas no dejan listar nada: sin el código, nadie sabe
 * dónde están ni puede leerlos.
 *
 * Para ocupar poco en la base de datos y bajar solo lo que cambia, la
 * biblioteca no va en un solo paquete, sino en «piezas»:
 *
 *   · «catalogo»: las fichas de los libros y lo último que se leyó del Kindle;
 *   · «estados»: las marcas de las palabras (Enviada, Me la sé, Ignorar);
 *   · «c0» … «c63»: los subrayados y las palabras, repartidos en 64 cajones
 *     según el título del libro (todo lo de un libro va al mismo cajón).
 *
 * Cada pieza va comprimida, por columnas (sin repetir los nombres de los
 * campos) y sin lo que se puede volver a sacar (la forma base cuando es la
 * misma palabra, el título del libro en cada palabra…). Un índice pequeño dice
 * qué piezas hay. Una pieza no se vuelve a escribir: si cambia, la nueva va en
 * otro hueco y la vieja queda como «sobra», que se borra pasado un rato (así,
 * otro equipo que la estuviera bajando en ese momento no se queda a medias).
 *
 * Al juntar no se pierde nada: los subrayados y las palabras se suman (por su
 * huella), las marcas de las palabras y las correcciones de libro valen por la
 * más reciente, y las fichas de los libros se completan unas con otras. Es lo
 * mismo que hace el archivo de sincronización (`Library.merge`).
 */

import { hash53 } from './parser.js';
import { titleParts, mergeBookFields } from './store.js';

/**
 * La Realtime Database: la del proyecto de Firebase «reparena» (la misma que
 * usan RepArena y UltraMind), cuyas reglas solo dejan leer y escribir en
 * `sync/<hueco de 64 cifras>` un `blob` (menos de 3 MB) y su ficha (`meta`).
 * Lo de KindleVault va en huecos propios: salen de otro prefijo y otra sal, así
 * que no se cruza con nada de las otras aplicaciones.
 */
export const NUBE_BASE = 'https://reparena-62309-default-rtdb.europe-west1.firebasedatabase.app';

/** Cifras del código. */
export const LARGO_CODIGO = 16;
/** Cada trozo de una pieza, holgado por debajo de los 3 MB que admiten las reglas. */
export const TROZO_MAX = 2_000_000;
/** Cajones de subrayados y palabras. */
export const CUBOS = 64;
/**
 * Lo que espera una pieza sin usar antes de borrarse. Cuenta desde que este
 * equipo la vio sin usar (no desde la hora de otro equipo, que puede ir mal).
 */
export const SOBRAS_ESPERA = 10 * 60 * 1000;
/**
 * Lo más que puede tardar un cruce entre leer el índice y escribir el nuevo.
 * Bastante menos que `SOBRAS_ESPERA`: así nadie escribe un índice con una
 * pieza que otro ya ha dado por sobrante y borrado.
 */
export const LECTURA_MAX = 4 * 60 * 1000;
/** Si una sobra no se deja borrar en una semana, se deja de apuntar (el índice no crece sin fin). */
export const SOBRAS_ABANDONO = 7 * 24 * 60 * 60 * 1000;

export const FORMATO_INDICE = 'kindlevault-nube';
export const VERSION_INDICE = 1;

const SAL = 'kindlevault-sync-v1';
const PREFIJO = 'kindlevault-sync';
const ITERACIONES = 150_000;

// --- El código -------------------------------------------------------------------

/** Solo las cifras de lo escrito (los espacios y guiones no cuentan). */
export function limpiarCodigo(texto) {
  return String(texto ?? '').replace(/\D/g, '');
}

export function codigoValido(texto) {
  return new RegExp(`^\\d{${LARGO_CODIGO}}$`).test(limpiarCodigo(texto));
}

/** De cuatro en cuatro, para leerlo y escribirlo sin perderse: «1234 5678 …». */
export function formatearCodigo(codigo) {
  return limpiarCodigo(codigo).replace(/(\d{4})(?=\d)/g, '$1 ');
}

/** Un código nuevo, al azar de verdad (no `Math.random`). */
export function codigoNuevo() {
  const bytes = new Uint32Array(LARGO_CODIGO);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, n => String(n % 10)).join('');
}

/** Cifras hexadecimales al azar, para el id de este equipo y de cada subida. */
export function hexAlAzar(bytes) {
  const datos = new Uint8Array(bytes);
  crypto.getRandomValues(datos);
  return Array.from(datos, b => b.toString(16).padStart(2, '0')).join('');
}

/** Quién escribe, como lo dicen RepArena y UltraMind: «el móvil» o «el ordenador». */
export function queEquipo() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  return /Mobi|Android|iPhone|iPad/i.test(ua) ? 'el móvil' : 'el ordenador';
}

// --- Cifrado ---------------------------------------------------------------------

const codificador = new TextEncoder();
const decodificador = new TextDecoder();

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 de un texto, en cifras hexadecimales. */
export async function sha256(texto) {
  return hex(await crypto.subtle.digest('SHA-256', codificador.encode(texto)));
}

/**
 * El hueco de algo en la nube: 64 cifras que salen del código y de qué es (el
 * índice, o el trozo tal de la pieza cual). Sin el código no se pueden
 * calcular, y de uno no se saca otro.
 */
export function huecoDe(codigo, ...partes) {
  return sha256([PREFIJO, limpiarCodigo(codigo), ...partes].join(':'));
}

const claves = new Map();

/**
 * La clave sale del código con PBKDF2 (150 000 vueltas): adivinarla probando
 * códigos cuesta. Se calcula una vez por sesión.
 */
export function claveDe(codigo) {
  const limpio = limpiarCodigo(codigo);
  let clave = claves.get(limpio);
  if (!clave) {
    clave = (async () => {
      const base = await crypto.subtle.importKey('raw', codificador.encode(limpio), 'PBKDF2', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: codificador.encode(SAL), iterations: ITERACIONES, hash: 'SHA-256' },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
    })();
    claves.set(limpio, clave);
    clave.catch(() => claves.delete(limpio)); // si falla, que el siguiente intento vuelva a probar
  }
  return clave;
}

async function pasarPor(bytes, flujo) {
  const salida = new Response(bytes).body.pipeThrough(flujo);
  return new Uint8Array(await new Response(salida).arrayBuffer());
}

function aBase64(bytes) {
  let texto = '';
  for (let i = 0; i < bytes.length; i += 0x8000) texto += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(texto);
}

function deBase64(texto) {
  const binario = atob(texto);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

/**
 * Cifra algo para dejarlo en la nube: JSON, comprimido si el navegador sabe,
 * AES-GCM y en texto (base64). El primer byte dice si va comprimido, los doce
 * siguientes son el vector inicial. `para` ata el paquete a su sitio: un índice
 * no se puede hacer pasar por una pieza ni una pieza por otra.
 */
export async function sellar(clave, valor, para) {
  const plano = codificador.encode(JSON.stringify(valor));
  const comprime = typeof CompressionStream !== 'undefined';
  const cuerpo = comprime ? await pasarPor(plano, new CompressionStream('deflate-raw')) : plano;
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: codificador.encode(para) }, clave, cuerpo));
  const todo = new Uint8Array(13 + cifrado.length);
  todo[0] = comprime ? 1 : 0;
  todo.set(iv, 1);
  todo.set(cifrado, 13);
  return aBase64(todo);
}

/** Lo contrario de `sellar`. Falla si el código no es el bueno o el paquete no es de ese sitio. */
export async function abrir(clave, texto, para) {
  const todo = deBase64(texto);
  const plano = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: todo.slice(1, 13), additionalData: codificador.encode(para) }, clave, todo.slice(13),
  ));
  const cuerpo = todo[0] === 1 ? await pasarPor(plano, new DecompressionStream('deflate-raw')) : plano;
  return JSON.parse(decodificador.decode(cuerpo));
}

/** Parte un texto en trozos que quepan en un hueco. */
export function trocear(texto, max = TROZO_MAX) {
  if (texto.length <= max) return [texto];
  const trozos = [];
  for (let i = 0; i < texto.length; i += max) trozos.push(texto.slice(i, i + max));
  return trozos;
}

/** Con qué se ata cada pieza al cifrarla: su nombre y su subida. */
export const paraPieza = (nombre, u) => `pieza:${nombre}:${u}`;

// --- Columnas ----------------------------------------------------------------------

const CAMPO_PROHIBIDO = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Filas → columnas: [{a:1,b:2},{a:3}] → { n: 2, c: { a: [1,3], b: [2,null] } }.
 * Los nombres de los campos van una sola vez, y los vacíos no ocupan.
 */
export function aColumnas(filas) {
  const c = {};
  filas.forEach((fila, i) => {
    for (const [k, v] of Object.entries(fila)) {
      if (v === null || v === undefined || CAMPO_PROHIBIDO.has(k)) continue;
      if (!c[k]) c[k] = new Array(filas.length).fill(null);
      c[k][i] = v;
    }
  });
  return { n: filas.length, c: Object.fromEntries(Object.keys(c).sort().map(k => [k, c[k]])) };
}

/** Columnas → filas (sin los campos vacíos). */
export function deColumnas(t) {
  if (!t || typeof t !== 'object' || !Number.isInteger(t.n) || t.n < 0 || t.n > 1_000_000 || typeof t.c !== 'object' || !t.c) return [];
  const filas = Array.from({ length: t.n }, () => ({}));
  for (const [k, col] of Object.entries(t.c)) {
    if (!Array.isArray(col) || CAMPO_PROHIBIDO.has(k)) continue;
    for (let i = 0; i < t.n; i++) {
      const v = col[i];
      if (v !== null && v !== undefined) filas[i][k] = v;
    }
  }
  return filas;
}

// --- Las piezas -------------------------------------------------------------------

export const esCubo = nombre => /^c\d{1,2}$/.test(nombre) && +nombre.slice(1) < CUBOS;
export const nombreValido = nombre => nombre === 'catalogo' || nombre === 'estados' || esCubo(nombre);

const porTexto = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sinVacios = o => Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== null && v !== undefined && !CAMPO_PROHIBIDO.has(k)));

/**
 * El cajón de un libro: sale de la parte principal de su título, así que dos
 * fichas que la biblioteca da por el mismo libro («Sapiens» y «Sapiens: De
 * animales a dioses») caen siempre en el mismo, en cualquier equipo.
 */
export function cuboDeTitulo(titulo) {
  return parseInt(hash53('t:' + titleParts(titulo).main).slice(-7), 16) % CUBOS;
}
/** Lo que no tiene libro, por su huella. */
export function cuboDeId(id) {
  return parseInt(hash53('i:' + id).slice(-7), 16) % CUBOS;
}

/** Una palabra, sin lo que se puede volver a sacar al leerla. */
function palabraCompacta(v, libros) {
  const o = { ...v };
  delete o.mastered; // solo cuenta al importar (y entonces se convierte en «Me la sé», que viaja aparte)
  if (o.stem === o.word) delete o.stem;
  if (o.bookKey && libros.has(o.bookKey)) delete o.book_title;
  return sinVacios(o);
}

/** Lo que va en el catálogo: las fichas de los libros y el último inventario del Kindle. */
export function contenidoCatalogo(libros, kindle) {
  return {
    libros: [...libros].sort((a, b) => porTexto(a.key, b.key)).map(sinVacios),
    kindle: kindle ? JSON.parse(JSON.stringify(kindle)) : null,
  };
}

/** Las marcas de las palabras, por columnas. */
export function contenidoEstados(estados) {
  return aColumnas([...estados].sort((a, b) => porTexto(a.key, b.key)));
}

/** Un cajón: sus subrayados y sus palabras, por columnas. */
export function contenidoCubo(subrayados, palabras, libros) {
  return {
    h: aColumnas([...subrayados].sort((a, b) => porTexto(a.hash, b.hash)).map(sinVacios)),
    v: aColumnas([...palabras].sort((a, b) => porTexto(a.key, b.key)).map(v => palabraCompacta(v, libros))),
  };
}

/**
 * Las piezas de esta biblioteca tal como irían a la nube, cada una con lo que
 * cuenta (filas) y su huella: si la huella no ha cambiado desde el último
 * cruce, aquí no ha cambiado nada de esa pieza. Todo se copia de una vez (sin
 * esperas por medio), así que es una foto fiel aunque luego cambie algo.
 */
export async function piezasLocales(lib) {
  const libros = new Map([...lib.books.values()].map(b => [b.key, b]));
  const cuboDe = (bookKey, id) => {
    const b = bookKey && libros.get(bookKey);
    return b ? cuboDeTitulo(b.title) : cuboDeId(id);
  };
  const cubos = Array.from({ length: CUBOS }, () => ({ h: [], v: [] }));
  for (const h of lib.highlights.values()) cubos[cuboDe(h.bookKey, h.hash)].h.push(h);
  for (const v of lib.vocab.values()) cubos[cuboDe(v.bookKey, v.key)].v.push(v);
  const estados = [...lib.wordStatus.entries()].map(([key, v]) => ({ ...v, key }));
  const lista = [
    ['catalogo', contenidoCatalogo(libros.values(), lib.device), libros.size + (lib.device ? 1 : 0)],
    ['estados', contenidoEstados(estados), estados.length],
    ...cubos.map((c, i) => ['c' + i, contenidoCubo(c.h, c.v, libros), c.h.length + c.v.length]),
  ];
  const piezas = new Map();
  for (const [nombre, contenido, cuenta] of lista) {
    if (cuenta) piezas.set(nombre, { contenido, cuenta, huella: await sha256(JSON.stringify(contenido)) });
  }
  return piezas;
}

// --- Leer lo de la nube -------------------------------------------------------------

/** El catálogo de la nube, como lo entiende `Library.merge`. */
export function leerCatalogo(contenido) {
  const o = contenido && typeof contenido === 'object' ? contenido : {};
  const libros = Array.isArray(o.libros) ? o.libros.filter(b => b && typeof b.key === 'string' && typeof b.title === 'string') : [];
  const kindle = o.kindle && typeof o.kindle === 'object' && Array.isArray(o.kindle.keys) ? o.kindle : null;
  return { books: libros.map(b => ({ ...b })), device: kindle };
}

export function leerEstados(contenido) {
  return deColumnas(contenido).filter(e => typeof e.key === 'string' && typeof e.at === 'string');
}

/** Un cajón de la nube; `libros` (del catálogo) devuelve el título a sus palabras. */
export function leerCubo(contenido, libros = new Map()) {
  const o = contenido && typeof contenido === 'object' ? contenido : {};
  const highlights = deColumnas(o.h).filter(h => typeof h.hash === 'string' && typeof h.bookKey === 'string');
  const vocab = deColumnas(o.v).filter(v => typeof v.key === 'string' && typeof v.word === 'string').map(v => {
    if (v.stem === undefined) v.stem = v.word;
    if (v.bookKey === undefined) v.bookKey = null;
    if (v.book_title === undefined) v.book_title = (v.bookKey && libros.get(v.bookKey) || {}).title || null;
    return v;
  });
  return { highlights, vocab };
}

// --- Juntar dos versiones de una pieza ------------------------------------------------

/**
 * El catálogo de la nube junta las fichas de todos los equipos, cada una por
 * su clave: así, lo que suba cualquier equipo encuentra siempre su libro (y
 * `Library.merge` ya junta en cada equipo las fichas que son el mismo libro).
 */
export function unirCatalogo(nube, local) {
  const libros = new Map((nube.libros || []).map(b => [b.key, { ...b }]));
  let cambiado = false;
  for (const b of local.libros || []) {
    const ya = libros.get(b.key);
    if (!ya) { libros.set(b.key, { ...b }); cambiado = true; }
    else if (mergeBookFields(ya, b)) cambiado = true;
  }
  let kindle = nube.kindle || null;
  if (local.kindle && (!kindle || (local.kindle.scannedAt || '') > (kindle.scannedAt || ''))) { kindle = local.kindle; cambiado = true; }
  return { contenido: contenidoCatalogo(libros.values(), kindle), cambiado };
}

/** Las marcas: de cada palabra, la más reciente. */
export function unirEstados(nube, local) {
  const todas = new Map(deColumnas(nube).map(e => [e.key, e]));
  let cambiado = false;
  for (const e of deColumnas(local)) {
    const ya = todas.get(e.key);
    if (!ya || (e.at || '') > (ya.at || '')) { todas.set(e.key, e); cambiado = true; }
  }
  return { contenido: contenidoEstados(todas.values()), cambiado };
}

/** Un cajón: se suman los subrayados y las palabras; de cada uno, la corrección de libro más reciente. */
export function unirCubo(nube, local) {
  let cambiado = false;
  const juntar = (a, b, id) => {
    const todos = new Map(deColumnas(a).map(x => [x[id], x]));
    for (const x of deColumnas(b)) {
      const ya = todos.get(x[id]);
      if (!ya) { todos.set(x[id], x); cambiado = true; }
      else if (x.bookAt && x.bookAt > (ya.bookAt || '')) {
        const nuevo = { ...ya, bookAt: x.bookAt };
        if (x.bookKey) nuevo.bookKey = x.bookKey; else delete nuevo.bookKey;
        // El título de una palabra sin libro viaja con ella.
        if (x.book_title) nuevo.book_title = x.book_title;
        todos.set(x[id], nuevo);
        cambiado = true;
      }
    }
    return aColumnas([...todos.values()].sort((p, q) => porTexto(p[id], q[id])));
  };
  const h = juntar(nube.h, local.h, 'hash');
  const v = juntar(nube.v, local.v, 'key');
  return { contenido: { h, v }, cambiado };
}

export function unirPieza(nombre, nube, local) {
  if (nombre === 'catalogo') return unirCatalogo(nube, local);
  if (nombre === 'estados') return unirEstados(nube, local);
  return unirCubo(nube, local);
}

// --- El índice ---------------------------------------------------------------------

/**
 * Una pieza en la nube: su subida (`u`, 16 cifras hexadecimales), en cuántos
 * trozos va (`n`) y cuánto ocupa (`b`, en caracteres; para decir cuánto se usa).
 */
const esRef = p => !!p && typeof p.u === 'string' && /^[0-9a-f]{16}$/.test(p.u) && Number.isInteger(p.n) && p.n >= 1 && p.n <= 64;
const refLimpia = p => (Number.isInteger(p.b) && p.b >= 0 ? { u: p.u, n: p.n, b: p.b } : { u: p.u, n: p.n });

/**
 * Lee un índice ya descifrado, aceptando solo lo que entiende. Devuelve
 * `'nuevo'` si es de una versión de KindleVault más nueva que esta: entonces no
 * se toca, para no estropear lo que esa versión guardó.
 */
export function leerIndice(valor) {
  if (typeof valor !== 'object' || valor === null) return null;
  if (valor.formato !== FORMATO_INDICE) return null;
  if (Number(valor.v) > VERSION_INDICE) return 'nuevo';
  const piezas = {};
  if (valor.piezas && typeof valor.piezas === 'object') {
    for (const [nombre, p] of Object.entries(valor.piezas)) {
      if (nombreValido(nombre) && esRef(p)) piezas[nombre] = refLimpia(p);
    }
  }
  const sobras = Array.isArray(valor.sobras)
    ? valor.sobras.filter(s => esRef(s) && Number.isFinite(s.at)).map(s => ({ u: s.u, n: s.n, at: s.at }))
    : [];
  return { formato: FORMATO_INDICE, v: VERSION_INDICE, updatedAt: Number(valor.updatedAt) || 0, cubos: CUBOS, piezas, sobras };
}

/**
 * El índice nuevo tras un cruce: las piezas de ahora y, como sobras, lo que el
 * índice de antes usaba y este ya no, lo subido en intentos que no llegaron a
 * escribirse (`sueltas`) y las sobras de antes que no se hayan borrado ya.
 */
export function componerIndice({ anterior, piezas, borradas = new Set(), sueltas = [], ahora }) {
  const usadas = new Set(Object.values(piezas).map(p => p.u));
  const sobras = new Map();
  for (const s of anterior ? anterior.sobras : []) sobras.set(s.u, s);
  if (anterior) for (const p of Object.values(anterior.piezas)) if (!sobras.has(p.u)) sobras.set(p.u, { u: p.u, n: p.n, at: ahora });
  for (const p of sueltas) if (!sobras.has(p.u)) sobras.set(p.u, { u: p.u, n: p.n, at: ahora });
  const ordenadas = Object.fromEntries(Object.keys(piezas).sort().map(k => [k, refLimpia(piezas[k])]));
  return {
    formato: FORMATO_INDICE,
    v: VERSION_INDICE,
    updatedAt: ahora,
    cubos: CUBOS,
    piezas: ordenadas,
    sobras: [...sobras.values()].filter(s => !usadas.has(s.u) && !borradas.has(s.u)),
  };
}

/** JSON con las claves en orden: dos índices iguales dan el mismo texto. */
function canonico(valor) {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor) ?? 'null';
  if (Array.isArray(valor)) return `[${valor.map(x => canonico(x ?? null)).join(',')}]`;
  return `{${Object.keys(valor).filter(k => valor[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonico(valor[k])}`).join(',')}}`;
}

/** Lo que ocupan en la nube las piezas de un índice (en caracteres, más o menos bytes). */
export function tamanoEnLaNube(indice) {
  return indice ? Object.values(indice.piezas).reduce((t, p) => t + (p.b || 0), 0) : 0;
}

/** ¿Dicen lo mismo? La hora de escritura no cuenta. */
export function mismoIndice(a, b) {
  return canonico({ ...a, updatedAt: 0 }) === canonico({ ...b, updatedAt: 0 });
}

/**
 * Qué sobras puede borrar ya este equipo: las que lleva viendo sin usar al
 * menos `SOBRAS_ESPERA`, por su propio reloj. `vistas` es cuándo vio cada una
 * por primera vez; sale actualizado (sin las que ya no están).
 */
export function sobrasParaBorrar(indice, vistas, ahora) {
  const nuevas = {};
  const borrar = [];
  const olvidar = new Set();
  for (const s of indice.sobras) {
    const desde = vistas[s.u] ?? ahora;
    nuevas[s.u] = desde;
    if (ahora - desde >= SOBRAS_ESPERA) borrar.push(s);
    if (ahora - desde >= SOBRAS_ABANDONO) olvidar.add(s.u);
  }
  return { borrar, vistas: nuevas, olvidar };
}
