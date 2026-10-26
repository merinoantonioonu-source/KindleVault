# KindleVault

Subrayados, notas, marcadores y vocabulario de tu Kindle, en una web que se usa desde el navegador. No hay que instalar nada.

**Abrir la app:** https://merinoantonioonu-source.github.io/KindleVault/

Funciona mejor en **Chrome o Edge de escritorio**, que permiten leer el Kindle directamente y sincronizar con un archivo. En otros navegadores (Firefox, Safari, móvil) se pueden importar los archivos a mano y consultar los datos, pero no hay sincronización automática.

## Cómo se usa

Pulsa **Importar**. Hay tres vías, que se pueden combinar (lo repetido se junta solo):

1. **El Kindle por USB.** Conéctalo, pulsa **Elegir el Kindle** y selecciona su unidad (por ejemplo `D:`). La app lee `documents/My Clippings.txt` (lo que subrayas *en ese Kindle*), `system/vocabulary/vocab.db` (las palabras que buscas) y la **lista de libros** que hay en el Kindle. Solo lee: nunca escribe en él.
2. **La app Kindle del ordenador o del móvil.** No deja que otras aplicaciones lean sus datos, pero puede **exportar el cuaderno** de cada libro (Cuaderno → Exportar cuaderno, estilo de cita «Ninguno»). Ese `.html` se abre con **Elegir archivos**, varios a la vez.
3. **La nube de Amazon** (todos tus libros con subrayados, también los no descargados): arrastra el botón **📚 KindleVault: nube de Amazon** de la ventana Importar a la barra de marcadores, abre tu cuaderno (`read.amazon.com/notebook` o `leer.amazon.es/notebook`) y púlsalo. Al terminar, pulsa **Llevar a KindleVault**: se abre KindleVault y lo importa solo. Si el navegador no lo deja, **Descargar el archivo** guarda un `kindlevault-amazon-….json` (en Descargas) que se abre con **Elegir archivos** o se arrastra a la página. Solo lee tus páginas de Amazon con tu sesión y solo se lo pasa a KindleVault. Si ya tenías el marcador de antes, vuelve a arrastrarlo: el antiguo no tiene ese botón.

Los archivos, o una carpeta copiada del Kindle, también se pueden arrastrar a cualquier parte de la página.

**Kindle Mate.** Si lo usabas, guarda lo que el Kindle ya ha borrado (las actualizaciones del Kindle pueden vaciar el vocabulario y `My Clippings.txt`). Su exportación de vocabulario (`.db`) y de subrayados (`.txt`) se abre con **Elegir archivos**: cada búsqueda va a su libro con su frase, la hora se ajusta con la del Kindle y lo repetido no se duplica. Las palabras que Kindle Mate guarda sin frase ni libro se ofrecen aparte. Tras cada importación, **Copiar informe detallado** da un resumen de lo encontrado (útil si algo no cuadra).

**¿El Kindle no sale como unidad (`D:`, `E:`…)?** Los Kindle recientes (por ejemplo, el Paperwhite de 2021 en adelante) se conectan como *dispositivo*: el Explorador los muestra como **Kindle → Internal Storage**, sin letra, y el navegador no puede abrirlos. Copia al ordenador la carpeta `system/vocabulary` **entera** y `documents/My Clippings.txt`, y arrástralos a la página. La carpeta entera importa: el Kindle guarda primero las palabras que buscas en `vocab.db-wal` y tarda en pasarlas a `vocab.db`, así que con `vocab.db` solo faltarían las más recientes (KindleVault avisa si eliges `vocab.db` sin su `-wal`). Tras cada importación dice cuál es la **última palabra buscada** que ha leído, para que se vea si los datos están al día.

**Volver a escanear.** Si has descargado un libro, subrayado o buscado palabras desde la última vez, pulsa **🔄 Volver a escanear el Kindle** (arriba): vuelve a leer el Kindle tal como está ahora (el de la última vez, sin volver a elegirlo si el navegador lo permite) y dice qué libros han llegado o se han ido. Lo que ya estaba no se duplica, y si algo estaba en el libro equivocado se corrige.

**¿Por qué faltan libros o subrayados?** `My Clippings.txt` solo guarda lo que subrayas en ese mismo Kindle; lo subrayado en el móvil, en el ordenador o en otro Kindle está en la nube de Amazon (vía 3). Cuando descargas en el Kindle un libro que subrayaste en otro aparato, el Kindle recibe esos subrayados y los guarda en la carpeta de datos del libro (`.sdr`), **sin su texto** y sin escribirlos en `My Clippings.txt`: KindleVault los cuenta y avisa («El Kindle tiene 37: faltan 32»), y su texto se trae con la vía 3. Las palabras buscadas solo están en el Kindle, que las conserva aunque borres el libro. En **Biblioteca** se ve qué libros están **en el Kindle** y cuáles tienen subrayados pero **no están descargados**.

## Llevar los subrayados a UltraMind (mapa mental)

En **Subrayados y notas**, pulsa **Exportar** y elige el formato **UltraMind — mapa mental**. Sale **un mapa por libro**: el título es el tema central y cada subrayado, una rama. No lleva ubicación, fecha ni autor; solo las notas que escribiste tú en el Kindle, guardadas en la nota de su subrayado. Con varios libros se descarga un archivo por libro.

En UltraMind: **Abrir o importar** y arrastra el archivo, o pega allí el texto (botón **Copiar**, con un solo libro filtrado) y pulsa **Importar el texto**.

## Estudiar el vocabulario en VocaMaster

En **Vocabulario**, pulsa **Enviar a VocaMaster** y luego **📤 Abrir VocaMaster y enviar**. Se abre VocaMaster (inicia sesión si te lo pide: las palabras esperan) con una vista previa, **📚 Desde KindleVault**, donde:

- cada palabra dice qué se hará con ella: **Nueva** (su IA crea la ficha con la traducción y la definición del sentido que tiene en la frase del libro, y guarda esa frase como ejemplo), **Ya la tienes · frase nueva** (la frase va a «Más ejemplos» de la que ya tienes) o **Repetida**;
- puedes corregir la palabra, quitarla del envío y ponerle o quitarle etiquetas (por defecto, el libro y «kindle»), una a una o **varias a la vez**: elige las que quieras (o todas las de un libro) y añade o quita etiquetas, con tus etiquetas de VocaMaster como botones;
- al pulsar **Añadir a VocaMaster**, aquí quedan marcadas como **Enviada**.

Van en su forma base («run» en vez de «ran», si quieres) y, si marcas **Todas sus frases**, con cada frase en la que buscaste la palabra. Las de otro idioma esperan en VocaMaster hasta que cambies a ese idioma. Si VocaMaster no se abre, **Copiar y pegar a mano** da los bloques de siempre (`palabra | frase`, hasta 50 por bloque) para **+** → **Vocabulario** → **✍️ Pegar Texto**.

Al copiar un bloque, sus palabras también quedan marcadas como **Enviada**, para no mandarlas otra vez. Cada palabra se puede marcar también como **Me la sé** o **Ignorar** (las que el Kindle ya da por aprendidas entran como «Me la sé»), y el filtro **Estado** de la izquierda decide cuáles se ven. Estas marcas viajan con la sincronización.

En «Copiar y pegar a mano», **Un bloque por libro** saca cada libro en sus propios bloques (con su título).

**Las que se te resisten.** En **Vocabulario**, el filtro **Solo las que se te resisten** deja las palabras que has buscado dos veces o más (en el mismo libro o en varios), de más a menos búsquedas y con todas sus frases juntas; cada palabra repetida lo indica («Buscada 7 veces en 6 libros»). Son buenas candidatas para VocaMaster. El filtro **Idioma** cuenta, en esta pestaña, el idioma de cada palabra.

Para mandar solo **palabras concretas**, marca su casilla en la lista (Mayús+clic elige un tramo) y pulsa **Enviar a VocaMaster** en la barra que aparece encima.

## Historial de lectura

La pestaña **Historial** saca de las fechas de tus búsquedas y subrayados: cuántos hay por año, los idiomas de tus palabras, los libros con más palabras buscadas, las palabras que más se te resisten y una **línea de tiempo** con cuándo leíste cada libro. Todo se puede pulsar: un libro abre sus subrayados o sus palabras; una palabra, todas sus frases.

## Escuchar y traducir

En cada palabra, frase y subrayado de otro idioma hay **🔊** (lo lee la voz del navegador: en Edge, las mismas voces naturales de «Leer en voz alta») y **Traducir**. En Chrome de escritorio la traducción la hace el propio navegador, en el ordenador y sin enviar el texto a ningún sitio (la primera vez descarga el idioma). En otros navegadores ofrece abrir el Traductor de Google.

## Notas y subrayados ampliados

- Cada nota que escribes en el Kindle aparece **dentro de su subrayado** (el Kindle las guarda por separado).
- Si amplías un subrayado, el Kindle guarda también la versión corta. KindleVault la oculta para no verla repetida; se puede ver con el filtro **Versiones anteriores**.

## Sincronización entre ordenadores

Pulsa la píldora de sincronización (arriba a la derecha):

- **En el primer ordenador:** *Crear archivo de sincronización* y guárdalo en una carpeta que se sincronice sola (OneDrive, Dropbox…).
- **En los demás:** *Vincular un archivo existente* y elige ese mismo archivo.

A partir de ahí se sincroniza solo: al abrir la web, al volver a ella y tras cada importación. Por seguridad, Chrome pide **un clic** para usar el archivo en cada sesión nueva del navegador; la app te lo pregunta con un aviso.

La sincronización **combina** los datos: nunca borra nada y nunca sobrescribe un archivo que no ha podido leer.

## Dónde están tus datos

- En el almacenamiento de tu navegador (IndexedDB), en cada ordenador.
- En tu archivo de sincronización, si lo usas.

Este repositorio solo contiene el código: tus subrayados no se suben a GitHub ni a ningún servidor. Las únicas peticiones externas son las de las portadas (a Open Library) y las fuentes tipográficas (Google Fonts); y, solo si tú lo pulsas, abrir el Traductor de Google con el texto a traducir (en los navegadores sin traductor propio).

## Qué se importa

| Tipo | Se muestra por defecto |
|---|---|
| Subrayados y notas | Sí |
| Marcadores de página | Sí |
| Sin texto (imágenes, tablas…) | No (filtro "Sin texto") |
| Bloqueados por el límite de recortes de Amazon | No (filtro "Bloqueados") |

Los textos bloqueados por Amazon no se pueden recuperar: el Kindle no los escribe en `My Clippings.txt`.

## Estructura del código

```
index.html          Página
css/styles.css      Estilos (tema papel, modo oscuro automático, móvil)
js/app.js           Interfaz
js/parser.js        Lectura de My Clippings.txt y vocab.db
js/sqlite-reader.js Lector de SQLite propio (sin dependencias)
js/store.js         Biblioteca local en IndexedDB y combinación de datos
js/sync.js          Archivo de sincronización
js/kindle.js        Acceso a la unidad del Kindle
js/covers.js        Portadas de Open Library
js/export.js        Exportación (UltraMind, Markdown, TXT, CSV, JSON) y bloques para VocaMaster
js/notebook.js      Cuadernos exportados de la app Kindle y archivo de la nube de Amazon
js/amazon.js        Marcador que lee el cuaderno de Kindle en Amazon
js/bookmeta.js      Título y ASIN de los libros del Kindle (nombre de archivo y cabecera MOBI)
js/sidecar.js       Recuento de anotaciones de las carpetas .sdr del Kindle
js/speech.js        Pronunciación con las voces del navegador
js/translate.js     Traducción con el traductor del navegador
```

No necesita compilación: GitHub Pages sirve los archivos tal cual. Para probarla en local, abre un servidor en la carpeta (por ejemplo `python3 -m http.server`) y entra en `http://localhost:8000`.
