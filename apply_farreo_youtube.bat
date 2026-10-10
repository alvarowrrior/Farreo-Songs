@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel% equ 0 (
  py "%~dp0apply_farreo_youtube.py" "%~dp0"
) else (
  python "%~dp0apply_farreo_youtube.py" "%~dp0"
)
echo.
echo Review your Git diff before committing.
pause
