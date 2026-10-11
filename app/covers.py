"""
Cliente para la API pública de OpenLibrary.

Busca portadas de libros sin necesidad de API key.
Endpoint usado: https://openlibrary.org/search.json?q=<query>&limit=1
Imagen de portada: https://covers.openlibrary.org/b/id/<cover_id>-M.jpg
"""
from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from typing import Optional


OPENLIBRARY_SEARCH = "https://openlibrary.org/search.json"
COVERS_URL = "https://covers.openlibrary.org/b/id/{cover_id}-M.jpg"
TIMEOUT = 6  # segundos


def _clean_title(title: str) -> str:
    """Limpia un título para mejorar el matching en OpenLibrary."""
    # Quitar paréntesis con metadatos comunes (Spanish Edition, Kindle Edition, etc.)
    cleaned = re.sub(
        r"\s*\((?:[^()]*(?:edition|edición|spanish|english|french|"
        r"deutsch|kindle|paperback|hardcover|illustrated|nº\s*\d+|"
        r"volume\s*\d+|book\s*\d+)[^()]*)\)",
        "",
        title,
        flags=re.IGNORECASE,
    )
    # Quitar subtítulo tras ":" si el título es largo
    if len(cleaned) > 50 and ":" in cleaned:
        cleaned = cleaned.split(":", 1)[0]
    return cleaned.strip()


def _clean_author(author: str | None) -> str | None:
    """Convierte 'Apellido, Nombre' en 'Nombre Apellido' (mejor matching)."""
    if not author:
        return None
    a = author.strip()
    if "," in a:
        parts = [p.strip() for p in a.split(",", 1)]
        if len(parts) == 2:
            return f"{parts[1]} {parts[0]}"
    return a


def find_cover(title: str, author: str | None = None) -> Optional[str]:
    """
    Devuelve la URL de la portada o None si no se encuentra.

    Hace una sola petición HTTP (timeout 6s) y devuelve la URL del primer
    resultado con cover_i. No lanza excepciones — devuelve None si algo falla.
    """
    if not title:
        return None

    clean_title = _clean_title(title)
    clean_author = _clean_author(author)

    # Construir query
    query_parts = [f'title:"{clean_title}"']
    if clean_author:
        query_parts.append(f'author:"{clean_author}"')
    query = " ".join(query_parts)

    url = f"{OPENLIBRARY_SEARCH}?{urllib.parse.urlencode({'q': query, 'limit': 3})}"

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "KindleVault/1.0 (personal use)"},
        )
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None

    docs = data.get("docs", [])
    for doc in docs:
        cover_id = doc.get("cover_i")
        if cover_id:
            return COVERS_URL.format(cover_id=cover_id)

    # Reintento sin author si no hubo match (a veces ayuda)
    if clean_author and not docs:
        return find_cover(title, None)
    return None
