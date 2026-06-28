@echo off
title City Rent Barka — Serveur
echo.
echo  Demarrage de City Rent Barka...
echo.

:: ── Vérifier Node.js ────────────────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERREUR : Node.js n'est pas installe !
    echo.
    echo  Telecharge Node.js sur : https://nodejs.org
    echo  Choisis la version LTS et installe-la.
    echo  Puis relance ce fichier.
    echo.
    pause
    exit /b 1
)

:: ── Aller dans le dossier du bat ────────────────────────────────────────
cd /d "%~dp0"

:: ── Vérifier si better-sqlite3 est installé ─────────────────────────────
if not exist "node_modules\better-sqlite3\build\Release\better_sqlite3.node" (
    echo  Installation de better-sqlite3 ^(premiere fois uniquement^)...
    echo  Cela peut prendre 1-2 minutes. Ne ferme pas cette fenetre.
    echo.
    call npm install better-sqlite3 --save-exact 2>&1
    if %errorlevel% neq 0 (
        echo.
        echo  ERREUR lors de l'installation de better-sqlite3.
        echo.
        echo  Solutions possibles :
        echo  1. Assure-toi d'etre connecte a internet
        echo  2. Telecharge et installe "Build Tools for Visual Studio" :
        echo     https://visualstudio.microsoft.com/visual-cpp-build-tools/
        echo     ^(Coche "C++ build tools" lors de l'installation^)
        echo  3. Ou contacte le support technique.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo  Installation terminee !
    echo.
)

:: ── Lancer le serveur ────────────────────────────────────────────────────
echo  Serveur en cours de demarrage...
echo.
node "%~dp0server.js"

echo.
echo  Le serveur s'est arrete.
pause
