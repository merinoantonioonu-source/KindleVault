// Pruebas del formato de la nube (sincronizar con un código): `node --test tests/`
// No necesitan nada instalado: solo Node 20 o más nuevo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../js/store.js';
import {
  aColumnas, deColumnas, abrir, sellar, claveDe, codigoNuevo, codigoValido, formatearCodigo, limpiarCodigo,
  cuboDeTitulo, cuboDeId, contenidoCubo, leerCubo, contenidoCatalogo, leerCatalogo, contenidoEstados, leerEstados,
  unirCubo, unirEstados, unirCatalogo, piezasLocales, leerIndice, componerIndice, mismoIndice, sobrasParaBorrar,
  huecoDe, SOBRAS_ESPERA, CUBOS, FORMATO_INDICE, tamanoEnLaNube,
} from '../js/nube.js';

test('el código: 16 cifras, se escribe de cuatro en cuatro', () => {
  const c = codigoNuevo();
  assert.match(c, /^\d{16}$/);
  assert.ok(codigoValido(formatearCodigo(c)));
  assert.equal(formatearCodigo('1234567890123456'), '1234 5678 9012 3456');
  assert.equal(limpiarCodigo(' 1234-5678 9012 3456 '), '1234567890123456');
  assert.ok(!codigoValido('123'));
});

test('los huecos salen del código y no se repiten', async () => {
  const a = await huecoDe('1111222233334444');
  const b = await huecoDe('1111222233334444', 'p', 'abc', 0);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.equal(a, await huecoDe('1111 2222 3333 4444'));
});

test('cifrar y descifrar: solo con el mismo código y en el mismo sitio', async () => {
  const clave = await claveDe('1111222233334444');
  const texto = await sellar(clave, { hola: 'mundo', n: [1, 2, 3] }, 'indice');
  assert.deepEqual(await abrir(clave, texto, 'indice'), { hola: 'mundo', n: [1, 2, 3] });
  await assert.rejects(abrir(clave, texto, 'pieza:c1:0123456789abcdef'));
  await assert.rejects(abrir(await claveDe('9999222233334444'), texto, 'indice'));
});

test('columnas: ida y vuelta sin perder ceros ni falsos; los vacíos no ocupan', () => {
  const filas = [{ a: 1, b: 'x', c: 0 }, { a: 2, d: false }, { b: null, e: 'y' }];
  const t = aColumnas(filas);
  assert.equal(t.n, 3);
  assert.deepEqual(Object.keys(t.c), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(deColumnas(t), [{ a: 1, b: 'x', c: 0 }, { a: 2, d: false }, { e: 'y' }]);
  // Nada de claves raras que cambien el prototipo.
  const malo = { n: 1, c: JSON.parse('{"__proto__":[{"x":1}],"ok":[1]}') };
  const [fila] = deColumnas(malo);
  assert.deepEqual(Object.keys(fila), ['ok']);
  assert.equal({}.x, undefined);
});

test('el mismo libro escrito de otra forma cae en el mismo cajón', () => {
  const a = cuboDeTitulo('Sapiens');
  assert.equal(cuboDeTitulo('Sapiens: De animales a dioses'), a);
  assert.equal(cuboDeTitulo('Sapiens (Spanish Edition)'), a);
  assert.ok(a >= 0 && a < CUBOS);
  assert.ok(cuboDeId('abc') >= 0 && cuboDeId('abc') < CUBOS);
});

const libro = { key: 'sapiens\u0001harari', title: 'Sapiens', author: 'Harari', language: 'es', cover_url: null };
const sub = (hash, content, extra = {}) => ({ hash, type: 'highlight', content, location_start: 10, location_end: 10, page: null, highlighted_at: '2024-01-02T03:04:05', bookKey: libro.key, ...extra });
const pal = (key, word, extra = {}) => ({ key, word, stem: word, language: 'es', context: `una frase con ${word}`, book_title: 'Sapiens', looked_up_at: '2026-10-01T10:00:00.000Z', mastered: false, bookKey: libro.key, ...extra });

test('un cajón: lo que se puede volver a sacar no viaja, y vuelve al leerlo', () => {
  const libros = new Map([[libro.key, libro]]);
  const c = contenidoCubo([sub('h1', 'Hola')], [pal('v1', 'casa'), pal('v2', 'corrió', { stem: 'correr' }), pal('v3', 'suelta', { bookKey: null, book_title: 'Otro libro' })], libros);
  const v = deColumnas(c.v);
  assert.ok(!('mastered' in c.v.c));
  assert.equal(v.find(x => x.key === 'v1').stem, undefined);   // igual que la palabra
  assert.equal(v.find(x => x.key === 'v1').book_title, undefined); // sale del libro
  assert.equal(v.find(x => x.key === 'v3').book_title, 'Otro libro'); // sin libro: se queda
  const leido = leerCubo(JSON.parse(JSON.stringify(c)), libros);
  assert.equal(leido.highlights[0].content, 'Hola');
  assert.equal(leido.highlights[0].location_end, 10);
  const casa = leido.vocab.find(x => x.key === 'v1');
  assert.equal(casa.stem, 'casa');
  assert.equal(casa.book_title, 'Sapiens');
  assert.equal(leido.vocab.find(x => x.key === 'v2').stem, 'correr');
  const suelta = leido.vocab.find(x => x.key === 'v3');
  assert.equal(suelta.bookKey, null);
  assert.equal(suelta.book_title, 'Otro libro');
});

test('juntar cajones: se suman; de cada uno, la corrección de libro más reciente', () => {
  const libros = new Map([[libro.key, libro]]);
  const nube = contenidoCubo([sub('h1', 'A'), sub('h2', 'B')], [pal('v1', 'casa')], libros);
  const local = contenidoCubo([sub('h2', 'B', { bookKey: 'otro', bookAt: '2026-01-01T00:00:00.000Z' }), sub('h3', 'C')], [pal('v1', 'casa')], libros);
  const u = unirCubo(nube, local);
  assert.ok(u.cambiado);
  const h = deColumnas(u.contenido.h);
  assert.deepEqual(h.map(x => x.hash), ['h1', 'h2', 'h3']);
  assert.equal(h.find(x => x.hash === 'h2').bookKey, 'otro');
  // Lo mismo otra vez no cambia nada.
  assert.ok(!unirCubo(u.contenido, local).cambiado);
  assert.ok(!unirCubo(u.contenido, nube).cambiado);
});

test('juntar marcas: de cada palabra, la más reciente', () => {
  const nube = contenidoEstados([{ key: 'es\u0001casa', status: 'known', at: '2026-01-02' }, { key: 'es\u0001perro', status: 'sent', at: '2026-01-05' }]);
  const local = contenidoEstados([{ key: 'es\u0001casa', status: null, at: '2026-01-03' }, { key: 'es\u0001perro', status: 'ignored', at: '2026-01-04' }]);
  const u = unirEstados(nube, local);
  assert.ok(u.cambiado);
  const e = leerEstados(u.contenido);
  assert.equal(e.find(x => x.key === 'es\u0001casa').status, undefined); // quitada después
  assert.equal(e.find(x => x.key === 'es\u0001perro').status, 'sent');
  assert.ok(!unirEstados(u.contenido, local).cambiado);
});

test('juntar catálogos: todas las fichas, por su clave, completándose', () => {
  const nube = contenidoCatalogo([{ ...libro, author: null }], { scannedAt: '2026-01-01', keys: [libro.key] });
  const local = contenidoCatalogo([{ ...libro, cover_url: 'https://x/y.jpg' }, { key: 'otro\u0001', title: 'Otro' }], { scannedAt: '2026-02-01', keys: ['otro\u0001'] });
  const u = unirCatalogo(nube, local);
  assert.ok(u.cambiado);
  const cat = leerCatalogo(u.contenido);
  assert.equal(cat.books.length, 2);
  const s = cat.books.find(b => b.key === libro.key);
  assert.equal(s.author, 'Harari');
  assert.equal(s.cover_url, 'https://x/y.jpg');
  assert.equal(cat.device.scannedAt, '2026-02-01');
  assert.ok(!unirCatalogo(u.contenido, local).cambiado);
});

test('las piezas de una biblioteca: la misma huella aunque los datos lleguen en otro orden', async () => {
  const datos = {
    books: [libro, { key: 'b\u0001', title: 'Otro libro', author: null }],
    highlights: [sub('h1', 'A'), sub('h2', 'B'), sub('h3', 'C', { bookKey: 'b\u0001' })],
    vocab: [pal('v1', 'casa'), pal('v2', 'perro', { bookKey: null, book_title: null })],
    wordStatus: [{ key: 'es\u0001casa', status: 'known', at: '2026-01-01' }],
  };
  const a = await piezasLocales(Library.fromJSON(datos));
  const b = await piezasLocales(Library.fromJSON({
    ...datos, books: [...datos.books].reverse(), highlights: [...datos.highlights].reverse(), vocab: [...datos.vocab].reverse(),
  }));
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
  for (const [n, p] of a) assert.equal(p.huella, b.get(n).huella, n);
  assert.ok(a.has('catalogo') && a.has('estados'));
  const items = [...a.entries()].filter(([n]) => /^c\d+$/.test(n)).reduce((t, [, p]) => t + p.cuenta, 0);
  assert.equal(items, 5);
  // De vuelta: lo mismo que había.
  const otra = Library.fromJSON({ books: leerCatalogo(a.get('catalogo').contenido).books });
  for (const [n, p] of a) {
    if (!/^c\d+$/.test(n)) continue;
    const { highlights, vocab } = leerCubo(p.contenido, new Map(datos.books.map(x => [x.key, x])));
    otra.merge({ highlights, vocab });
  }
  assert.equal(otra.highlights.size, 3);
  assert.equal(otra.vocab.size, 2);
});

test('el índice: piezas, sobras y qué se puede borrar', () => {
  const r = (u, b = 100) => ({ u: u.padEnd(16, '0'), n: 1, b });
  const anterior = leerIndice({ formato: FORMATO_INDICE, v: 1, updatedAt: 1, piezas: { catalogo: r('a'), c3: r('b'), raro: r('c') }, sobras: [] });
  assert.deepEqual(Object.keys(anterior.piezas).sort(), ['c3', 'catalogo']); // lo que no entiende, fuera
  assert.equal(tamanoEnLaNube(anterior), 200);
  const nuevo = componerIndice({ anterior, piezas: { catalogo: r('a'), c3: r('d') }, sueltas: [r('e')], ahora: 1000 });
  assert.deepEqual(nuevo.sobras.map(s => s.u[0]).sort(), ['b', 'e']);
  assert.ok(!mismoIndice(anterior, nuevo));
  assert.ok(mismoIndice(nuevo, { ...nuevo, updatedAt: 5 }));
  // Una sobra se borra cuando este equipo lleva un rato viéndola.
  let { borrar, vistas } = sobrasParaBorrar(nuevo, {}, 2000);
  assert.equal(borrar.length, 0);
  ({ borrar } = sobrasParaBorrar(nuevo, vistas, 2000 + SOBRAS_ESPERA));
  assert.equal(borrar.length, 2);
  assert.equal(leerIndice({ formato: FORMATO_INDICE, v: 99 }), 'nuevo');
  assert.equal(leerIndice({ formato: 'otra-cosa' }), null);
});
