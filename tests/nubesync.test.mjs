// Sincronizar con un código entre varios equipos, con una base de datos falsa
// que pone las mismas reglas que la de verdad (huecos de 64 cifras, con su
// ficha y su `blob` de menos de 3 MB). Cada equipo tiene su propio IndexedDB.
// `node --test tests/`
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';

// --- Un IndexedDB mínimo, uno por equipo ---------------------------------------------
const equipo = new AsyncLocalStorage();
const almacenes = new Map();
const almacen = () => {
  const e = equipo.getStore() || '-';
  if (!almacenes.has(e)) almacenes.set(e, new Map());
  return almacenes.get(e);
};
globalThis.indexedDB = {
  open() {
    const req = {};
    setTimeout(() => {
      req.result = {
        createObjectStore() {},
        transaction() {
          const tx = {};
          tx.objectStore = () => ({
            get(key) {
              const r = {};
              setTimeout(() => { const m = almacen(); r.result = m.has(key) ? structuredClone(m.get(key)) : undefined; r.onsuccess && r.onsuccess(); });
              return r;
            },
            put(value, key) { almacen().set(key, structuredClone(value)); },
            delete(key) { almacen().delete(key); },
          });
          setTimeout(() => tx.oncomplete && tx.oncomplete());
          return tx;
        },
      };
      if (req.onupgradeneeded) req.onupgradeneeded();
      if (req.onsuccess) req.onsuccess();
    });
    return req;
  },
};

const { Library } = await import('../js/store.js');
const { NubeSync, ErrorNube } = await import('../js/nubesync.js');
const { huecoDe, SOBRAS_ESPERA, LECTURA_MAX } = await import('../js/nube.js');

// --- La base de datos falsa ---------------------------------------------------------
function baseFalsa() {
  const huecos = new Map();
  const log = [];
  let antes = null;
  let fallarEscritura = null;
  const red = {
    async leer(hueco, parte = '') {
      if (antes) await antes('leer', hueco, parte);
      await new Promise(r => setTimeout(r, 1));
      log.push(['leer', hueco + parte]);
      const v = huecos.get(hueco);
      if (!v) return null;
      return structuredClone(parte === '/meta' ? v.meta : v);
    },
    async escribir(hueco, valor) {
      if (antes) await antes('escribir', hueco, valor);
      await new Promise(r => setTimeout(r, 1));
      if (fallarEscritura && fallarEscritura(hueco, valor)) throw new ErrorNube('Sin conexión (simulado)');
      assert.match(hueco, /^[0-9a-f]{64}$/);
      assert.deepEqual(Object.keys(valor).sort(), ['blob', 'meta']);
      assert.equal(typeof valor.blob, 'string');
      assert.ok(valor.blob.length < 3_000_000);
      assert.equal(typeof valor.meta.ver, 'number');
      assert.equal(typeof valor.meta.at, 'number');
      assert.match(valor.meta.dev, /^[0-9a-f]{12}$/);
      assert.equal(typeof valor.meta.from, 'string');
      assert.equal(typeof valor.meta.n, 'number');
      log.push(['escribir', hueco, valor.blob.length]);
      huecos.set(hueco, structuredClone(valor));
    },
    async borrar(hueco) {
      await new Promise(r => setTimeout(r, 1));
      log.push(['borrar', hueco]);
      huecos.delete(hueco);
    },
  };
  return {
    red, huecos, log,
    antes: fn => { antes = fn; },
    fallarEscritura: fn => { fallarEscritura = fn; },
    bytes: () => [...huecos.values()].reduce((t, v) => t + v.blob.length, 0),
    escrituras: () => log.filter(x => x[0] === 'escribir'),
    lecturas: () => log.filter(x => x[0] === 'leer'),
    limpiarLog: () => { log.length = 0; },
  };
}

// --- Datos de prueba ------------------------------------------------------------------
const PALABRAS = 'casa perro gato libro mesa silla agua fuego tierra aire mar sol luna estrella camino ciudad pueblo río montaña árbol flor hoja rama raíz piedra arena nube lluvia viento nieve'.split(' ');
let semilla = 7;
const azar = () => { semilla = (semilla * 16807) % 2147483647; return semilla / 2147483647; };
const frase = n => Array.from({ length: n }, () => PALABRAS[Math.floor(azar() * PALABRAS.length)]).join(' ');

function datosDe(nLibros, { prefijo = 'Libro', hl = 6, voc = 8 } = {}) {
  const books = [], highlights = [], vocab = [];
  for (let i = 0; i < nLibros; i++) {
    const title = `${prefijo} ${i}: ${frase(2)}`;
    const key = `${title.toLowerCase()}\u0001autor ${i}`;
    books.push({ key, title, author: `Autor ${i}`, language: 'es', asin: null, cover_url: null });
    for (let j = 0; j < hl; j++) {
      highlights.push({ hash: `h-${prefijo}-${i}-${j}`, type: 'highlight', content: frase(20), location_start: j * 10, location_end: j * 10 + 2, page: null, highlighted_at: `2025-0${1 + (j % 9)}-1${j % 10}T10:00:00`, bookKey: key });
    }
    for (let j = 0; j < voc; j++) {
      const word = PALABRAS[(i + j) % PALABRAS.length];
      vocab.push({ key: `v-${prefijo}-${i}-${j}`, word, stem: word, language: 'es', context: frase(14) + ` ${word}.`, book_title: title, looked_up_at: `2026-0${1 + (j % 9)}-0${1 + (j % 9)}T10:00:00.000Z`, mastered: false, bookKey: key });
    }
  }
  return { format: 'kindlevault-sync', books, highlights, vocab, wordStatus: [], device: null };
}

function crearEquipo(nombre, nube, datos = null) {
  const lib = Library.fromJSON(datos);
  let traidos = 0;
  const sync = new NubeSync(lib, { red: nube.red, onMerged: () => { traidos++; } });
  const en = fn => equipo.run(nombre, fn);
  return { nombre, lib, sync, en, traidos: () => traidos };
}

const resumen = lib => ({ libros: lib.listBooks().length, subrayados: lib.highlights.size, palabras: lib.vocab.size });

let nube;
beforeEach(() => { nube = baseFalsa(); almacenes.clear(); });

// --- Las pruebas ------------------------------------------------------------------------

test('el ordenador crea el código y el móvil lo trae todo; si nada cambia, no se escribe nada', async () => {
  const pc = crearEquipo('pc', nube, datosDe(40));
  const movil = crearEquipo('movil', nube);
  const r1 = await pc.en(() => pc.sync.crear());
  assert.ok(r1.ok, r1.mensaje);
  assert.ok(r1.subio > 2);
  const codigo = pc.sync.codigo;

  const r2 = await movil.en(() => movil.sync.vincular(codigo));
  assert.ok(r2.ok, r2.mensaje);
  assert.equal(r2.subio, 0, 'el móvil no tiene nada nuevo que subir');
  assert.deepEqual(resumen(movil.lib), resumen(pc.lib));
  assert.equal(movil.traidos(), 1);

  // Otro cruce en cada uno: ni subidas ni índice nuevo.
  nube.limpiarLog();
  assert.ok((await pc.en(() => pc.sync.syncNow())).ok);
  assert.ok((await movil.en(() => movil.sync.syncNow())).ok);
  assert.equal(nube.escrituras().length, 0);
  // Y solo se ha leído el índice (nada de piezas).
  assert.equal(nube.lecturas().length, 2);
});

test('un código mal escrito no se queda vinculado', async () => {
  const movil = crearEquipo('movil', nube);
  const r = await movil.en(() => movil.sync.vincular('1234 5678 9012 3456'));
  assert.ok(!r.ok);
  assert.ok(r.vacio);
  assert.equal(movil.sync.codigo, null);
  assert.equal(nube.escrituras().length, 0);
});

test('marcar palabras en el móvil sube solo las marcas; el ordenador las recibe', async () => {
  const pc = crearEquipo('pc', nube, datosDe(30));
  const movil = crearEquipo('movil', nube);
  await pc.en(() => pc.sync.crear());
  await movil.en(() => movil.sync.vincular(pc.sync.codigo));

  const v = [...movil.lib.vocab.values()][3];
  const { wordKey } = await import('../js/store.js');
  movil.lib.setWordStatus(wordKey(v), 'known');
  nube.limpiarLog();
  const r = await movil.en(() => movil.sync.syncNow());
  assert.ok(r.ok);
  assert.equal(r.subio, 1, 'solo la pieza de las marcas');
  assert.equal(nube.escrituras().length, 2, 'la pieza y el índice');

  nube.limpiarLog();
  const r2 = await pc.en(() => pc.sync.syncNow());
  assert.ok(r2.ok && r2.trajo);
  assert.equal(pc.lib.getWordStatus(v), 'known');
  // El ordenador ha bajado el índice y una pieza (las marcas), nada más.
  const piezasLeidas = nube.lecturas().filter(([, h]) => !h.endsWith('/meta')).length - 2; // índice + comprobación
  assert.ok(piezasLeidas <= 1, `piezas leídas: ${piezasLeidas}`);
});

test('una importación en el ordenador sube solo los cajones de esos libros', async () => {
  const pc = crearEquipo('pc', nube, datosDe(60));
  const movil = crearEquipo('movil', nube);
  await pc.en(() => pc.sync.crear());
  await movil.en(() => movil.sync.vincular(pc.sync.codigo));
  const total = nube.bytes();

  // Nuevos subrayados en un libro.
  const libro = [...pc.lib.books.values()][5];
  pc.lib.importHighlights([0, 1, 2].map(i => ({ hash: `nuevo-${i}`, type: 'highlight', content: frase(18), location_start: 900 + i, location_end: 901 + i, page: null, highlighted_at: '2026-11-01T10:00:00', bookTitle: libro.title, author: libro.author })));
  nube.limpiarLog();
  const r = await pc.en(() => pc.sync.syncNow());
  assert.ok(r.ok);
  assert.equal(r.subio, 1, 'un cajón');
  const subido = nube.escrituras().reduce((t, x) => t + x[2], 0);
  assert.ok(subido < total / 10, `subido ${subido} de ${total}`);

  const r2 = await movil.en(() => movil.sync.syncNow());
  assert.ok(r2.ok && r2.trajo);
  assert.equal(movil.lib.highlights.size, pc.lib.highlights.size);
});

test('las piezas viejas se borran pasado un rato, y la nube no crece', async () => {
  const pc = crearEquipo('pc', nube, datosDe(20));
  await pc.en(() => pc.sync.crear());
  const piezas = nube.huecos.size;
  const libro = [...pc.lib.books.values()][2];
  const ahora = Date.now;
  try {
    for (let vuelta = 0; vuelta < 3; vuelta++) {
      pc.lib.importHighlights([{ hash: `x-${vuelta}`, type: 'highlight', content: frase(10), location_start: vuelta, location_end: vuelta, page: null, highlighted_at: '2026-11-01T10:00:00', bookTitle: libro.title, author: libro.author }]);
      assert.ok((await pc.en(() => pc.sync.syncNow())).ok);
    }
    assert.ok(nube.huecos.size > piezas, 'de momento, las sobras siguen ahí');
    const base = Date.now();
    Date.now = () => base + SOBRAS_ESPERA + 1000;
    assert.ok((await pc.en(() => pc.sync.syncNow())).ok);
    assert.equal(nube.huecos.size, piezas, 'solo quedan las piezas en uso');
  } finally { Date.now = ahora; }
});

test('dos equipos cambiando a la vez: al final los dos lo tienen todo', async () => {
  const pc = crearEquipo('pc', nube, datosDe(25, { prefijo: 'Comun' }));
  const movil = crearEquipo('movil', nube);
  await pc.en(() => pc.sync.crear());
  await movil.en(() => movil.sync.vincular(pc.sync.codigo));

  const { wordKey } = await import('../js/store.js');
  const libro = [...pc.lib.books.values()][1];
  pc.lib.importHighlights([{ hash: 'a-la-vez', type: 'highlight', content: 'Escrito en el ordenador', location_start: 1, location_end: 1, page: null, highlighted_at: '2026-11-02T10:00:00', bookTitle: libro.title, author: libro.author }]);
  const v = [...movil.lib.vocab.values()][0];
  movil.lib.setWordStatus(wordKey(v), 'ignored');

  // Que los dos lean el índice antes de que el otro escriba.
  let leidos = 0, soltar;
  const juntos = new Promise(r => { soltar = r; });
  nube.antes(async (op, hueco, parte) => {
    if (op === 'leer' && !parte && leidos < 2) { leidos++; if (leidos === 2) soltar(); await juntos; }
  });
  const [a, b] = await Promise.all([pc.en(() => pc.sync.syncNow()), movil.en(() => movil.sync.syncNow())]);
  nube.antes(null);
  assert.ok(a.ok && b.ok, `${a.mensaje} / ${b.mensaje}`);
  await pc.en(() => pc.sync.syncNow());
  await movil.en(() => movil.sync.syncNow());
  assert.ok(movil.lib.highlights.has('a-la-vez'));
  assert.equal(pc.lib.getWordStatus(v), 'ignored');
  assert.deepEqual(resumen(pc.lib), resumen(movil.lib));
});

test('si se borran los datos de un equipo, vuelven de la nube y la nube no pierde nada', async () => {
  const pc = crearEquipo('pc', nube, datosDe(15));
  const movil = crearEquipo('movil', nube);
  await pc.en(() => pc.sync.crear());
  await movil.en(() => movil.sync.vincular(pc.sync.codigo));
  const antes = resumen(movil.lib);

  movil.lib.clear();
  await movil.en(() => movil.sync.olvidar());
  const r = await movil.en(() => movil.sync.syncNow());
  assert.ok(r.ok);
  assert.equal(r.subio, 0);
  assert.deepEqual(resumen(movil.lib), antes);

  // Aunque no se avise (datos perdidos por otra causa), tampoco se sube menos.
  movil.lib.clear();
  const r2 = await movil.en(() => movil.sync.syncNow());
  assert.ok(r2.ok);
  assert.deepEqual(resumen(movil.lib), antes);
  const otro = crearEquipo('otro', nube);
  await otro.en(() => otro.sync.vincular(pc.sync.codigo));
  assert.deepEqual(resumen(otro.lib), antes);
});

test('el mismo libro con otro título en cada equipo: todo junto y en su libro', async () => {
  const pc = crearEquipo('pc', nube, {
    books: [{ key: 'sapiens\u0001harari', title: 'Sapiens', author: 'Harari' }],
    highlights: [{ hash: 'del-pc', type: 'highlight', content: 'Uno', location_start: 1, location_end: 1, bookKey: 'sapiens\u0001harari' }],
  });
  const otro = crearEquipo('otro', nube, {
    books: [{ key: 'sapiens: de animales a dioses\u0001yuval noah harari', title: 'Sapiens: De animales a dioses', author: 'Yuval Noah Harari' }],
    highlights: [{ hash: 'del-otro', type: 'highlight', content: 'Dos', location_start: 2, location_end: 2, bookKey: 'sapiens: de animales a dioses\u0001yuval noah harari' }],
  });
  await pc.en(() => pc.sync.crear());
  assert.ok((await otro.en(() => otro.sync.vincular(pc.sync.codigo))).ok);
  await pc.en(() => pc.sync.syncNow());
  for (const e of [pc, otro]) {
    assert.equal(e.lib.highlights.size, 2, e.nombre);
    assert.equal(e.lib.listBooks().length, 1, e.nombre);
    const [b] = e.lib.listBooks();
    assert.equal(b.highlights_count, 2, e.nombre);
  }
  const movil = crearEquipo('movil', nube);
  assert.ok((await movil.en(() => movil.sync.vincular(pc.sync.codigo))).ok);
  assert.equal(movil.lib.listBooks().length, 1);
  assert.equal(movil.lib.listBooks()[0].highlights_count, 2);
  // Ya está todo junto: otra vuelta no escribe nada.
  nube.limpiarLog();
  for (const e of [pc, otro, movil]) await e.en(() => e.sync.syncNow());
  assert.equal(nube.escrituras().length, 0);
});

test('si la página se cierra a medio subir, lo suelto se borra después', async () => {
  const pc = crearEquipo('pc', nube, datosDe(20));
  await pc.en(() => pc.sync.crear());
  const enUso = nube.huecos.size;
  for (const b of [...pc.lib.books.values()].slice(0, 6)) {
    pc.lib.importHighlights([{ hash: `p-${b.key}`, type: 'highlight', content: frase(8), location_start: 5, location_end: 5, highlighted_at: '2026-11-03T10:00:00', bookTitle: b.title, author: b.author }]);
  }
  let n = 0;
  nube.fallarEscritura(() => ++n === 3);
  const r = await pc.en(() => pc.sync.syncNow());
  nube.fallarEscritura(null);
  assert.ok(!r.ok);
  const ahora = Date.now;
  try {
    assert.ok((await pc.en(() => pc.sync.syncNow())).ok);
    const base = Date.now();
    Date.now = () => base + SOBRAS_ESPERA + 1000;
    assert.ok((await pc.en(() => pc.sync.syncNow())).ok);
    // Solo quedan las piezas en uso (tantas como antes, o una más si algún libro estrenó cajón).
    assert.ok(nube.huecos.size <= enUso + 1, `${nube.huecos.size} huecos, antes ${enUso}`);
  } finally { Date.now = ahora; }
});

test('cuánto ocupa: comprimido y por columnas, mucho menos que el JSON', async () => {
  const datos = datosDe(80, { hl: 15, voc: 25 });
  const pc = crearEquipo('pc', nube, datos);
  const r = await pc.en(() => pc.sync.crear());
  const json = JSON.stringify(pc.lib.toJSON()).length;
  const enNube = nube.bytes();
  assert.ok(enNube < json * 0.6, `en la nube ${enNube}, JSON ${json}`);
  // Lo que dice que ocupa: sus piezas (todo menos el índice).
  const indice = nube.huecos.get(await huecoDe(pc.sync.codigo)).blob.length;
  assert.equal(r.tamano, enNube - indice);
});

test('si otro equipo pisa el índice justo a la vez, nada se pierde ni queda suelto', async () => {
  const pc = crearEquipo('pc', nube, datosDe(20));
  const movil = crearEquipo('movil', nube);
  await pc.en(() => pc.sync.crear());
  await movil.en(() => movil.sync.vincular(pc.sync.codigo));
  const huecoIndice = await huecoDe(pc.sync.codigo);
  const { wordKey } = await import('../js/store.js');

  const libro = [...pc.lib.books.values()][4];
  pc.lib.importHighlights([{ hash: 'pisado', type: 'highlight', content: 'Lo escribe el ordenador', location_start: 3, location_end: 3, highlighted_at: '2026-11-04T10:00:00', bookTitle: libro.title, author: libro.author }]);
  const v = [...movil.lib.vocab.values()][2];
  movil.lib.setWordStatus(wordKey(v), 'known');

  // El móvil lee el índice y, antes de escribir el suyo, el ordenador hace un cruce entero.
  let soltar;
  const espera = new Promise(r => { soltar = r; });
  nube.antes(async (op, hueco) => {
    if (op === 'escribir' && hueco === huecoIndice && equipo.getStore() === 'movil') await espera;
  });
  const delMovil = movil.en(() => movil.sync.syncNow());
  await new Promise(r => setTimeout(r, 50));
  assert.ok((await pc.en(() => pc.sync.syncNow())).ok);
  soltar();
  assert.ok((await delMovil).ok);
  nube.antes(null);

  // El índice del móvil no nombra lo que subió el ordenador; en el siguiente cruce vuelve.
  const ahora = Date.now;
  try {
    for (const e of [pc, movil, pc, movil]) assert.ok((await e.en(() => e.sync.syncNow())).ok);
    assert.ok(movil.lib.highlights.has('pisado'));
    assert.equal(pc.lib.getWordStatus(v), 'known');
    const base = Date.now();
    Date.now = () => base + SOBRAS_ESPERA + 1000;
    const r = await pc.en(() => pc.sync.syncNow());
    assert.ok(r.ok);
    assert.equal(nube.huecos.size, r.piezas + 1, 'solo el índice y las piezas en uso');
  } finally { Date.now = ahora; }
});
