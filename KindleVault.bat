@echo off
title KindleVault
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo  Python no esta instalado.
    echo.
    echo  Pasos:
    echo  1. Descarga Python 3 desde https://www.python.org/downloads/
    echo  2. IMPORTANTE: marca la casilla "Add Python to PATH" durante la instalacion.
    echo  3. Vuelve a hacer doble clic en este archivo.
    echo.
    pause
    exit /b 1
)

python run.py
if %errorlevel% neq 0 (
    echo.
    echo  Algo fallo. Mira el mensaje de arriba.
    pause
)
