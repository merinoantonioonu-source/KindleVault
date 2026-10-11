# KindleVault

Subrayados, notas, marcadores y vocabulario de tu Kindle, en una web que se usa desde el navegador. No hay que instalar nada.

**Abrir la app:** https://merinoantonioonu-source.github.io/KindleVault/

Funciona mejor en **Chrome o Edge de escritorio**, que permiten leer el Kindle directamente y sincronizar con un archivo. En otros navegadores (Firefox, Safari, móvil) se pueden importar los archivos a mano y consultar los datos, pero no hay sincronización automática.

## Cómo se usa

1. Conecta el Kindle por USB.
2. Pulsa **Importar del Kindle → Elegir el Kindle** y selecciona la unidad del Kindle (por ejemplo `D:`).
3. La app lee `documents/My Clippings.txt` y `system/vocabulary/vocab.db`. Solo lee: nunca escribe en el Kindle.

Puedes repetir la importación cuando quieras; lo que ya estaba no se duplica.

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
js/export.js        Exportación (Markdown, TXT, CSV, JSON)
```

No necesita compilación: GitHub Pages sirve los archivos tal cual. Para probarla en local, abre un servidor en la carpeta (por ejemplo `python3 -m http.server`) y entra en `http://localhost:8000`.
