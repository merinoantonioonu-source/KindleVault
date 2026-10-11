"""
KindleVault — núcleo de extracción y exportación.

Sin dependencias externas: solo librería estándar de Python.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterator


# ============================================================
#  DETECCIÓN DEL KINDLE (multiplataforma)
# ============================================================

def find_kindle_mount() -> Path | None:
    """Busca el volumen Kindle en macOS, Windows y Linux."""
    candidates: list[Path] = []

    if sys.platform == "darwin":
        candidates += [Path("/Volumes") / d for d in _safe_listdir("/Volumes")]
    elif sys.platform.startswith("win"):
        import string
        for letter in string.ascii_uppercase:
            p = Path(f"{letter}:/")
            if p.exists():
                candidates.append(p)
    else:
        for base in ("/media", "/run/media", "/mnt"):
            base_p = Path(base)
            if base_p.exists():
                for user_dir in _safe_listdir(base):
                    candidates.append(base_p / user_dir)
                    for sub in _safe_listdir(base_p / user_dir):
                        candidates.append(base_p / user_dir / sub)

    for c in candidates:
        if find_clippings_path(c) or (c / "system" / "vocabulary" / "vocab.db").exists():
            return c
    return None


def find_clippings_path(mount: Path) -> Path | None:
    """Localiza My Clippings.txt: en documents/, raíz, o case-insensitive."""
    if not mount.exists():
        return None
    for candidate in [
        mount / "documents" / "My Clippings.txt",
        mount / "My Clippings.txt",
        mount / "documents" / "My Clippings.TXT",
    ]:
        if candidate.exists():
            return candidate
    docs = mount / "documents"
    if docs.exists():
        for p in _safe_iterdir(docs):
            if p.name.lower() == "my clippings.txt":
                return p
    for p in _safe_iterdir(mount):
        if p.name.lower() == "my clippings.txt":
            return p
    return None


def _safe_listdir(path: str | Path) -> list[str]:
    try:
        return [p.name for p in Path(path).iterdir()]
    except (OSError, PermissionError):
        return []


def _safe_iterdir(path: Path) -> list[Path]:
    try:
        return list(path.iterdir())
    except (OSError, PermissionError):
        return []


# ============================================================
#  MODELOS DE DOMINIO
# ============================================================

@dataclass
class Highlight:
    book_title: str
    author: str | None
    type: str
    content: str
    location_start: int | None
    location_end: int | None
    page: int | None
    highlighted_at: str | None
    language: str | None = None

    def hash(self) -> str:
        key = f"{self.book_title}|{self.location_start}|{self.location_end}|{self.content[:200]}"
        return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


@dataclass
class VocabEntry:
    word: str
    stem: str | None
    language: str | None
    context: str | None
    book_title: str | None
    looked_up_at: str | None


@dataclass
class ParseDiagnostic:
    """Información detallada para depurar problemas de parseo."""
    file_path: str
    file_size: int
    file_encoding: str
    total_blocks: int
    parsed_ok: int
    parsed_failed: int
    failures: list[dict]
    sample_blocks: list[str]


# ============================================================
#  PARSER DE My Clippings.txt — ROBUSTO MULTI-IDIOMA
# ============================================================

class ClippingsParser:
    """
    Parser tolerante que NO depende de palabras clave en idiomas concretos.

    Estrategia:
      1. Línea 1: Título (Autor) — formato universal en todos los Kindles.
      2. Línea 2: cualquier línea que contenga un número de ubicación o página.
         Si el bloque tiene metadatos numéricos válidos, lo aceptamos sin
         exigir palabras clave en un idioma concreto.
      3. El "tipo" se infiere por palabras clave conocidas en muchos idiomas;
         si no se reconoce, se asume "highlight" (no se descarta el bloque).
    """

    SEPARATOR = "=========="

    PAGE_KEYWORDS = re.compile(
        r"\b(?:page|p[áa]gina|seite|pagina|p\.)\s+(\d{1,7})",
        re.IGNORECASE,
    )

    TYPE_KEYWORDS = {
        "note": ["note", "nota", "notiz", "anmerkung", "annotation",
                 "メモ", "笔记", "노트"],
        "bookmark": ["bookmark", "marcador", "lesezeichen", "signet",
                     "segnalibro", "ブックマーク", "书签", "북마크"],
        "highlight": ["highlight", "subrayado", "resaltado", "markierung",
                      "surlignement", "evidenziazione", "destacado",
                      "destaque", "ハイライト", "标注", "하이라이트"],
    }

    # Mensaje DRM que el Kindle escribe cuando se supera el límite de subrayado
    DRM_LIMIT_PATTERNS = [
        r"<\s*you\s+have\s+reached\s+the\s+clipping\s+limit\s+for\s+this\s+item\s*>",
        r"<\s*has\s+llegado\s+al\s+l[íi]mite\s+de\s+recortes?\s+para\s+este\s+elemento\s*>",
        r"<\s*vous\s+avez\s+atteint\s+la\s+limite\s+de\s+coupures?",
        r"<\s*sie\s+haben\s+das\s+ausschneidelimit",
    ]
    DRM_LIMIT_RE = re.compile(
        "|".join(DRM_LIMIT_PATTERNS),
        re.IGNORECASE,
    )

    @classmethod
    def _is_drm_limit_message(cls, content: str) -> bool:
        return bool(cls.DRM_LIMIT_RE.search(content.strip()))

    TITLE_AUTHOR_RE = re.compile(r"^(?P<title>.+?)\s*\((?P<author>[^()]+)\)\s*$")

    def parse_file(self, path: Path) -> Iterator[Highlight]:
        for h, _err in self._iter_blocks(path):
            if h is not None:
                yield h

    def diagnose(self, path: Path, max_failures: int = 5,
                 max_samples: int = 3) -> ParseDiagnostic:
        if not path.exists():
            return ParseDiagnostic(
                file_path=str(path), file_size=0, file_encoding="?",
                total_blocks=0, parsed_ok=0, parsed_failed=0,
                failures=[{"reason": f"El archivo no existe: {path}"}],
                sample_blocks=[],
            )

        size = path.stat().st_size
        encoding_used = self._detect_encoding(path)
        text = path.read_text(encoding=encoding_used, errors="replace")
        raw_blocks = [b.strip() for b in text.split(self.SEPARATOR) if b.strip()]

        ok, failed = 0, 0
        failures: list[dict] = []
        for idx, block in enumerate(raw_blocks):
            h, err = self._parse_block_with_reason(block)
            if h is not None:
                ok += 1
            else:
                failed += 1
                if len(failures) < max_failures:
                    failures.append({
                        "block_index": idx,
                        "reason": err,
                        "first_lines": "\n".join(block.splitlines()[:4]),
                    })

        return ParseDiagnostic(
            file_path=str(path),
            file_size=size,
            file_encoding=encoding_used,
            total_blocks=len(raw_blocks),
            parsed_ok=ok,
            parsed_failed=failed,
            failures=failures,
            sample_blocks=raw_blocks[:max_samples],
        )

    @staticmethod
    def _detect_encoding(path: Path) -> str:
        try:
            with path.open("rb") as f:
                head = f.read(4)
            if head.startswith(b"\xff\xfe") or head.startswith(b"\xfe\xff"):
                return "utf-16"
            return "utf-8-sig"
        except OSError:
            return "utf-8"

    def _iter_blocks(self, path: Path) -> Iterator[tuple[Highlight | None, str | None]]:
        encoding = self._detect_encoding(path)
        try:
            text = path.read_text(encoding=encoding, errors="replace")
        except OSError as e:
            raise RuntimeError(f"No se pudo leer {path}: {e}") from e

        for raw_block in text.split(self.SEPARATOR):
            block = raw_block.strip()
            if not block:
                continue
            yield self._parse_block_with_reason(block)

    def _parse_block_with_reason(self, block: str) -> tuple[Highlight | None, str | None]:
        lines = [ln.strip().lstrip("\ufeff") for ln in block.splitlines() if ln.strip()]
        if len(lines) < 2:
            return None, f"Solo {len(lines)} líneas en el bloque (esperaba ≥2)"

        title_line = lines[0]
        m_title = self.TITLE_AUTHOR_RE.match(title_line)
        if m_title:
            title = m_title.group("title").strip()
            author = m_title.group("author").strip()
        else:
            title = title_line
            author = None
        if not title:
            return None, "Línea 1 vacía: sin título"

        meta_line = lines[1]
        h_type = self._infer_type(meta_line)
        loc_start, loc_end = self._extract_location(meta_line)
        page = self._extract_page(meta_line)
        if loc_start is None and page is None:
            return None, (
                "Línea 2 sin ubicación ni página detectada. "
                f"Línea recibida: «{meta_line[:120]}»"
            )
        date = self._extract_date(meta_line)

        content = "\n".join(lines[2:]).strip()

        # Detectar mensaje DRM del Kindle ("Has llegado al límite de recortes")
        # → marcar como tipo especial 'dropped' para poder filtrarlos
        if content and self._is_drm_limit_message(content):
            content = "[DRM: límite de subrayado alcanzado]"
            h_type = "dropped"
        elif not content:
            # Bookmarks legítimos no tienen contenido — los conservamos como tal
            if h_type == "bookmark":
                content = "[marcador de página]"
            else:
                # Subrayado/nota sin contenido: el Kindle no extrajo el texto
                # (suele pasar con imágenes, tablas, pies de página)
                content = "[contenido vacío]"
                h_type = "empty"

        return Highlight(
            book_title=title, author=author, type=h_type, content=content,
            location_start=loc_start, location_end=loc_end, page=page,
            highlighted_at=date,
        ), None

    def _infer_type(self, meta_line: str) -> str:
        lower = meta_line.lower()
        for ttype, keywords in self.TYPE_KEYWORDS.items():
            for kw in keywords:
                if kw.lower() in lower:
                    return ttype
        return "highlight"

    def _extract_location(self, meta_line: str) -> tuple[int | None, int | None]:
        """
        Busca un rango N-M o un número aislado en CUALQUIER parte de la línea
        de metadatos. Antes solo miraba antes del primer '|', lo que fallaba
        con líneas como: "página xxviii | posición 307-309 | Añadido el..."
        donde el primer segmento solo tiene un numeral romano.

        Estrategia: probar segmento a segmento separado por '|', y devolver
        el primer rango/número que parezca una ubicación real (no parte de
        una fecha).
        """
        segments = meta_line.split("|")

        # 1) Preferir un rango N-M en cualquier segmento
        for seg in segments:
            range_match = re.search(
                r"(?<!\d)(\d{1,7})\s*[-–—]\s*(\d{1,7})(?!\d)",
                seg,
            )
            if range_match:
                try:
                    return int(range_match.group(1)), int(range_match.group(2))
                except ValueError:
                    continue

        # 2) Si no hay rango, buscar número aislado en segmentos que no parezcan fecha
        for seg in segments:
            # Saltar segmentos que claramente son fechas (tienen mes en texto o
            # patrones de hora hh:mm:ss)
            if re.search(r"\b(?:enero|febrero|marzo|abril|mayo|junio|julio|"
                         r"agosto|septiembre|octubre|noviembre|diciembre|"
                         r"january|february|march|april|may|june|july|august|"
                         r"september|october|november|december|"
                         r"januar|februar|märz|april|mai|juni|juli|august|"
                         r"september|oktober|november|dezember|"
                         r"janvier|février|mars|avril|mai|juin|juillet|août|"
                         r"septembre|octobre|novembre|décembre)\b",
                         seg, re.IGNORECASE):
                continue
            if re.search(r"\d{1,2}:\d{2}:\d{2}", seg):
                continue
            for m in re.finditer(r"(?<!\d)(\d{1,7})(?!\d)", seg):
                n = int(m.group(1))
                # Filtrar años que pudieran haberse colado
                if 1900 <= n <= 2099 and len(seg) < 25:
                    continue
                return n, None

        return None, None

    def _extract_page(self, meta_line: str) -> int | None:
        m = self.PAGE_KEYWORDS.search(meta_line)
        if m:
            try:
                return int(m.group(1))
            except ValueError:
                pass
        return None

    def _extract_date(self, meta_line: str) -> str | None:
        if "|" in meta_line:
            raw = meta_line.rsplit("|", 1)[1].strip()
        else:
            raw = meta_line.strip()
        raw = re.sub(
            r"^(?:added\s+on|a[ñn]adido\s+el|ajout[ée]\s+le|hinzugef[uü]gt\s+am|"
            r"aggiunto\s+il|adicionado\s+em|toegevoegd\s+op)\s+",
            "", raw, flags=re.IGNORECASE,
        ).strip()
        formats = [
            "%A, %d %B %Y %H:%M:%S",
            "%A, %B %d, %Y %I:%M:%S %p",
            "%A, %B %d, %Y %H:%M:%S",
            "%A, %d de %B de %Y %H:%M:%S",
            "%A, %d. %B %Y %H:%M:%S",
            "%A %d %B %Y %H:%M:%S",
            "%d %B %Y %H:%M:%S",
            "%Y-%m-%d %H:%M:%S",
        ]
        for fmt in formats:
            try:
                return datetime.strptime(raw, fmt).isoformat()
            except ValueError:
                continue
        return raw or None


# ============================================================
#  LECTOR DE vocab.db
# ============================================================

class VocabReader:
    QUERY = """
        SELECT
            w.word                                       AS word,
            w.stem                                       AS stem,
            w.lang                                       AS language,
            l.usage                                      AS context,
            b.title                                      AS book_title,
            datetime(l.timestamp/1000, 'unixepoch')      AS looked_up_at
        FROM LOOKUPS  l
        JOIN WORDS    w ON l.word_key = w.id
        LEFT JOIN BOOK_INFO b ON l.book_key = b.id
        ORDER BY l.timestamp DESC;
    """

    def read(self, db_path: Path) -> list[VocabEntry]:
        uri = f"file:{db_path}?mode=ro"
        with sqlite3.connect(uri, uri=True) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(self.QUERY).fetchall()
        return [VocabEntry(**dict(r)) for r in rows]


# ============================================================
#  PERSISTENCIA LOCAL
# ============================================================

class LocalStore:
    SCHEMA = """
    CREATE TABLE IF NOT EXISTS books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        author TEXT,
        language TEXT,
        cover_url TEXT
    );
    -- UNIQUE en SQL no diferencia NULL=NULL, así que usamos un índice
    -- único sobre las versiones normalizadas para evitar duplicados por
    -- diferencias en mayúsculas/espacios, y tratamos NULL como ''.
    CREATE UNIQUE INDEX IF NOT EXISTS ux_books_norm
        ON books(LOWER(TRIM(title)), LOWER(TRIM(COALESCE(author, ''))));
    CREATE TABLE IF NOT EXISTS highlights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL REFERENCES books(id),
        type TEXT,
        content TEXT NOT NULL,
        location_start INTEGER,
        location_end INTEGER,
        page INTEGER,
        highlighted_at TEXT,
        hash TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vocabulary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        word TEXT NOT NULL,
        stem TEXT,
        language TEXT,
        context TEXT,
        book_title TEXT,
        looked_up_at TEXT,
        UNIQUE(word, context)
    );
    CREATE INDEX IF NOT EXISTS idx_h_book ON highlights(book_id);
    CREATE INDEX IF NOT EXISTS idx_b_lang ON books(language);
    CREATE INDEX IF NOT EXISTS idx_v_lang ON vocabulary(language);
    """

    MIGRATIONS = [
        "ALTER TABLE highlights ADD COLUMN page INTEGER",
        "ALTER TABLE books ADD COLUMN cover_url TEXT",
    ]

    def __init__(self, path: Path):
        self.path = path
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.executescript(self.SCHEMA)
        for stmt in self.MIGRATIONS:
            try:
                self.conn.execute(stmt)
                self.conn.commit()
            except sqlite3.OperationalError:
                pass

    def upsert_book(self, title: str, author: str | None, language: str | None = None) -> int:
        """
        Inserta o devuelve un libro existente, tratando títulos como iguales
        si solo difieren en mayúsculas/minúsculas o espacios al final.
        """
        # Normalización robusta: trim, colapsar espacios internos
        norm_title = " ".join(title.strip().split()) if title else ""
        norm_author = " ".join(author.strip().split()) if author else None

        # Buscar primero por normalizado
        cur = self.conn.execute(
            "SELECT id FROM books "
            "WHERE LOWER(TRIM(title)) = LOWER(?) "
            "  AND LOWER(TRIM(COALESCE(author, ''))) = LOWER(COALESCE(?, '')) "
            "LIMIT 1;",
            (norm_title, norm_author),
        )
        row = cur.fetchone()
        if row:
            book_id = row[0]
            # Actualizar idioma si llega uno y antes era NULL
            if language:
                self.conn.execute(
                    "UPDATE books SET language = COALESCE(language, ?) WHERE id = ?;",
                    (language, book_id),
                )
            return book_id

        # Crear nuevo
        cur = self.conn.execute(
            "INSERT INTO books(title, author, language) VALUES (?,?,?) RETURNING id;",
            (norm_title, norm_author, language),
        )
        return cur.fetchone()[0]

    def merge_duplicate_books(self) -> int:
        """
        Detecta y fusiona libros duplicados que ya existen en la BD por
        diferencias de mayúsculas/espacios. Devuelve cuántos se fusionaron.
        Útil tras una migración desde una BD antigua.
        """
        rows = self.conn.execute("""
            SELECT id, title, author FROM books
            ORDER BY id;
        """).fetchall()

        # Agrupar por clave normalizada
        groups: dict[tuple[str, str], list[int]] = {}
        for bid, title, author in rows:
            key = (
                " ".join((title or "").strip().split()).lower(),
                " ".join((author or "").strip().split()).lower(),
            )
            groups.setdefault(key, []).append(bid)

        merged = 0
        for ids in groups.values():
            if len(ids) <= 1:
                continue
            keeper, *rest = ids
            for dup_id in rest:
                # Reapuntar highlights al libro canónico
                self.conn.execute(
                    "UPDATE highlights SET book_id = ? WHERE book_id = ?;",
                    (keeper, dup_id),
                )
                self.conn.execute("DELETE FROM books WHERE id = ?;", (dup_id,))
                merged += 1
        self.conn.commit()
        return merged

    def insert_highlights(self, items: list[Highlight]) -> tuple[int, int]:
        new, dup = 0, 0
        for h in items:
            book_id = self.upsert_book(h.book_title, h.author, h.language)
            try:
                self.conn.execute(
                    "INSERT INTO highlights(book_id, type, content, location_start, "
                    "location_end, page, highlighted_at, hash) VALUES (?,?,?,?,?,?,?,?);",
                    (book_id, h.type, h.content, h.location_start,
                     h.location_end, h.page, h.highlighted_at, h.hash()),
                )
                new += 1
            except sqlite3.IntegrityError:
                dup += 1
        self.conn.commit()
        return new, dup

    def insert_vocab(self, items: list[VocabEntry]) -> int:
        n = 0
        for v in items:
            try:
                self.conn.execute(
                    "INSERT INTO vocabulary(word, stem, language, context, "
                    "book_title, looked_up_at) VALUES (?,?,?,?,?,?);",
                    (v.word, v.stem, v.language, v.context, v.book_title, v.looked_up_at),
                )
                n += 1
            except sqlite3.IntegrityError:
                pass
        self.conn.commit()
        return n

    def stats(self) -> dict:
        c = self.conn.execute
        total_h = c("SELECT COUNT(*) FROM highlights").fetchone()[0]
        useful_h = c("SELECT COUNT(*) FROM highlights WHERE type IN ('highlight', 'note')").fetchone()[0]
        return {
            "books": c("SELECT COUNT(*) FROM books").fetchone()[0],
            "highlights": useful_h,
            "highlights_total": total_h,
            "vocab": c("SELECT COUNT(*) FROM vocabulary").fetchone()[0],
        }

    def list_books(self) -> list[dict]:
        rows = self.conn.execute("""
            SELECT b.id, b.title, b.author, b.language, b.cover_url,
                   COUNT(h.id) AS total_count,
                   SUM(CASE WHEN h.type IN ('highlight', 'note') THEN 1 ELSE 0 END) AS useful_count
            FROM books b
            LEFT JOIN highlights h ON h.book_id = b.id
            GROUP BY b.id
            ORDER BY b.title COLLATE NOCASE;
        """).fetchall()
        return [
            {"id": r[0], "title": r[1], "author": r[2],
             "language": r[3], "cover_url": r[4],
             "highlights_count": r[6] or 0,  # útiles (highlight + note)
             "total_count": r[5] or 0}       # incluye bookmarks/empty/dropped
            for r in rows
        ]

    def set_book_cover(self, book_id: int, cover_url: str | None) -> None:
        self.conn.execute(
            "UPDATE books SET cover_url = ? WHERE id = ?;",
            (cover_url, book_id),
        )
        self.conn.commit()

    def books_without_cover(self) -> list[dict]:
        rows = self.conn.execute("""
            SELECT id, title, author FROM books
            WHERE cover_url IS NULL OR cover_url = ''
            ORDER BY id;
        """).fetchall()
        return [{"id": r[0], "title": r[1], "author": r[2]} for r in rows]

    def list_languages(self) -> list[dict]:
        rows = self.conn.execute("""
            SELECT COALESCE(language, '?') AS lang, COUNT(*) AS n
            FROM books GROUP BY lang ORDER BY n DESC;
        """).fetchall()
        return [{"lang": r[0], "count": r[1]} for r in rows]

    def filter_highlights(
        self,
        book_ids: list[int] | None = None,
        languages: list[str] | None = None,
        search: str | None = None,
        types: list[str] | None = None,
    ) -> list[dict]:
        sql = """
            SELECT h.id, h.content, h.type, h.location_start, h.location_end,
                   h.page, h.highlighted_at, b.id AS book_id, b.title, b.author,
                   b.language
            FROM highlights h
            JOIN books b ON b.id = h.book_id
            WHERE 1=1
        """
        params: list = []
        if languages:
            sql += f" AND b.language IN ({','.join('?' * len(languages))})"
            params.extend(languages)
        if book_ids:
            sql += f" AND b.id IN ({','.join('?' * len(book_ids))})"
            params.extend(book_ids)
        if types:
            sql += f" AND h.type IN ({','.join('?' * len(types))})"
            params.extend(types)
        if search:
            sql += " AND h.content LIKE ?"
            params.append(f"%{search}%")
        sql += " ORDER BY b.title COLLATE NOCASE, h.location_start;"

        cols = ["id", "content", "type", "location_start", "location_end",
                "page", "highlighted_at", "book_id", "title", "author", "language"]
        return [dict(zip(cols, row)) for row in self.conn.execute(sql, params)]

    def filter_vocab(
        self,
        languages: list[str] | None = None,
        book_titles: list[str] | None = None,
        search: str | None = None,
    ) -> list[dict]:
        sql = """
            SELECT id, word, stem, language, context, book_title, looked_up_at
            FROM vocabulary WHERE 1=1
        """
        params: list = []
        if languages:
            sql += f" AND language IN ({','.join('?' * len(languages))})"
            params.extend(languages)
        if book_titles:
            sql += f" AND book_title IN ({','.join('?' * len(book_titles))})"
            params.extend(book_titles)
        if search:
            sql += " AND (word LIKE ? OR context LIKE ?)"
            params.extend([f"%{search}%", f"%{search}%"])
        sql += " ORDER BY looked_up_at DESC;"
        cols = ["id", "word", "stem", "language", "context", "book_title", "looked_up_at"]
        return [dict(zip(cols, row)) for row in self.conn.execute(sql, params)]


# ============================================================
#  EXPORTADOR
# ============================================================

@dataclass
class ExportOptions:
    include_book_title: bool = True
    include_author: bool = True
    include_language: bool = True
    include_location: bool = True
    include_date: bool = True
    include_type: bool = True
    include_context: bool = True
    include_word_language: bool = True
    include_source_book: bool = True
    include_lookup_date: bool = True
    group_by_book: bool = True
    include_front_matter: bool = True
    include_main_heading: bool = True

    @classmethod
    def text_only(cls) -> "ExportOptions":
        return cls(
            include_book_title=False, include_author=False, include_language=False,
            include_location=False, include_date=False, include_type=False,
            include_context=False, include_word_language=False,
            include_source_book=False, include_lookup_date=False,
            group_by_book=False, include_front_matter=False,
            include_main_heading=False,
        )


class Exporter:
    def highlights_to_markdown(self, highlights: list[dict], opts: ExportOptions) -> str:
        lines: list[str] = []
        if opts.include_front_matter:
            lines.append("---")
            lines.append("source: KindleVault")
            lines.append(f"generated: {datetime.now().isoformat(timespec='seconds')}")
            lines.append(f"highlights: {len(highlights)}")
            lines.append("---\n")
        if opts.include_main_heading:
            lines.append("# Mis subrayados de Kindle\n")

        if opts.group_by_book:
            by_book: dict[str, list[dict]] = {}
            for h in highlights:
                by_book.setdefault(h["title"], []).append(h)
            for title, items in sorted(by_book.items()):
                if opts.include_book_title:
                    lines.append(f"## {title}")
                    sub = []
                    if opts.include_author and items[0].get("author"):
                        sub.append(f"*{items[0]['author']}*")
                    if opts.include_language and items[0].get("language"):
                        sub.append(f"`lang:{items[0]['language']}`")
                    sub.append(f"{len(items)} subrayados")
                    lines.append(" · ".join(sub) + "\n")
                for h in items:
                    lines.append(self._format_highlight_md(h, opts))
                lines.append("---\n")
        else:
            for h in highlights:
                lines.append(self._format_highlight_md(h, opts))
        return "\n".join(lines).strip() + "\n"

    def _format_highlight_md(self, h: dict, opts: ExportOptions) -> str:
        out: list[str] = []
        if h["type"] == "note":
            content_line = f"**Nota:** {h['content']}" if opts.include_type else h["content"]
        else:
            content_line = f"> {h['content']}"
        out.append(content_line)
        meta_parts: list[str] = []
        if opts.include_location:
            if h.get("location_start"):
                loc = f"loc. {h['location_start']}"
                if h.get("location_end") and h["location_end"] != h["location_start"]:
                    loc += f"–{h['location_end']}"
                meta_parts.append(loc)
            elif h.get("page"):
                meta_parts.append(f"pág. {h['page']}")
        if opts.include_date and h.get("highlighted_at"):
            meta_parts.append(h["highlighted_at"])
        if meta_parts:
            out.append(f"\n<sub>{' · '.join(meta_parts)}</sub>")
        out.append("")
        return "\n".join(out)

    def vocab_to_markdown(self, vocab: list[dict], opts: ExportOptions) -> str:
        lines: list[str] = []
        if opts.include_front_matter:
            lines.append("---")
            lines.append("source: KindleVault")
            lines.append(f"generated: {datetime.now().isoformat(timespec='seconds')}")
            lines.append(f"words: {len(vocab)}")
            lines.append("---\n")
        if opts.include_main_heading:
            lines.append("# Vocabulario buscado\n")
        for v in vocab:
            line = f"- **{v['word']}**"
            if opts.include_word_language and v.get("language"):
                line += f" `{v['language']}`"
            lines.append(line)
            if opts.include_context and v.get("context"):
                lines.append(f"  > {v['context']}")
            sub: list[str] = []
            if opts.include_source_book and v.get("book_title"):
                sub.append(f"de *{v['book_title']}*")
            if opts.include_lookup_date and v.get("looked_up_at"):
                sub.append(v["looked_up_at"])
            if sub:
                lines.append(f"  <sub>{' · '.join(sub)}</sub>")
            lines.append("")
        return "\n".join(lines).strip() + "\n"

    def highlights_to_txt(self, highlights: list[dict], opts: ExportOptions) -> str:
        out: list[str] = []
        for h in highlights:
            out.append(h["content"])
            metas: list[str] = []
            if opts.include_book_title:
                metas.append(h["title"])
            if opts.include_author and h.get("author"):
                metas.append(h["author"])
            if opts.include_location:
                if h.get("location_start"):
                    metas.append(f"loc. {h['location_start']}")
                elif h.get("page"):
                    metas.append(f"pág. {h['page']}")
            if metas:
                out.append(f"  — {' · '.join(metas)}")
            out.append("")
        return "\n".join(out).strip() + "\n"

    def vocab_to_txt(self, vocab: list[dict], opts: ExportOptions) -> str:
        out: list[str] = []
        for v in vocab:
            line = v["word"]
            if opts.include_context and v.get("context"):
                line += f"\n  {v['context']}"
            metas: list[str] = []
            if opts.include_word_language and v.get("language"):
                metas.append(v["language"])
            if opts.include_source_book and v.get("book_title"):
                metas.append(v["book_title"])
            if metas:
                line += f"\n  — {' · '.join(metas)}"
            out.append(line)
            out.append("")
        return "\n".join(out).strip() + "\n"

    def highlights_to_csv(self, highlights: list[dict], opts: ExportOptions) -> str:
        import csv
        from io import StringIO
        cols: list[tuple[str, str]] = [("content", "content")]
        if opts.include_book_title: cols.append(("title", "book"))
        if opts.include_author: cols.append(("author", "author"))
        if opts.include_language: cols.append(("language", "language"))
        if opts.include_type: cols.append(("type", "type"))
        if opts.include_location:
            cols.append(("location_start", "loc_start"))
            cols.append(("location_end", "loc_end"))
            cols.append(("page", "page"))
        if opts.include_date: cols.append(("highlighted_at", "date"))
        buf = StringIO()
        writer = csv.writer(buf)
        writer.writerow([label for _, label in cols])
        for h in highlights:
            writer.writerow([h.get(key, "") or "" for key, _ in cols])
        return buf.getvalue()

    def vocab_to_csv(self, vocab: list[dict], opts: ExportOptions) -> str:
        import csv
        from io import StringIO
        cols: list[tuple[str, str]] = [("word", "word")]
        if opts.include_context: cols.append(("context", "context"))
        if opts.include_word_language: cols.append(("language", "language"))
        if opts.include_source_book: cols.append(("book_title", "book"))
        if opts.include_lookup_date: cols.append(("looked_up_at", "date"))
        buf = StringIO()
        writer = csv.writer(buf)
        writer.writerow([label for _, label in cols])
        for v in vocab:
            writer.writerow([v.get(key, "") or "" for key, _ in cols])
        return buf.getvalue()

    def highlights_to_json(self, highlights: list[dict], opts: ExportOptions) -> str:
        return json.dumps(
            [self._filter_dict_h(h, opts) for h in highlights],
            ensure_ascii=False, indent=2,
        )

    def vocab_to_json(self, vocab: list[dict], opts: ExportOptions) -> str:
        return json.dumps(
            [self._filter_dict_v(v, opts) for v in vocab],
            ensure_ascii=False, indent=2,
        )

    @staticmethod
    def _filter_dict_h(h: dict, opts: ExportOptions) -> dict:
        keep = {"content": h["content"]}
        if opts.include_book_title: keep["book"] = h.get("title")
        if opts.include_author: keep["author"] = h.get("author")
        if opts.include_language: keep["language"] = h.get("language")
        if opts.include_type: keep["type"] = h.get("type")
        if opts.include_location:
            keep["location_start"] = h.get("location_start")
            keep["location_end"] = h.get("location_end")
            keep["page"] = h.get("page")
        if opts.include_date: keep["date"] = h.get("highlighted_at")
        return keep

    @staticmethod
    def _filter_dict_v(v: dict, opts: ExportOptions) -> dict:
        keep = {"word": v["word"]}
        if opts.include_context: keep["context"] = v.get("context")
        if opts.include_word_language: keep["language"] = v.get("language")
        if opts.include_source_book: keep["book"] = v.get("book_title")
        if opts.include_lookup_date: keep["date"] = v.get("looked_up_at")
        return keep
