@echo off
setlocal
cd /d "%~dp0"

set "MODEL_NAME=Llama-3.2-3B-Instruct-Q4_0.gguf"
set "MODEL_DIR=%CD%\models"
set "MODEL_PATH=%MODEL_DIR%\%MODEL_NAME%"
set "MODEL_RELEASE_REPOSITORY=WKeong001/VIRTUAL-PERSONAL-ASSISTANT"

where py >nul 2>&1
if errorlevel 1 (
    echo Python 3.10, 3.11, or 3.12 is required.
    echo Install it from https://www.python.org/downloads/windows/ and select "Add Python to PATH".
    pause
    exit /b 1
)

set "PYTHON_COMMAND="
for %%V in (3.12 3.11 3.10) do (
    if not defined PYTHON_COMMAND (
        py -%%V -c "import sys" >nul 2>&1
        if not errorlevel 1 set "PYTHON_COMMAND=py -%%V"
    )
)

if not defined PYTHON_COMMAND (
    echo Python 3.10, 3.11, or 3.12 is required.
    echo Install a supported Python version, then run this file again.
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo Creating the Python environment...
    %PYTHON_COMMAND% -m venv .venv
    if errorlevel 1 (
        echo Failed to create the Python environment.
        pause
        exit /b 1
    )
)

echo Installing Python dependencies...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 (
    echo Failed to update pip.
    pause
    exit /b 1
)
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
    echo Failed to install the Python dependencies.
    pause
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js 18 or newer is required.
    echo Install the current LTS version from https://nodejs.org/ and run this file again.
    pause
    exit /b 1
)

if not exist "node_modules\express" (
    echo Installing web dependencies...
    call npm ci
    if errorlevel 1 (
        echo Failed to install the web dependencies.
        pause
        exit /b 1
    )
)

if not exist "%MODEL_DIR%" mkdir "%MODEL_DIR%"
if not exist "%MODEL_PATH%" (
    echo Downloading the AI model from the latest GitHub Release...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $repo = '%MODEL_RELEASE_REPOSITORY%'; $modelName = '%MODEL_NAME%'; $destination = Join-Path (Get-Location) ('models\' + $modelName); $release = Invoke-RestMethod -Headers @{ 'User-Agent' = 'Ops-Transcriber-Setup' } -Uri ('https://api.github.com/repos/' + $repo + '/releases/latest'); $asset = @($release.assets) | Where-Object { $_.name -eq $modelName } | Select-Object -First 1; if (-not $asset) { throw ('The latest release does not contain ' + $modelName + '. Ask the project owner to attach that file to the release.') }; $temporary = $destination + '.download'; Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = 'Ops-Transcriber-Setup' } -Uri $asset.browser_download_url -OutFile $temporary; Move-Item -Force $temporary $destination"
    if errorlevel 1 (
        echo Failed to download the AI model. Check the internet connection and that the latest GitHub Release includes %MODEL_NAME%.
        pause
        exit /b 1
    )
)

echo Setup complete.
exit /b 0
