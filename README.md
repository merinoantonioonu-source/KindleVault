# KindleVault

Subrayados, notas, marcadores y vocabulario de tu Kindle, en una web que se usa desde el navegador. No hay que instalar nada.

**Abrir la app:** https://merinoantonioonu-source.github.io/KindleVault/

Funciona mejor en **Chrome o Edge de escritorio**, que permiten leer el Kindle directamente y sincronizar con un archivo. En otros navegadores (Firefox, Safari, móvil) se pueden importar los archivos a mano y consultar los datos, pero no hay sincronización automática.

## Cómo se usa

1. Conecta el Kindle por USB.
2. Pulsa **Importar del Kindle → Elegir el Kindle** y selecciona la unidad del Kindle (por ejemplo `D:`).
3. La app lee `documents/My Clippings.txt` y `system/vocabulary/vocab.db`. Solo lee: nunca escribe en el Kindle.

Puedes repetir la importación cuando quieras; lo que ya estaba no se duplica.

## Llevar los subrayados a UltraMind (mapa mental)

En **Subrayados y notas**, pulsa **Exportar** y elige el formato **UltraMind — mapa mental**. Cada libro es una rama y cada subrayado cuelga de él; tus notas del Kindle, la ubicación y la fecha van en la nota de cada rama, para que el mapa quede limpio. Con un solo libro filtrado, el libro es el tema central.

En UltraMind: **Abrir o importar** y arrastra el archivo descargado, o pega allí el texto (botón **Copiar**) y pulsa **Importar el texto**.

## Estudiar el vocabulario en VocaMaster

En **Vocabulario**, pulsa **Enviar a VocaMaster**. Las palabras salen en bloques de 50, separados por idioma, una por línea y sin repetir (en su forma base: «run» en vez de «ran», si quieres). Copia un bloque y pégalo en VocaMaster: botón **+** → **Vocabulario** → **✍️ Pegar Texto** → **🚀 Procesar Texto**. La IA de VocaMaster pone la traducción, la definición y un ejemplo.

Al copiar un bloque, sus palabras quedan marcadas como **Enviada**, para no mandarlas otra vez. Cada palabra se puede marcar también como **Me la sé** o **Ignorar** (las que el Kindle ya da por aprendidas entran como «Me la sé»), y el filtro **Estado** de la izquierda decide cuáles se ven. Estas marcas viajan con la sincronización.

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

Este repositorio solo contiene el código: tus subrayados no se suben a GitHub ni a ningún servidor. Las únicas peticiones externas son las de las portadas (a Open Library) y las fuentes tipográficas (Google Fonts).

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
```

No necesita compilación: GitHub Pages sirve los archivos tal cual. Para probarla en local, abre un servidor en la carpeta (por ejemplo `python3 -m http.server`) y entra en `http://localhost:8000`.
