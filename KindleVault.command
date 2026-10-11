#!/bin/bash
# Launcher para macOS y Linux.
# Doble clic en macOS Finder; en Linux, asegurar que sea ejecutable: chmod +x KindleVault.command

cd "$(dirname "$0")" || exit 1

# Detectar Python 3
PYTHON=""
for cmd in python3 python; do
    if command -v "$cmd" >/dev/null 2>&1; then
        # Verificar que es Python 3.10+
        if "$cmd" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
            PYTHON="$cmd"
            break
        fi
    fi
done

if [ -z "$PYTHON" ]; then
    echo
    echo "  Necesitas Python 3.10 o superior."
    echo
    echo "  En macOS:"
    echo "    brew install python3"
    echo "    o descarga desde https://www.python.org/downloads/"
    echo
    echo "  En Linux (Ubuntu/Debian):"
    echo "    sudo apt install python3"
    echo
    read -p "  Pulsa Enter para cerrar..."
    exit 1
fi

"$PYTHON" run.py
