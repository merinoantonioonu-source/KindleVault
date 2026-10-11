"""
KindleVault — servidor HTTP local.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import threading
import traceback
import webbrowser
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .core import (
    ClippingsParser, Exporter, ExportOptions, LocalStore,
    VocabReader, find_clippings_path, find_kindle_mount,
)


HOST = "127.0.0.1"
PORT = 5173

APP_DIR = Path.home() / ".kindlevault"
APP_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = APP_DIR / "kindlevault.sqlite"
EXPORTS_DIR = APP_DIR / "exports"
EXPORTS_DIR.mkdir(exist_ok=True)
DIAG_DIR = APP_DIR / "diagnostics"
DIAG_DIR.mkdir(exist_ok=True)

STATIC_DIR = Path(__file__).parent / "static"
TEMPLATES_DIR = Path(__file__).parent / "templates"

store = LocalStore(DB_PATH)


# ============================================================
#  HANDLERS DE LA API
# ============================================================

def api_status() -> dict:
    mount = find_kindle_mount()
    clippings = find_clippings_path(mount) if mount else None
    vocab_db = mount / "system" / "vocabulary" / "vocab.db" if mount else None
    return {
        "kindle_connected": mount is not None,
        "mount_path": str(mount) if mount else None,
        "clippings_path": str(clippings) if clippings else None,
        "clippings_exists": bool(clippings),
        "vocab_path": str(vocab_db) if vocab_db else None,
        "vocab_exists": bool(vocab_db and vocab_db.exists()),
        "stats": store.stats(),
        "db_path": str(DB_PATH),
    }


def api_sync() -> dict:
    """Sincroniza desde el Kindle. Devuelve resultado detallado y errores."""
    mount = find_kindle_mount()
    if not mount:
        return {
            "ok": False,
            "error": "No se encontró ningún Kindle conectado.",
            "hint": "Comprueba que el Kindle aparece como unidad montada.",
        }

    result = {
        "ok": True,
        "highlights_new": 0,
        "highlights_dup": 0,
        "highlights_failed_insert": 0,
        "highlights_parse_failed": 0,
        "vocab_new": 0,
        "warnings": [],
        "insert_errors": [],
    }

    # 1) Vocab primero
    vocab_path = mount / "system" / "vocabulary" / "vocab.db"
    lang_map: dict[str, str] = {}
    if vocab_path.exists():
        try:
            entries = VocabReader().read(vocab_path)
            for e in entries:
                if e.book_title and e.language:
                    lang_map[e.book_title] = e.language
            result["vocab_new"] = store.insert_vocab(entries)
        except Exception as e:
            result["warnings"].append(f"Error leyendo vocab.db: {e}")
            result["vocab_error"] = str(e)
    else:
        result["warnings"].append("vocab.db no encontrado en el Kindle.")

    # 2) Clippings
    clippings_path = find_clippings_path(mount)
    if not clippings_path:
        result["warnings"].append(
            "My Clippings.txt no encontrado. Buscado en documents/ y raíz."
        )
        result["highlights_error"] = "Archivo no encontrado"
    else:
        try:
            parser = ClippingsParser()
            diag = parser.diagnose(clippings_path)
            result["clippings_diagnosis"] = {
                "file": diag.file_path,
                "size": diag.file_size,
                "encoding": diag.file_encoding,
                "total_blocks": diag.total_blocks,
                "parsed_ok": diag.parsed_ok,
                "parsed_failed": diag.parsed_failed,
                "failures": diag.failures,
            }
            result["highlights_parse_failed"] = diag.parsed_failed

            # Recolectar todos los highlights primero
            highlights = list(parser.parse_file(clippings_path))

            # Asignar idiomas desde vocab
            for h in highlights:
                if h.book_title in lang_map:
                    h.language = lang_map[h.book_title]
                else:
                    for known_title, lang in lang_map.items():
                        if known_title in h.book_title or h.book_title in known_title:
                            h.language = lang
                            break

            # INSERTAR uno a uno con captura de errores individuales.
            # Esto evita que un fallo en un highlight tumbe los 2030.
            new, dup, failed = 0, 0, 0
            errors_sample: list[str] = []
            for h in highlights:
                try:
                    book_id = store.upsert_book(h.book_title, h.author, h.language)
                    cur = store.conn.execute(
                        "INSERT INTO highlights(book_id, type, content, "
                        "location_start, location_end, page, highlighted_at, hash) "
                        "VALUES (?,?,?,?,?,?,?,?);",
                        (book_id, h.type, h.content, h.location_start,
                         h.location_end, h.page, h.highlighted_at, h.hash()),
                    )
                    if cur.rowcount > 0:
                        new += 1
                except sqlite3.IntegrityError:
                    dup += 1
                except Exception as e:
                    failed += 1
                    if len(errors_sample) < 5:
                        errors_sample.append(
                            f"'{h.book_title[:40]}...' loc {h.location_start}: {e}"
                        )
            store.conn.commit()

            result["highlights_new"] = new
            result["highlights_dup"] = dup
            result["highlights_failed_insert"] = failed
            if errors_sample:
                result["insert_errors"] = errors_sample

            # Volcar diagnóstico a disco
            diag_file = DIAG_DIR / "last_sync_diagnosis.json"
            diag_file.write_text(
                json.dumps(asdict(diag), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            result["diagnosis_file"] = str(diag_file)
        except Exception as e:
            traceback.print_exc()
            result["warnings"].append(f"Error procesando My Clippings.txt: {e}")
            result["highlights_error"] = str(e)
            result["traceback"] = traceback.format_exc()

    # ESTADÍSTICAS FINALES — siempre frescas, leídas de la BD justo ahora
    result["stats"] = store.stats()
    return result


def api_diagnose_clippings() -> dict:
    """Ejecuta solo el diagnóstico, sin importar nada a la BD."""
    mount = find_kindle_mount()
    if not mount:
        return {"ok": False, "error": "Sin Kindle conectado."}
    clippings_path = find_clippings_path(mount)
    if not clippings_path:
        return {
            "ok": False,
            "error": "My Clippings.txt no encontrado.",
            "mount_path": str(mount),
            "tried": [
                str(mount / "documents" / "My Clippings.txt"),
                str(mount / "My Clippings.txt"),
            ],
        }
    diag = ClippingsParser().diagnose(clippings_path, max_failures=10, max_samples=5)
    return {"ok": True, "diagnosis": asdict(diag)}


def api_books() -> list[dict]:
    return store.list_books()


def api_languages() -> list[dict]:
    return store.list_languages()


def api_highlights(qs: dict) -> list[dict]:
    return store.filter_highlights(
        book_ids=_int_list(qs.get("book_ids")),
        languages=_str_list(qs.get("languages")),
        search=_first(qs.get("search")),
        types=_str_list(qs.get("types")),
    )


def api_vocab(qs: dict) -> list[dict]:
    return store.filter_vocab(
        languages=_str_list(qs.get("languages")),
        book_titles=_str_list(qs.get("book_titles")),
        search=_first(qs.get("search")),
    )


def api_export(payload: dict) -> dict:
    kind = payload.get("kind")
    fmt = payload.get("format", "markdown")
    filters = payload.get("filters", {})
    opts_dict = payload.get("options", {})
    opts = ExportOptions(**opts_dict) if opts_dict else ExportOptions()

    if kind == "highlights":
        data = store.filter_highlights(
            book_ids=filters.get("book_ids"),
            languages=filters.get("languages"),
            search=filters.get("search"),
            types=filters.get("types"),
        )
    elif kind == "vocab":
        data = store.filter_vocab(
            languages=filters.get("languages"),
            book_titles=filters.get("book_titles"),
            search=filters.get("search"),
        )
    else:
        return {"ok": False, "error": f"kind desconocido: {kind}"}

    exporter = Exporter()
    ext = {"markdown": "md", "txt": "txt", "csv": "csv", "json": "json"}[fmt]

    if kind == "highlights":
        if fmt == "markdown": content = exporter.highlights_to_markdown(data, opts)
        elif fmt == "txt": content = exporter.highlights_to_txt(data, opts)
        elif fmt == "csv": content = exporter.highlights_to_csv(data, opts)
        else: content = exporter.highlights_to_json(data, opts)
    else:
        if fmt == "markdown": content = exporter.vocab_to_markdown(data, opts)
        elif fmt == "txt": content = exporter.vocab_to_txt(data, opts)
        elif fmt == "csv": content = exporter.vocab_to_csv(data, opts)
        else: content = exporter.vocab_to_json(data, opts)

    from datetime import datetime
    fname = f"{kind}_{datetime.now():%Y%m%d_%H%M%S}.{ext}"
    out_path = EXPORTS_DIR / fname
    out_path.write_text(content, encoding="utf-8")

    return {
        "ok": True, "path": str(out_path), "filename": fname,
        "bytes": len(content.encode("utf-8")), "items": len(data),
        "preview": content[:1500],
    }


def api_open_exports_folder() -> dict:
    import subprocess
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", str(EXPORTS_DIR)])
        elif sys.platform.startswith("win"):
            import os
            os.startfile(str(EXPORTS_DIR))  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["xdg-open", str(EXPORTS_DIR)])
        return {"ok": True, "path": str(EXPORTS_DIR)}
    except Exception as e:
        return {"ok": False, "error": str(e), "path": str(EXPORTS_DIR)}


def api_fetch_covers(limit: int | None = None) -> dict:
    """Busca portadas para libros que aún no tengan."""
    from .covers import find_cover

    pending = store.books_without_cover()
    if limit:
        pending = pending[:limit]

    found = 0
    not_found = 0
    for b in pending:
        url = find_cover(b["title"], b["author"])
        if url:
            store.set_book_cover(b["id"], url)
            found += 1
        else:
            store.set_book_cover(b["id"], "__not_found__")
            not_found += 1

    return {
        "ok": True,
        "checked": len(pending),
        "found": found,
        "not_found": not_found,
    }


def api_merge_duplicates() -> dict:
    """Fusiona libros duplicados existentes en la BD."""
    n = store.merge_duplicate_books()
    return {"ok": True, "merged": n, "stats": store.stats()}


def _first(v):
    if v is None: return None
    return v[0] if isinstance(v, list) else v

def _int_list(v):
    if not v: return None
    raw = v[0] if isinstance(v, list) else v
    if not raw: return None
    return [int(x) for x in raw.split(",") if x.strip().isdigit()]

def _str_list(v):
    if not v: return None
    raw = v[0] if isinstance(v, list) else v
    if not raw: return None
    parts = [x.strip() for x in raw.split(",") if x.strip()]
    return parts or None


# ============================================================
#  HTTP HANDLER
# ============================================================

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:
        pass

    def _send_json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path, content_type: str) -> None:
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path in ("/", "/index.html"):
            self._send_file(TEMPLATES_DIR / "index.html", "text/html; charset=utf-8")
            return
        if path == "/app.js":
            self._send_file(STATIC_DIR / "app.js", "application/javascript; charset=utf-8")
            return
        if path == "/styles.css":
            self._send_file(STATIC_DIR / "styles.css", "text/css; charset=utf-8")
            return

        try:
            if path == "/api/status": self._send_json(api_status()); return
            if path == "/api/books": self._send_json(api_books()); return
            if path == "/api/languages": self._send_json(api_languages()); return
            if path == "/api/highlights": self._send_json(api_highlights(qs)); return
            if path == "/api/vocab": self._send_json(api_vocab(qs)); return
            if path == "/api/diagnose": self._send_json(api_diagnose_clippings()); return
            if path == "/api/open-exports": self._send_json(api_open_exports_folder()); return
        except Exception as e:
            traceback.print_exc()
            self._send_json({"error": str(e)}, status=500); return

        self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", "0"))
        body_raw = self.rfile.read(length) if length > 0 else b""
        try:
            body = json.loads(body_raw) if body_raw else {}
        except json.JSONDecodeError:
            body = {}

        try:
            if path == "/api/sync": self._send_json(api_sync()); return
            if path == "/api/export": self._send_json(api_export(body)); return
            if path == "/api/fetch-covers":
                limit = body.get("limit") if isinstance(body, dict) else None
                self._send_json(api_fetch_covers(limit)); return
            if path == "/api/merge-duplicates":
                self._send_json(api_merge_duplicates()); return
        except Exception as e:
            traceback.print_exc()
            self._send_json({"error": str(e)}, status=500); return

        self.send_error(404)


def serve_forever() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}"
    print(f"\n  KindleVault corriendo en {url}")
    print(f"  Datos guardados en: {APP_DIR}")
    print(f"  Para cerrar: pulsa Ctrl+C en esta ventana.\n")

    threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nCerrando KindleVault…")
        server.shutdown()
