@echo off
setlocal enabledelayedexpansion

rem Build Object Spy end to end: install deps, bump the build number,
rem compile TypeScript, and package a single .vsix. Run from anywhere -
rem it changes to its own folder first.
cd /d "%~dp0"

echo ============================================
echo  Object Spy for Playwright -- build
echo ============================================

echo.
echo [1/4] Installing dependencies (npm install)...
call npm install
if errorlevel 1 goto :fail

echo.
echo [2/4] Bumping build number...
call node scripts\bump-version.js
if errorlevel 1 goto :fail

echo.
echo [3/4] Compiling TypeScript...
call npm run compile
if errorlevel 1 goto :fail

echo.
echo [4/4] Packaging extension (vsce package)...
del /q *.vsix >nul 2>&1
call npx vsce package
if errorlevel 1 goto :fail

echo.
echo ============================================
echo  Build succeeded.
echo ============================================
for %%F in (*.vsix) do echo  Output: %%F
exit /b 0

:fail
echo.
echo ============================================
echo  BUILD FAILED -- see the output above.
echo ============================================
exit /b 1
