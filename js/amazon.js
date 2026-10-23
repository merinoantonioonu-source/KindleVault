// Marcador «KindleVault: nube de Amazon».
// Se arrastra a la barra de marcadores y se pulsa estando en el cuaderno de
// Kindle de Amazon (read.amazon.com/notebook o leer.amazon.es/notebook), con la
// sesión iniciada. Allí mismo lee la lista de libros con subrayados (todos,
// también los no descargados en ningún aparato) y los subrayados y notas de
// cada uno, y descarga un archivo .json para importarlo en KindleVault.
// No envía nada a ningún sitio: solo lee páginas de Amazon con tu sesión.
//
// OJO: la función se convierte en texto y se ejecuta dentro de la página de
// Amazon, así que no puede usar nada de fuera de ella. Sin comentarios de
// línea dentro: algunos navegadores juntan las líneas del marcador.

function kindleVaultAmazon() {
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
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      const bad = out.filter(b => b.failed).length;
      say('✓ ' + out.length + ' libros y ' + total + ' subrayados y notas.' +
        (bad ? '<br>' + (bad === 1 ? '1 libro no se pudo leer' : bad + ' libros no se pudieron leer') + ' (vuelve a pulsar el marcador más tarde para reintentarlo).' : '') +
        (!total ? '<br><b>No he encontrado ningún subrayado</b>: puede que Amazon haya cambiado su página.' : '') +
        '<br><br>Se ha descargado <b>' + escapeHtml(name) + '</b>. Ábrelo en KindleVault: <b>Importar → Elegir archivos</b>.', true);
    } catch (e) {
      say('Algo ha fallado: ' + escapeHtml(e && e.message), true);
    }
  })();
}

/** El enlace que se arrastra a la barra de marcadores. */
export function amazonBookmarkletHref() {
  return 'javascript:' + encodeURIComponent('(' + kindleVaultAmazon.toString() + ')()');
}
