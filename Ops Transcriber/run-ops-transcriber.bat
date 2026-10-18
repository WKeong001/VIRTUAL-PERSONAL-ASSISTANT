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
set "AI_VISION_URL=http://127.0.0.1:11434"
set "AI_VISION_MODEL=qwen2.5vl:3b"
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

set "OLLAMA_EXE="
where ollama >nul 2>&1
if not errorlevel 1 set "OLLAMA_EXE=ollama"
if not defined OLLAMA_EXE if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
if not defined OLLAMA_EXE if exist "%ProgramFiles%\Ollama\ollama.exe" set "OLLAMA_EXE=%ProgramFiles%\Ollama\ollama.exe"
if not defined OLLAMA_EXE (
    echo [Vision Q^&A] Ollama is not installed. Text-only features will still work.
    echo [Vision Q^&A] Install it from https://ollama.com/download/windows to enable image and diagram questions.
) else (
    "%OLLAMA_EXE%" show "%AI_VISION_MODEL%" >nul 2>&1
    if errorlevel 1 (
        echo Downloading local vision model %AI_VISION_MODEL%. This is needed once and may take several minutes...
        "%OLLAMA_EXE%" pull "%AI_VISION_MODEL%"
        if errorlevel 1 (
            echo [Vision Q^&A] Could not download %AI_VISION_MODEL%. Text-only features will still work.
        )
    )
)

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
