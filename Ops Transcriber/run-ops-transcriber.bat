@echo off
setlocal
cd /d "%~dp0"

set "STT_APP_DIR=%CD%"
set "STT_INPUT_DIR=%CD%\Transcribed Text Files"
set "STT_AUDIO_DIR_1=%CD%\Input Audio\Channel 1"
set "STT_AUDIO_DIR_2=%CD%\Input Audio\Channel 2"
set "STT_LOGS_DIR=%CD%\Log Assistant"
set "DB_DIR=%CD%\Data"
set "UPLOADS_DIR=%CD%\Data\uploads"
set "STT_STANDALONE=1"
set "STT_AI_URL=http://127.0.0.1:8756"
set "AI_SERVICE_HOST=127.0.0.1"
set "AI_SERVICE_PORT=8756"
set "PORT=3011"
set "HOST=127.0.0.1"
set "MODEL_PATH=%CD%\models\Llama-3.2-3B-Instruct-Q4_0.gguf"

if exist "%CD%\AI Logs" if not exist "%STT_LOGS_DIR%" move "%CD%\AI Logs" "%STT_LOGS_DIR%" >nul

for %%D in ("%STT_INPUT_DIR%" "%STT_AUDIO_DIR_1%" "%STT_AUDIO_DIR_2%" "%STT_LOGS_DIR%" "%DB_DIR%" "%UPLOADS_DIR%") do (
    if not exist "%%~D" mkdir "%%~D"
)

if not exist ".venv\Scripts\python.exe" goto :setup
if not exist "node_modules\express" goto :setup
if not exist "%MODEL_PATH%" goto :setup
goto :launch

:setup
echo Running first-time setup. This is needed only once.
call setup.bat
if errorlevel 1 exit /b 1

:launch

start "Ops Transcriber AI" /min "%CD%\.venv\Scripts\python.exe" "%CD%\ai_service.py"
start "Ops Transcriber" /min node.exe "%CD%\server.js"

for /L %%I in (1,1,15) do (
    powershell.exe -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3011/' -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 goto :open_browser
    timeout /t 1 /nobreak >nul
)

echo The Ops Transcriber web server did not start. Check the Ops Transcriber command window for errors.
pause
exit /b 1

:open_browser
start "" "http://127.0.0.1:3011/"

endlocal
