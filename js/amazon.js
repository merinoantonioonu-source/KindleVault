// Marcador «KindleVault: nube de Amazon».
// Se arrastra a la barra de marcadores y se pulsa estando en el cuaderno de
// Kindle de Amazon (read.amazon.com/notebook o leer.amazon.es/notebook), con la
// sesión iniciada. Allí mismo lee la lista de libros con subrayados (todos,
// también los no descargados en ningún aparato) y los subrayados y notas de
// cada uno. Al terminar, «Llevar a KindleVault» abre KindleVault y le pasa los
// datos directamente (postMessage, solo a la dirección de KindleVault); si el
// navegador no lo permite, se descargan en un .json para importarlo a mano.
// No envía nada a ningún otro sitio: solo lee páginas de Amazon con tu sesión.
//
// OJO: la función se convierte en texto y se ejecuta dentro de la página de
// Amazon, así que no puede usar nada de fuera de ella. Sin comentarios de
// línea dentro: algunos navegadores juntan las líneas del marcador.

function kindleVaultAmazon(kvUrl) {
  if (window.__kindleVaultRunning) return;
  window.__kindleVaultRunning = true;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;top:16px;right:16px;width:380px;max-width:90vw;padding:16px 18px;background:#fbf8f1;color:#2a2418;border:2px solid #8b3a2f;border-radius:8px;font:14px/1.5 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25)';
  document.body.appendChild(box);
  const escapeHtml = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const say = (html, end) => {
    box.innerHTML = '<div style="font-weight:600;color:#8b3a2f;margin-bottom:6px">KindleVault · nube de Amazon</div>' + html +
      (end ? '<div style="margin-top:10px"><button id="kv-close" style="padding:4px 12px;cursor:pointer">Cerrar</button></div>' : '');
    if (end) {
      box.querySelector('#kv-close').onclick = () => box.remove();
      window.__kindleVaultRunning = false;
    }
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const txt = el => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();
  const num = s => { const m = String(s || '').match(/\d[\d.,]*/); return m ? Number(m[0].replace(/[.,]/g, '')) : null; };
  const LOC = /(?:location|posición|posicion|position|posizione|posição)\s*:?\s*([\d.,]+)/i;
  const PAGE = /(?:page|página|pagina|seite)\s*:?\s*(\d+)/i;

  const library = document.querySelector('#kp-notebook-library');
  if (!library) {
    say('Este botón funciona en tu <b>cuaderno de Kindle</b> de Amazon. Abre <b>read.amazon.com/notebook</b> (o <b>leer.amazon.es/notebook</b> si compras en amazon.es), inicia sesión y vuelve a pulsarlo.', true);
    return;
  }

  const rowsOf = (doc, selector) => {
    const rows = new Set();
    doc.querySelectorAll(selector).forEach(el => {
      let r = el;
      while (r.parentElement && r.parentElement !== doc.body && r.parentElement.querySelectorAll(selector).length <= 1) r = r.parentElement;
      rows.add(r);
    });
    return [...rows];
  };

  const parseAnnotations = doc => {
    let rows = rowsOf(doc, '[id="kp-annotation-location"]');
    if (!rows.length) rows = rowsOf(doc, '[id="highlight"], [id="note"]');
    return rows.map(row => {
      const header = txt(row.querySelector('[id="annotationHighlightHeader"], [id="annotationNoteHeader"]'));
      const input = row.querySelector('[id="kp-annotation-location"]');
      const loc = header.match(LOC);
      const page = header.match(PAGE);
      return {
        highlight: txt(row.querySelector('[id="highlight"]')),
        note: txt(row.querySelector('[id="note"]')),
        location: (input && num(input.value)) || (loc ? num(loc[1]) : null),
        page: page ? Number(page[1]) : null,
        header,
      };
    }).filter(a => a.highlight || a.note);
  };

  (async () => {
    try {
      let scroller = library;
      while (scroller && scroller.scrollHeight <= scroller.clientHeight + 5) scroller = scroller.parentElement;
      let last = -1, still = 0;
      while (still < 3) {
        const n = library.querySelectorAll('.kp-notebook-library-each-book').length;
        say('Cargando la lista de tus libros… ' + n);
        if (n === last) still++; else { still = 0; last = n; }
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        await sleep(900);
      }
      const books = [...library.querySelectorAll('.kp-notebook-library-each-book')].map(el => ({
        asin: el.id,
        title: txt(el.querySelector('h2')),
        author: txt(el.querySelector('p')).replace(/^(by|de|par|von|di|por|door)\s*:?\s*/i, ''),
      })).filter(b => b.asin && b.title);
      if (!books.length) {
        say('No he encontrado libros en tu cuaderno. Si ves libros a la izquierda, puede que Amazon haya cambiado su página: avisa a quien mantiene KindleVault.', true);
        return;
      }
      const out = [];
      let total = 0;
      for (let i = 0; i < books.length; i++) {
        const b = books[i];
        say('Leyendo ' + (i + 1) + ' de ' + books.length + ' (' + total + ' subrayados hasta ahora):<br><i>' + escapeHtml(b.title) + '</i>');
        const annotations = [];
        let token = '', state = '', pages = 0, failed = false;
        try {
          do {
            const url = location.origin + '/notebook?asin=' + encodeURIComponent(b.asin) + '&token=' + encodeURIComponent(token) + '&contentLimitState=' + encodeURIComponent(state) + '&';
            const res = await fetch(url, { credentials: 'include' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
            annotations.push(...parseAnnotations(doc));
            const next = doc.querySelector('.kp-notebook-annotations-next-page-start');
            const limit = doc.querySelector('.kp-notebook-content-limit-state');
            const newToken = next ? next.value || '' : '';
            state = limit ? limit.value || '' : '';
            token = newToken && newToken !== token ? newToken : '';
            pages++;
            await sleep(250);
          } while (token && pages < 100);
        } catch (e) {
          failed = true;
        }
        total += annotations.length;
        out.push({ ...b, failed, annotations });
      }
      const data = { format: 'kindlevault-amazon', version: 1, exportedAt: new Date().toISOString(), source: location.host, books: out };
      const name = 'kindlevault-amazon-' + new Date().toISOString().slice(0, 10) + '.json';
      const download = () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      };
      const bad = out.filter(b => b.failed).length;
      const summary = '✓ ' + out.length + ' libros y ' + total + ' subrayados y notas.' +
        (bad ? '<br>' + (bad === 1 ? '1 libro no se pudo leer' : bad + ' libros no se pudieron leer') + ' (vuelve a pulsar el marcador más tarde para reintentarlo).' : '') +
        (!total ? '<br><b>No he encontrado ningún subrayado</b>: puede que Amazon haya cambiado su página.' : '');
      const btn = 'padding:6px 14px;cursor:pointer;margin:8px 8px 0 0;border-radius:6px;border:1px solid #8b3a2f;';
      const manual = '<br><br>Si no se abre, pulsa <b>Descargar el archivo</b> (<b>' + escapeHtml(name) + '</b>, en tu carpeta de Descargas) y, en KindleVault, <b>Importar → Elegir archivos</b>, o arrástralo a la página de KindleVault.';
      say(summary + '<br><br>Último paso: pásalos a KindleVault.<br>' +
        (kvUrl ? '<button id="kv-send" style="' + btn + 'background:#8b3a2f;color:#fff">Llevar a KindleVault</button>' : '') +
        '<button id="kv-download" style="' + btn + 'background:#fff;color:#8b3a2f">Descargar el archivo</button>' +
        '<div id="kv-status" style="margin-top:8px"></div>', true);
      const status = box.querySelector('#kv-status');
      box.querySelector('#kv-download').onclick = () => { download(); status.innerHTML = 'Descargado <b>' + escapeHtml(name) + '</b> (en tu carpeta de Descargas). Ábrelo en KindleVault con <b>Importar → Elegir archivos</b>, o arrástralo a su página.'; };
      if (kvUrl) box.querySelector('#kv-send').onclick = () => {
        const target = new URL(kvUrl);
        const w = window.open(kvUrl, '_blank');
        let done = false, tries = 0;
        const onMsg = e => {
          if (e.origin !== target.origin || !e.data || e.data.type !== 'kindlevault-amazon-ok') return;
          done = true;
          window.removeEventListener('message', onMsg);
          status.innerHTML = '✓ Pasados a KindleVault. Ya puedes cerrar esta pestaña.';
        };
        window.addEventListener('message', onMsg);
        status.textContent = 'Abriendo KindleVault…';
        const timer = setInterval(() => {
          tries++;
          if (done) { clearInterval(timer); return; }
          if (!w || w.closed || tries > 40) {
            clearInterval(timer);
            window.removeEventListener('message', onMsg);
            status.innerHTML = 'No he podido pasárselos directamente.' + manual;
            return;
          }
          try { w.postMessage({ type: 'kindlevault-amazon', data }, target.origin); } catch (e) { tries = 99; }
        }, 500);
      };
    } catch (e) {
      say('Algo ha fallado: ' + escapeHtml(e && e.message), true);
    }
  })();
}

/** El enlace que se arrastra a la barra de marcadores; kvUrl: dónde está KindleVault. */
export function amazonBookmarkletHref(kvUrl = null) {
  return 'javascript:' + encodeURIComponent('(' + kindleVaultAmazon.toString() + ')(' + JSON.stringify(kvUrl) + ')');
}

/** Páginas del cuaderno de Kindle de Amazon (las únicas que pueden pasarle datos a KindleVault). */
export const AMAZON_NOTEBOOK_ORIGIN = /^https:\/\/(read|leer|lire|leggi|ler|lesen)\.amazon\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;
