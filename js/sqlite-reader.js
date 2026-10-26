// Lector mínimo de bases de datos SQLite, solo lectura y sin dependencias.
// Implementa el formato de archivo documentado en https://www.sqlite.org/fileformat.html:
// cabecera, B-trees de tabla (hojas e internos), páginas de desbordamiento,
// registros y, si existe, el archivo -wal (para leer cambios aún no volcados).

const TEXT_DECODERS = {
  1: new TextDecoder('utf-8'),
  2: new TextDecoder('utf-16le'),
  3: new TextDecoder('utf-16be'),
};

export class SQLiteReader {
  /**
   * @param {ArrayBuffer|Uint8Array} dbBytes  contenido de la base de datos
   * @param {ArrayBuffer|Uint8Array} [walBytes] contenido del archivo -wal, si lo hay
   */
  constructor(dbBytes, walBytes = null) {
    this.bytes = dbBytes instanceof Uint8Array ? dbBytes : new Uint8Array(dbBytes);
    const magic = new TextDecoder('ascii').decode(this.bytes.subarray(0, 15));
    if (magic !== 'SQLite format 3') {
      throw new Error('El archivo no es una base de datos SQLite válida.');
    }
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    let pageSize = this.view.getUint16(16);
    if (pageSize === 1) pageSize = 65536;
    this.pageSize = pageSize;
    this.usable = pageSize - this.view.getUint8(20);
    this.decoder = TEXT_DECODERS[this.view.getUint32(56)] || TEXT_DECODERS[1];
    // Versión de escritura 2 = modo WAL: los últimos cambios pueden estar aún en el -wal.
    this.walMode = this.view.getUint8(18) === 2;
    this.walPages = new Map();
    this.walFrames = 0;
    if (walBytes && walBytes.byteLength > 32) this._loadWal(walBytes);
    this._schema = null;
    this._reached = new Set(); // páginas alcanzadas desde algún B-tree (para el diagnóstico)
  }

  /** Datos de la cabecera, para el informe. */
  info() {
    const v = this.view;
    return {
      pageSize: this.pageSize,
      pages: Math.floor(this.bytes.byteLength / this.pageSize),
      pagesInHeader: v.getUint32(28),
      freelistPages: v.getUint32(36),
      changeCounter: v.getUint32(24),
      autoVacuum: v.getUint32(52) !== 0,
      walMode: this.walMode,
    };
  }

  // ---------- WAL ----------
  _loadWal(walBytes) {
    const wal = walBytes instanceof Uint8Array ? walBytes : new Uint8Array(walBytes);
    const v = new DataView(wal.buffer, wal.byteOffset, wal.byteLength);
    const magic = v.getUint32(0);
    if (magic !== 0x377f0682 && magic !== 0x377f0683) return;
    const pageSize = v.getUint32(8);
    if (pageSize !== this.pageSize) return;
    const salt1 = v.getUint32(16), salt2 = v.getUint32(20);
    const frameSize = 24 + pageSize;
    const pending = new Map();
    for (let off = 32; off + frameSize <= wal.byteLength; off += frameSize) {
      if (v.getUint32(off + 8) !== salt1 || v.getUint32(off + 12) !== salt2) break;
      const pageNo = v.getUint32(off);
      this.walFrames++;
      pending.set(pageNo, wal.subarray(off + 24, off + 24 + pageSize));
      // Un "commit frame" (tamaño de BD > 0) consolida todo lo pendiente.
      if (v.getUint32(off + 4) !== 0) {
        for (const [p, data] of pending) this.walPages.set(p, data);
        pending.clear();
      }
    }
  }

  // ---------- Páginas ----------
  _page(n) {
    if (this.walPages.has(n)) return this.walPages.get(n);
    const start = (n - 1) * this.pageSize;
    if (start + this.pageSize > this.bytes.byteLength) {
      throw new Error(`Página ${n} fuera del archivo (¿base de datos truncada?).`);
    }
    return this.bytes.subarray(start, start + this.pageSize);
  }

  static _varint(buf, pos) {
    let value = 0n;
    for (let i = 0; i < 8; i++) {
      const b = buf[pos + i];
      value = (value << 7n) | BigInt(b & 0x7f);
      if (b < 0x80) return [value, i + 1];
    }
    value = (value << 8n) | BigInt(buf[pos + 8]);
    return [value, 9];
  }

  // Recorre un B-tree de tabla y devuelve [rowid, payload] de cada fila, en orden.
  *_walkTable(rootPage) {
    const stack = [rootPage];
    const seen = new Set();
    while (stack.length) {
      const pageNo = stack.pop();
      if (seen.has(pageNo)) continue; // protección ante bases corruptas
      seen.add(pageNo);
      this._reached.add(pageNo);
      const page = this._page(pageNo);
      const hdr = pageNo === 1 ? 100 : 0;
      const pv = new DataView(page.buffer, page.byteOffset, page.byteLength);
      const type = page[hdr];
      const nCells = pv.getUint16(hdr + 3);
      if (type === 0x05) { // interior de tabla
        const children = [];
        for (let i = 0; i < nCells; i++) {
          const cellOff = pv.getUint16(hdr + 12 + i * 2);
          children.push(pv.getUint32(cellOff));
        }
        children.push(pv.getUint32(hdr + 8)); // hijo más a la derecha
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      } else if (type === 0x0d) { // hoja de tabla
        for (let i = 0; i < nCells; i++) {
          let p = pv.getUint16(hdr + 8 + i * 2);
          const [psize, n1] = SQLiteReader._varint(page, p); p += n1;
          const [rowid, n2] = SQLiteReader._varint(page, p); p += n2;
          yield [rowid, this._payload(page, p, Number(psize))];
        }
      } else {
        throw new Error(`Tipo de página inesperado (${type}) en la página ${pageNo}.`);
      }
    }
  }

  _payload(page, pos, total) {
    const U = this.usable;
    const X = U - 35;
    if (total <= X) return page.subarray(pos, pos + total);
    const M = Math.floor(((U - 12) * 32) / 255) - 23;
    let K = M + ((total - M) % (U - 4));
    const local = K <= X ? K : M;
    const out = new Uint8Array(total);
    out.set(page.subarray(pos, pos + local), 0);
    let written = local;
    let next = new DataView(page.buffer, page.byteOffset).getUint32(pos + local);
    while (written < total && next) {
      this._reached.add(next);
      const ov = this._page(next);
      const chunk = Math.min(U - 4, total - written);
      out.set(ov.subarray(4, 4 + chunk), written);
      written += chunk;
      next = new DataView(ov.buffer, ov.byteOffset).getUint32(0);
    }
    return out;
  }

  _record(payload) {
    const [hsize, n] = SQLiteReader._varint(payload, 0);
    const headerEnd = Number(hsize);
    const types = [];
    for (let p = n; p < headerEnd;) {
      const [t, k] = SQLiteReader._varint(payload, p);
      types.push(Number(t));
      p += k;
    }
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const values = [];
    let p = headerEnd;
    for (const t of types) {
      switch (t) {
        case 0: values.push(null); break;
        case 1: values.push(dv.getInt8(p)); p += 1; break;
        case 2: values.push(dv.getInt16(p)); p += 2; break;
        case 3: values.push(((dv.getInt8(p) << 16) | dv.getUint16(p + 1))); p += 3; break;
        case 4: values.push(dv.getInt32(p)); p += 4; break;
        case 5: values.push(dv.getInt16(p) * 2 ** 32 + dv.getUint32(p + 2)); p += 6; break;
        case 6: values.push(Number(dv.getBigInt64(p))); p += 8; break;
        case 7: values.push(dv.getFloat64(p)); p += 8; break;
        case 8: values.push(0); break;
        case 9: values.push(1); break;
        default: {
          const len = t >= 12 && t % 2 === 0 ? (t - 12) / 2 : (t - 13) / 2;
          const slice = payload.subarray(p, p + len);
          values.push(t % 2 === 0 ? slice.slice() : this.decoder.decode(slice));
          p += len;
        }
      }
    }
    return values;
  }

  // ---------- Esquema ----------
  schema() {
    if (this._schema) return this._schema;
    const tables = {};
    this._indexRoots = [];
    for (const [, payload] of this._walkTable(1)) {
      const [type, name, , rootpage, sql] = this._record(payload);
      if (type === 'table' && rootpage) {
        tables[name.toLowerCase()] = { name, rootpage, sql: sql || '', ...SQLiteReader._parseColumns(sql || '') };
      } else if (type === 'index' && rootpage) this._indexRoots.push(rootpage);
    }
    this._schema = tables;
    return tables;
  }

  // Marca las páginas de un índice (para saber cuáles no cuelgan de ningún árbol).
  _markIndex(rootPage) {
    const stack = [rootPage];
    while (stack.length) {
      const pageNo = stack.pop();
      if (this._reached.has(pageNo)) continue;
      this._reached.add(pageNo);
      const page = this._page(pageNo);
      const pv = new DataView(page.buffer, page.byteOffset, page.byteLength);
      if (page[0] !== 0x02) continue; // hoja (0x0a) u otra cosa
      const nCells = pv.getUint16(3);
      for (let i = 0; i < nCells; i++) stack.push(pv.getUint32(pv.getUint16(12 + i * 2)));
      stack.push(pv.getUint32(8));
    }
  }

  /**
   * Filas en hojas de tabla que no cuelgan de ningún árbol: restos de filas
   * borradas (páginas libres) o, si las hubiera, filas que este lector no
   * alcanza. Solo para el diagnóstico.
   */
  *orphanRows() {
    const schema = this.schema();
    for (const t of Object.values(schema)) for (const _ of this._walkTable(t.rootpage)) { /* marca */ }
    for (const r of this._indexRoots) { try { this._markIndex(r); } catch { /* índice ilegible */ } }
    const pages = Math.floor(this.bytes.byteLength / this.pageSize);
    for (let n = 2; n <= Math.max(pages, ...this.walPages.keys()); n++) {
      if (this._reached.has(n)) continue;
      let page;
      try { page = this._page(n); } catch { continue; }
      if (page[0] !== 0x0d) continue;
      const pv = new DataView(page.buffer, page.byteOffset, page.byteLength);
      const nCells = pv.getUint16(3);
      if (!nCells || 8 + nCells * 2 > this.pageSize) continue;
      for (let i = 0; i < nCells; i++) {
        try {
          let p = pv.getUint16(8 + i * 2);
          if (p < 8 || p >= this.pageSize) continue;
          const [psize, n1] = SQLiteReader._varint(page, p); p += n1;
          const [rowid, n2] = SQLiteReader._varint(page, p); p += n2;
          if (psize > 1000000n) continue;
          yield { page: n, rowid: Number(rowid), values: this._record(this._payload(page, p, Number(psize))) };
        } catch { /* celda rota */ }
      }
    }
  }

  static _parseColumns(sql) {
    const open = sql.indexOf('(');
    const close = sql.lastIndexOf(')');
    const body = open >= 0 && close > open ? sql.slice(open + 1, close) : '';
    const parts = [];
    let depth = 0, cur = '', quote = null;
    for (const ch of body) {
      if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`' || ch === '[') { quote = ch === '[' ? ']' : ch; cur += ch; continue; }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    const columns = [];
    let rowidAlias = -1;
    for (const def of parts) {
      if (/^(constraint|primary\s+key|unique|check|foreign\s+key)\b/i.test(def)) continue;
      const m = def.match(/^("([^"]+)"|`([^`]+)`|\[([^\]]+)\]|'([^']+)'|(\S+))\s*(.*)$/s);
      if (!m) continue;
      const name = m[2] || m[3] || m[4] || m[5] || m[6];
      if (/^integer\s+primary\s+key\b/i.test(m[7] || '')) rowidAlias = columns.length;
      columns.push(name);
    }
    return { columns, rowidAlias };
  }

  /** Devuelve todas las filas de una tabla como objetos { columna: valor }. */
  rows(tableName) {
    const t = this.schema()[tableName.toLowerCase()];
    if (!t) throw new Error(`La tabla ${tableName} no existe en la base de datos.`);
    const out = [];
    for (const [rowid, payload] of this._walkTable(t.rootpage)) {
      const vals = this._record(payload);
      const obj = {};
      t.columns.forEach((c, i) => { obj[c] = i < vals.length ? vals[i] : null; });
      if (t.rowidAlias >= 0) obj[t.columns[t.rowidAlias]] = Number(rowid);
      out.push(obj);
    }
    return out;
  }

  hasTable(name) {
    return Boolean(this.schema()[name.toLowerCase()]);
  }
}
