# KindleVault

Aplicación de escritorio para extraer, organizar y exportar los subrayados, notas y vocabulario buscado en tu Kindle, con control total sobre qué metadatos se incluyen al exportar.

---

## Cómo arrancar la app (paso a paso)

### En Windows

1. Asegúrate de tener Python 3 instalado:
   - Si no lo tienes, descárgalo desde https://www.python.org/downloads/
   - Durante la instalación, **marca la casilla "Add Python to PATH"**. Es importante.
2. Descomprime este zip en cualquier carpeta (por ejemplo, en el Escritorio).
3. Haz **doble clic en `KindleVault.bat`**.
4. Se abrirá una ventana negra con el logo y, en 1-2 segundos, tu navegador con la app.
5. **No cierres la ventana negra mientras uses la app.** Para cerrar, pulsa Ctrl+C en esa ventana o ciérrala.

### En macOS

1. Si no tienes Python 3, instálalo desde https://www.python.org/downloads/
2. Descomprime este zip donde prefieras.
3. La primera vez, abre el Terminal, arrastra el archivo `KindleVault.command` a la ventana del Terminal y pulsa Enter. (Esto solo es necesario una vez para autorizarlo.)
4. A partir de ahí, **doble clic en `KindleVault.command`** lo arrancará.
5. Si macOS dice "no se puede abrir porque es de un desarrollador no identificado", haz clic derecho → Abrir → Abrir.

### En Linux

1. Asegúrate de tener Python 3 (la mayoría de distribuciones ya lo incluyen).
2. Abre un terminal en la carpeta descomprimida y ejecuta `./KindleVault.command`, o haz doble clic si tu gestor de archivos lo permite.

---

## Cómo usar la app

1. **Conecta tu Kindle al ordenador con su cable USB.** El sistema lo montará como una unidad (en Windows, una letra nueva; en macOS, un volumen llamado Kindle).
2. En la app, pulsa el botón **"Sincronizar"** arriba a la derecha. Verás un mensaje con cuántos subrayados y palabras se han importado.
3. **Puedes desconectar el Kindle**: la app guarda todo en una base de datos local en tu ordenador. Trabajarás siempre sobre esa copia local.

### Pestañas

- **Subrayados y notas**: vista principal. En la barra lateral izquierda puedes filtrar por idioma, por libros (selección múltiple) y por tipo (subrayados o notas).
- **Vocabulario**: las palabras que has buscado en el diccionario del Kindle, con la frase de contexto donde apareció cada una.
- **Biblioteca**: lista de tus libros con cuenta de subrayados.

### Exportar

Pulsa **"Exportar..."** arriba a la derecha. Verás un diálogo con tres elementos clave:

- **Formato**: Markdown (recomendado para gitMind, Obsidian, Logseq), Texto plano, CSV o JSON.
- **Presets**: tres botones rápidos con configuraciones predefinidas.
- **Casillas individuales**: control granular sobre cada metadato.

Los tres presets son:

- **Completo**: incluye todo (libro, autor, idioma, ubicación, fecha, tipo, contexto, etc.).
- **Solo texto**: exporta únicamente el contenido de los subrayados o las palabras, sin libro, autor, ubicación ni fecha. Esto es lo que pediste: el texto desnudo.
- **Para estudio**: equilibrio útil para repasar — incluye libro, idioma y contexto, pero omite metadatos ruidosos como ubicaciones y fechas.

Puedes empezar desde un preset y ajustar las casillas individuales a tu gusto. La vista previa abajo del diálogo se actualiza al instante para que veas exactamente qué saldrá.

Al pulsar "Exportar archivo", se guarda en `~/.kindlevault/exports/` (en Windows: `C:\Users\<tu_usuario>\.kindlevault\exports\`). La carpeta se abre automáticamente en tu explorador de archivos.

---

## Dónde se guardan tus datos

Todo se guarda localmente en tu ordenador, en la carpeta:

- **Windows**: `C:\Users\<tu_usuario>\.kindlevault\`
- **macOS / Linux**: `~/.kindlevault/`

Dentro de esa carpeta encontrarás:

- `kindlevault.sqlite` — la base de datos con tus subrayados y vocabulario.
- `exports/` — las exportaciones que generes.

Tus datos no salen de tu ordenador.

---

### Si la sincronización no extrae libros ni subrayados

Esto suele pasar porque el formato de tu `My Clippings.txt` tiene alguna variación que el parser no reconoce. La app ahora detecta y muestra el problema:

1. Pulsa el botón **"Diagnosticar"** (al lado de Sincronizar). La app analizará tu archivo sin importar nada y mostrará un panel con: número de bloques encontrados, bloques que parsean correctamente, bloques que fallan y la razón concreta de cada fallo.
2. Si aparecen bloques fallidos, el panel mostrará las primeras líneas de cada uno. Cópialas y compártelas para añadir soporte.

El parser actual reconoce subrayados y notas en español, inglés, alemán, francés, italiano y portugués, en formatos clásicos y modernos del firmware Kindle. Pero hay variaciones poco comunes que pueden quedarse fuera.

### Otros problemas

**"Sin Kindle (modo offline)" aunque está conectado.**
Comprueba en el Finder/Explorador que el Kindle aparece como unidad montada. En macOS a veces hay que confirmar el permiso de "almacenamiento masivo" en el propio Kindle. La app busca un volumen que contenga `documents/My Clippings.txt` o `system/vocabulary/vocab.db`.

**El puerto 5173 ya está en uso.**
Significa que tienes otra instancia abierta. Cierra la otra ventana negra/terminal y vuelve a arrancar.

**No puedo abrir el .command en macOS.**
Es por la cuarentena de Gatekeeper. Haz clic derecho sobre el archivo, elige "Abrir" y confirma. Solo hace falta hacerlo una vez.

**No detecta highlights aunque tengo muchos en el Kindle.**
Asegúrate de que el archivo está en `documents/My Clippings.txt` (a veces los Kindles muy antiguos lo guardan en otra ruta). Si tu firmware está en un idioma exótico no soportado por el regex multi-idioma actual, dímelo y añadimos soporte.

---

## Limitaciones honestas

Esta versión es una app web local en Python, no una app de escritorio empaquetada. Funciona y hace todo lo que necesitas, pero a diferencia de un `.exe` o `.dmg` nativo:

- Requiere Python 3.10+ instalado en el sistema.
- Se ejecuta en una pestaña del navegador, no en una ventana propia.
- Para cerrarla del todo hay que cerrar también la ventana negra/terminal.

Si más adelante quieres una app verdaderamente nativa (un `.exe` o `.dmg` que se ejecute con doble clic sin Python), la base de código está estructurada para portarse a Tauri (Rust) o empaquetarse con PyInstaller siguiendo el plan maestro. Esa parte requiere compilar en cada sistema operativo destino.

---

## Estructura del proyecto

```
KindleVault/
├── KindleVault.bat        ← Doble clic en Windows
├── KindleVault.command    ← Doble clic en macOS/Linux
├── run.py                 ← Punto de entrada Python
├── README.md              ← Este archivo
└── app/
    ├── core.py            ← Parser, BD, exportador
    ├── server.py          ← Servidor HTTP local
    ├── templates/
    │   └── index.html     ← UI principal
    └── static/
        ├── styles.css     ← Estilos
        └── app.js         ← Lógica frontend
```
