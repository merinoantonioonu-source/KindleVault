# KindleVault

Subrayados, notas, marcadores y vocabulario de tu Kindle, en una web que se usa desde el navegador. No hay que instalar nada.

**Abrir la app:** https://merinoantonioonu-source.github.io/KindleVault/

En el ordenador funciona mejor en **Chrome o Edge**, que permiten leer el Kindle directamente. En el **móvil** (y en cualquier navegador) tienes la misma biblioteca sincronizando **con un código**: ver [Usarlo en el móvil](#usarlo-en-el-móvil).

## La app de un vistazo

- **Inicio**: cifras de tu biblioteca, **un subrayado para hoy** (con «Otro» para cambiarlo), los libros leídos hace poco, tus palabras recientes y el estado de tus datos (Kindle, sincronización).
- **Biblioteca**: tus libros con su portada (si Open Library no la tiene, se dibuja una con el título y el autor). Se filtran (en el Kindle, sin descargar, con subrayados, con palabras), se ordenan y se buscan por título o autor.
- **La página de cada libro**: sus subrayados y sus palabras en dos pestañas, con un buscador dentro del libro y los botones **Abrir en UltraMind**, **Enviar palabras a VocaMaster**, **Copiar subrayados** y **Exportar…** solo para ese libro.
- **Subrayados** y **Vocabulario**: listas con filtros desplegables (libro, idioma, tipo o estado, «Se te resisten»), los filtros activos como píldoras que se quitan con un clic, y orden (por libro, más recientes, más antiguos, más subrayados…). Al pulsar el libro de un subrayado o de una palabra se abre su página.
- **Historial**: tus lecturas en el tiempo.
- **Buscador** (botón **Buscar** o **Ctrl+K**): libros, subrayados y palabras a la vez; con las flechas y **Intro** se abre el resultado. La tecla **/** salta al buscador de la lista.
- **Tema** claro, oscuro o automático (el botón del sol/luna, abajo en la barra lateral); se recuerda.
- En el **móvil**, las secciones van en una barra abajo y el resto (Importar, sincronización, tema) en el menú **☰**. Los botones tienen el tamaño del dedo y para elegir varias palabras de golpe se **mantiene pulsada** una casilla.

Tras cada importación sale un aviso breve con lo que ha llegado (+subrayados, +palabras, libros); el detalle completo queda plegado en **Ver detalles**.

## Cómo se usa

Pulsa **Importar** (en la barra lateral, o en **Inicio** si aún no hay nada). Hay tres vías, que se pueden combinar (lo repetido se junta solo):

1. **El Kindle por USB.** Conéctalo, pulsa **Elegir el Kindle** (la primera tarjeta de la ventana Importar) y selecciona su unidad (por ejemplo `D:`). La app lee `documents/My Clippings.txt` (lo que subrayas *en ese Kindle*), `system/vocabulary/vocab.db` (las palabras que buscas) y la **lista de libros** que hay en el Kindle. Solo lee: nunca escribe en él.
2. **La app Kindle del ordenador o del móvil.** No deja que otras aplicaciones lean sus datos, pero puede **exportar el cuaderno** de cada libro (Cuaderno → Exportar cuaderno, estilo de cita «Ninguno»). Ese `.html` se abre con **Elegir archivos** (abajo en la ventana Importar), varios a la vez.
3. **La nube de Amazon** (todos tus libros con subrayados, también los no descargados): arrastra el botón **📚 KindleVault: nube de Amazon** de la ventana Importar a la barra de marcadores, abre tu cuaderno (`read.amazon.com/notebook` o `leer.amazon.es/notebook`) y púlsalo. Al terminar, pulsa **Llevar a KindleVault**: se abre KindleVault y lo importa solo. Si el navegador no lo deja, **Descargar el archivo** guarda un `kindlevault-amazon-….json` (en Descargas) que se abre con **Elegir archivos** o se arrastra a la página. Solo lee tus páginas de Amazon con tu sesión y solo se lo pasa a KindleVault. Si ya tenías el marcador de antes, vuelve a arrastrarlo: el antiguo no tiene ese botón.

Los archivos, o una carpeta copiada del Kindle, también se pueden arrastrar a cualquier parte de la página.

**Kindle Mate.** Si lo usabas, guarda lo que el Kindle ya ha borrado (las actualizaciones del Kindle pueden vaciar el vocabulario y `My Clippings.txt`). Su exportación de vocabulario (`.db`) y de subrayados (`.txt`) se abre con **Elegir archivos**: cada búsqueda va a su libro con su frase, la hora se ajusta con la del Kindle y lo repetido no se duplica. Las palabras que Kindle Mate guarda sin frase ni libro se ofrecen aparte. Tras cada importación, **Copiar informe detallado** da un resumen de lo encontrado (útil si algo no cuadra).

**¿El Kindle no sale como unidad (`D:`, `E:`…)?** Los Kindle recientes (por ejemplo, el Paperwhite de 2021 en adelante) se conectan como *dispositivo*: el Explorador los muestra como **Kindle → Internal Storage**, sin letra, y el navegador no puede abrirlos. Copia al ordenador la carpeta `system/vocabulary` **entera** y `documents/My Clippings.txt`, y arrástralos a la página. La carpeta entera importa: el Kindle guarda primero las palabras que buscas en `vocab.db-wal` y tarda en pasarlas a `vocab.db`, así que con `vocab.db` solo faltarían las más recientes (KindleVault avisa si eliges `vocab.db` sin su `-wal`). Tras cada importación dice cuál es la **última palabra buscada** que ha leído, para que se vea si los datos están al día.

**Volver a escanear.** Si has descargado un libro, subrayado o buscado palabras desde la última vez, pulsa **Volver a escanear el Kindle** (en la barra lateral o en **Inicio**): vuelve a leer el Kindle tal como está ahora (el de la última vez, sin volver a elegirlo si el navegador lo permite) y dice qué libros han llegado o se han ido. Lo que ya estaba no se duplica, y si algo estaba en el libro equivocado se corrige.

**¿Por qué faltan libros o subrayados?** `My Clippings.txt` solo guarda lo que subrayas en ese mismo Kindle; lo subrayado en el móvil, en el ordenador o en otro Kindle está en la nube de Amazon (vía 3). Cuando descargas en el Kindle un libro que subrayaste en otro aparato, el Kindle recibe esos subrayados y los guarda en la carpeta de datos del libro (`.sdr`), **sin su texto** y sin escribirlos en `My Clippings.txt`: KindleVault los cuenta y avisa («El Kindle tiene 37: faltan 32»), y su texto se trae con la vía 3. Las palabras buscadas solo están en el Kindle, que las conserva aunque borres el libro. En **Biblioteca** se ve qué libros están **en el Kindle** y cuáles tienen subrayados pero **no están descargados**.

## Llevar los subrayados a UltraMind (mapa mental)

En **Subrayados**, pulsa **Exportar** (arriba a la derecha) y elige el formato **UltraMind — mapa mental**. Sale **un mapa por libro**: el título es el tema central y cada subrayado, una rama. No lleva ubicación, fecha ni autor; solo las notas que escribiste tú en el Kindle, guardadas en la nota de su subrayado. Con varios libros se descarga un archivo por libro.

En la página de cada libro está el botón **Abrir en UltraMind** (también en la lista de Exportar → UltraMind): abre UltraMind y crea allí el mapa, sin descargar nada (el mapa va en la dirección, detrás de `#mapa=`, y no sale del navegador; los mapas siguientes llegan a la misma pestaña). Hace falta la versión de UltraMind que los recibe. La dirección de UltraMind se cambia en **Dirección de UltraMind**, debajo de la lista.

También se puede descargar: en UltraMind, **Abrir o importar** y arrastra el archivo, o pega allí el texto (botón **Copiar**, con un solo libro filtrado) y pulsa **Importar el texto**.

## Estudiar el vocabulario en VocaMaster

En **Vocabulario** (o en la página de un libro, solo con sus palabras), pulsa **Enviar a VocaMaster** y luego **📤 Abrir VocaMaster y enviar**. Se abre VocaMaster (inicia sesión si te lo pide: las palabras esperan) con una vista previa, **📚 Desde KindleVault**, donde:

- cada palabra dice qué se hará con ella: **Nueva** (su IA crea la ficha con la traducción y la definición del sentido que tiene en la frase del libro, y guarda esa frase como ejemplo), **Ya la tienes · frase nueva** (la frase va a «Más ejemplos» de la que ya tienes) o **Repetida**;
- puedes corregir la palabra, quitarla del envío y ponerle o quitarle etiquetas (por defecto, el libro y «kindle»), una a una o **varias a la vez**: elige las que quieras (o todas las de un libro) y añade o quita etiquetas, con tus etiquetas de VocaMaster como botones;
- al pulsar **Añadir a VocaMaster**, aquí quedan marcadas como **Enviada**.

Van en su forma base («run» en vez de «ran», si quieres) y, si marcas **Todas sus frases**, con cada frase en la que buscaste la palabra. Las de otro idioma esperan en VocaMaster hasta que cambies a ese idioma. Si VocaMaster no se abre, **Copiar y pegar a mano** da los bloques de siempre (`palabra | frase`, hasta 50 por bloque) para **+** → **Vocabulario** → **✍️ Pegar Texto**.

Al copiar un bloque, sus palabras también quedan marcadas como **Enviada**, para no mandarlas otra vez. Cada palabra se puede marcar también como **Me la sé** o **Ignorar** (las que el Kindle ya da por aprendidas entran como «Me la sé»), y el filtro **Estado** decide cuáles se ven. En cada palabra, al pasar el ratón, salen los botones para marcarla (o quitarle la marca). Estas marcas viajan con la sincronización.

En «Copiar y pegar a mano», **Un bloque por libro** saca cada libro en sus propios bloques (con su título).

**Las que se te resisten.** En **Vocabulario**, el filtro **Se te resisten** deja las palabras que has buscado dos veces o más (en el mismo libro o en varios), de más a menos búsquedas y con todas sus frases juntas; cada palabra repetida lo indica («Buscada 7 veces en 6 libros»). Son buenas candidatas para VocaMaster. El filtro **Idioma** cuenta, en esta pestaña, el idioma de cada palabra.

Para mandar solo **palabras concretas**, marca su casilla en la lista (Mayús+clic elige un tramo) y pulsa **Enviar a VocaMaster** en la barra que aparece encima (con **Me las sé** o **Ignorar** se marcan todas de una vez).

## Historial de lectura

La pestaña **Historial** saca de las fechas de tus búsquedas y subrayados: cuántos hay por año, los idiomas de tus palabras, los libros con más palabras buscadas, las palabras que más se te resisten y una **línea de tiempo** con cuándo leíste cada libro. Todo se puede pulsar: un libro abre su página; una palabra, todas sus frases.

## Escuchar y traducir

En cada palabra, frase y subrayado de otro idioma hay **🔊** (lo lee la voz del navegador: en Edge, las mismas voces naturales de «Leer en voz alta») y **Traducir**. En Chrome de escritorio la traducción la hace el propio navegador, en el ordenador y sin enviar el texto a ningún sitio (la primera vez descarga el idioma). En otros navegadores ofrece abrir el Traductor de Google.

## Notas y subrayados ampliados

- Cada nota que escribes en el Kindle aparece **dentro de su subrayado** (el Kindle las guarda por separado).
- Si amplías un subrayado, el Kindle guarda también la versión corta. KindleVault la oculta para no verla repetida; se puede ver con el filtro **Tipo → Versiones anteriores**.

## Usarlo en el móvil

1. En el **ordenador**, pulsa la píldora de sincronización (abajo en la barra lateral) → **Con un código** → **Crear código**. Sale un código de 16 cifras (**Ver el código** lo vuelve a enseñar cuando quieras).
2. En el **móvil**, abre https://merinoantonioonu-source.github.io/KindleVault/ y pulsa **Ya lo uso en el ordenador** (o, si ya tienes datos, **☰** → píldora de sincronización → **Tengo un código**). Escribe el código una vez y pulsa **Vincular**: tu biblioteca llega en unos segundos.
3. Para tenerlo como una app más: en Chrome, **⋮ → Añadir a pantalla de inicio** (o **Instalar aplicación**); en el iPhone, **Compartir → Añadir a pantalla de inicio**.

Desde entonces los dos se sincronizan solos: cada uno sube sus cambios a los pocos segundos (marcar palabras, enviarlas a VocaMaster, importar…) y trae los del otro al abrir KindleVault, al volver a la página y cada pocos minutos; cuando llega algo, sale un aviso. Sin conexión no pasa nada: lo pendiente sale al volver la red. En el móvil puedes leer y buscar tus subrayados, marcar palabras (**✓** Me la sé, **⊘** Ignorar), enviarlas a VocaMaster, abrir un libro en UltraMind, copiar, escuchar y traducir. El Kindle se sigue conectando al ordenador; lo que importes allí llega solo al móvil.

## Sincronización

En la píldora de sincronización (abajo en la barra lateral; en el móvil, en el menú ☰) hay dos formas, que se pueden usar a la vez (lo que llega por una sale por la otra):

**Con un código** (móvil y ordenadores, cualquier navegador). En un equipo, **Crear código**; en los demás, **Tengo un código** y escribirlo una vez. Los datos se **cifran con el código** antes de salir del equipo (AES-256; la clave sale del código con PBKDF2) y esperan en una base de datos de Firebase (la misma Realtime Database que usan UltraMind y RepArena, en huecos propios de KindleVault), que solo ve algo ilegible y no deja listar nada: sin el código nadie puede encontrarlos ni leerlos. Guárdalo como una contraseña. **Desvincular** deja los datos en ese equipo y en la nube; para volver, se escribe el mismo código.

Para **ocupar poco** en esa base de datos (y bajar poco por la red):

- todo va **comprimido** y por columnas (sin repetir los nombres de los campos ni lo que se puede volver a sacar, como el título del libro en cada palabra): una biblioteca de 85 libros, 1.584 subrayados y 2.624 palabras pasa de 1,95 MB a unos **590 KB**;
- se guarda **en piezas**: el catálogo de libros, las marcas de las palabras y los subrayados y palabras repartidos en 64 cajones según el libro. Al cambiar algo solo se sube la pieza afectada (marcar 5 palabras: ~2 KB; nuevas palabras en un libro: la pieza de ese libro) y el otro equipo solo baja lo que ha cambiado;
- para saber si hay novedades basta con leer una ficha de unos pocos bytes;
- las piezas viejas se **borran solas** a los 10 minutos (también las que quedasen a medias si se cierra la página mientras sube algo).

La ventana dice cuánto ocupa tu biblioteca en la nube.

**Con un archivo** (entre ordenadores, Chrome o Edge). **Crear archivo** en el primer ordenador y guardarlo en una carpeta que se sincronice sola (OneDrive, Dropbox…); en los demás, **Vincular un archivo** y elegir ese mismo archivo. Se sincroniza solo al abrir la web, al volver a ella y tras cada cambio. Por seguridad, Chrome pide **un clic** para usar el archivo en cada sesión nueva del navegador; la app te lo pregunta con un aviso.

Las dos **combinan** los datos: nunca borran nada (los subrayados y palabras de todos los equipos se suman; de las marcas de una palabra vale la más reciente) y nunca sobrescriben algo que no han podido leer.

## Dónde están tus datos

- En el almacenamiento de tu navegador (IndexedDB), en cada equipo.
- En tu archivo de sincronización, si lo usas.
- Cifrados con tu código en la base de datos de Firebase, si sincronizas con un código.

Este repositorio solo contiene el código: tus subrayados no se suben a GitHub. Las únicas peticiones externas son las de las portadas (a Open Library), las fuentes tipográficas (Google Fonts) y, si sincronizas con un código, la base de datos de Firebase (con tus datos ya cifrados); y, solo si tú lo pulsas, abrir el Traductor de Google con el texto a traducir (en los navegadores sin traductor propio).

## Qué se importa

| Tipo | Se muestra por defecto |
|---|---|
| Subrayados y notas | Sí |
| Marcadores de página | Sí |
| Sin texto (imágenes, tablas…) | No (filtro Tipo → "Sin texto") |
| Bloqueados por el límite de recortes de Amazon | No (filtro Tipo → "Bloqueados") |

Los textos bloqueados por Amazon no se pueden recuperar: el Kindle no los escribe en `My Clippings.txt`.

## Estructura del código

```
index.html          Página
css/styles.css      Estilos (tema papel, claro/oscuro/automático, móvil)
js/app.js           Interfaz (Inicio, Biblioteca, página del libro, listas, buscador)
js/icons.js         Iconos (SVG en línea)
js/bookcover.js     Portadas dibujadas con el título y el autor
js/parser.js        Lectura de My Clippings.txt y vocab.db
js/sqlite-reader.js Lector de SQLite propio (sin dependencias)
js/store.js         Biblioteca local en IndexedDB y combinación de datos
js/sync.js          Archivo de sincronización
js/nube.js          Sincronizar con un código: cifrado, piezas, cajones y cómo se juntan
js/nubesync.js      Sincronizar con un código: hablar con Firebase y cuándo cruzar
js/kindle.js        Acceso a la unidad del Kindle
js/covers.js        Portadas de Open Library
js/export.js        Exportación (UltraMind, Markdown, TXT, CSV, JSON) y bloques para VocaMaster
js/notebook.js      Cuadernos exportados de la app Kindle y archivo de la nube de Amazon
js/amazon.js        Marcador que lee el cuaderno de Kindle en Amazon
js/bookmeta.js      Título y ASIN de los libros del Kindle (nombre de archivo y cabecera MOBI)
js/sidecar.js       Recuento de anotaciones de las carpetas .sdr del Kindle
js/speech.js        Pronunciación con las voces del navegador
js/translate.js     Traducción con el traductor del navegador
manifest.webmanifest, icons/   Para instalarla en la pantalla de inicio del móvil
tests/              Pruebas de la sincronización con un código
```

No necesita compilación: GitHub Pages sirve los archivos tal cual. Para probarla en local, abre un servidor en la carpeta (por ejemplo `python3 -m http.server`) y entra en `http://localhost:8000`. Las pruebas solo necesitan Node 20 o más nuevo: `node --test tests/*.test.mjs`.
