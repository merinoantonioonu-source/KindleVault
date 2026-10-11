"""KindleVault — punto de entrada."""
import sys
from pathlib import Path

# Permitir ejecución desde el directorio del zip
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.server import serve_forever


def main() -> None:
    if sys.version_info < (3, 10):
        print("Necesitas Python 3.10 o superior.")
        print(f"Versión detectada: {sys.version}")
        input("Pulsa Enter para cerrar...")
        sys.exit(1)

    print(r"""
   _  ___           _ _      __     __         _ _
  | |/ (_)_ __   __| | | ___ \ \   / /_ _ _   _| | |_
  | ' /| | '_ \ / _` | |/ _ \ \ \ / / _` | | | | | __|
  | . \| | | | | (_| | |  __/  \ V / (_| | |_| | | |_
  |_|\_\_|_| |_|\__,_|_|\___|   \_/ \__,_|\__,_|_|\__|
""")
    try:
        serve_forever()
    except OSError as e:
        if "Address already in use" in str(e) or e.errno in (48, 98, 10048):
            print("\nEl puerto 5173 ya está en uso. ¿Tienes otra instancia abierta?")
        else:
            raise
        input("Pulsa Enter para cerrar...")
        sys.exit(1)


if __name__ == "__main__":
    main()
